# StableRails — Plan Corrections & Hardening (v1)

> Errata + hardening for `docs/IMPLEMENTATION_PLAN.md`, from two independent reviews: a senior in-conversation review and an **independent adversarial red-team by a different model family** (Sakana Fugu Ultra). **Where an item conflicts with the plan, this document wins.** Items are triaged, not applied blindly — some are must-fix bugs, some refine an already-good design, some are facts to verify, some are review errors *not* to apply, and some are owner decisions.
>
> **Provenance:** `[both]` = independently found by both reviews (**highest confidence**) · `[fugu]` = new from the red-team · `[review]` = from the in-conversation review.
>
> **Timing:** feature code does not exist yet (scaffold only). These are corrections to the **spec** — they get baked in as each layer is built, starting with the relayer.

---

## A. MUST-FIX (Critical)

### A1. `release()` must not accept an arbitrary recipient · `[both]` → contract (C1/C2)
- **Problem:** `release(payoutId, to)` with an operator-supplied `to` lets a stolen `OPERATOR_ROLE` key drain the whole escrow to any address — directly contradicting the plan's own T1 claim.
- **Fix:** Remove the arbitrary `to` from operator paths. Use `releaseToTreasury(payoutId)` that sends only to an **immutable/timelocked settlement treasury** set by a separate `ADMIN_ROLE`; or constrain `to` on-chain to the payout's **recorded** party. Operator can *trigger*, never *redirect*.

### A2. Provider-operation journal (outbox) for every external side-effecting call · `[fugu]` → relayer / PIX / CCTP
- **Problem:** If the worker crashes **after** OpenPix accepts the `POST` (or after a CCTP submit) but **before** the DB commit, a retry blind-calls `POST` again → duplicate PIX / duplicate submit.
- **Fix:** Before any external state-changing call, commit an outbox row `pix_operations(payout_id, correlation_id, phase, status='unknown')` in its own tx. On retry, if an `unknown` op exists, the worker **MUST** `GET /payment/{correlationID}` (or read chain state for CCTP) to prove the provider's state **before** ever re-POSTing. This is the off-chain twin of *journal-before-broadcast*.

### A3. Postgres-backed nonce allocator (not BullMQ concurrency) · `[both]` → relayer (R2/R3)
- **Problem:** `concurrency=1` + in-process mutex is **not** distributed nonce leasing. Two processes/queues reading `getTransactionCount(pending)` can grab the same nonce → two intents, one mines, the loser is ambiguous.
- **Fix:** `relayer_nonces(chain_id, signer, next_nonce)`; claim the nonce inside the **same `SELECT … FOR UPDATE` tx** that journals the tx intent. Read `getTransactionCount(pending)` **only** during a paused disaster-recovery resync.

### A4. CCTP Fast-Transfer **net-fee** accounting · `[fugu]` → ledger + contract
- **Problem:** CCTP V2 Fast fee is deducted **at mint on the destination**. The escrow receives `amount − fee`. Crediting the ledger the **gross** burn amount makes the invariant drift on the **first** Fast transfer.
- **Fix:** Split accounting: `cctp:burned_gross` and `cctp:circle_fee`. Drive `fundFromCCTP` from the **actual net minted amount** read from the on-chain mint event (see C — verify the exact event/fields), never the requested burn amount.

### A5. Bind `fundFromCCTP` attribution to the CCTP message · `[both]` → contract + DB
- **Problem:** CCTP mints plain USDC into the escrow; the contract can't tell which `payoutId` a mint belongs to. A buggy/malicious relayer could misattribute one mint to another payout, attribute direct-transfer dust, or double-count one mint.
- **Fix:** DB: `UNIQUE(cctp_message_nonce, source_domain)` before calling `fundFromCCTP`. Contract: add `totalAttributedUnreleased` and assert `totalAttributedUnreleased + amount <= usdc.balanceOf(address(this))` on attribution.

### A6. Explicit EIP-1559 fee policy (not just RBF) · `[both]` → relayer (R3)
- **Problem:** RBF is only a *bump*. A +25% bump on a **stale** `maxFee` during a base-fee spike still won't mine. The plan never sets the **initial** `maxFeePerGas`/`maxPriorityFeePerGas` policy.
- **Fix:** Compute the first attempt from live fees (percentile priority + `baseFee` headroom, per-chain cap). On replacement: `maxFee' = max(currentBaseFee + bumpedPriority, oldMaxFee × 1.25)`. Alert on RPC **fee-estimation failure** separately from replacement exhaustion.

---

## B. REFINEMENTS (High / Medium) — the plan is ~80% here; tighten

### B1. Reorg safety on the release→PIX bridge · `[both]` → relayer / PIX
Store block **hash** (not just number) in `chain_events`. Delay PIX submission until the `release` tx reaches a **safe finality depth**, and re-verify the receipt's `blockHash` is still canonical **immediately before** `POST /payment/approve`. PIX is irreversible; a reorged-out release after a paid PIX = pay-without-collateral.

### B2. Redefine the invariant as three strict checks · `[both]` → ledger / reconciler
Replace the single equality with:
1. **Attribution:** `ledger.balance(escrow:onchain) == escrow.totalAttributedUnreleased()` at block **B**.
2. **Solvency (dust-tolerant):** `usdc.balanceOf(escrow) >= totalAttributedUnreleased()` (track the delta as dust from direct transfers).
3. **Block anchoring:** read the ledger's confirming block **and** chain state at a single pinned **blockHash** (not "latest" number) to avoid reorg-induced false drift.
Fold in the net-fee split from **A4**.

### B3. Harden webhook settlement · `[fugu]` → PIX (P3/P4)
On `MOVEMENT_CONFIRMED`, beyond the HMAC + dedup + polling backstop already planned: verify `correlationID == payoutId`, verify `value == expected centavos`, enforce `UNIQUE(provider, event, correlationID, endToEndId)`, and for **high-value** payouts do a synchronous `GET /payment/{correlationID}` before posting the final settlement. **Webhook = trigger, not settlement authority.**

### B4. Re-screen compliance at each side-effecting transition · `[both]` → compliance (K*)
A merchant approved at create can be sanctioned before the worker runs. Evaluate the sanctions/KYB gate at **every** transition with an external effect (`funded→releasing`, `released→pix_submit`), not only at payout creation.

### B5. CCTP Fast attestation **expiry / reattest** · `[fugu]` → CCTP (X*)
Pre-finality (Fast) V2 messages carry an `expirationBlock`. If the mint is delayed past it, the attestation **expires** — re-polling IRIS won't help; you must call Circle's **reattest** endpoint for a fresh attestation (verify the exact path — see C). Add to the stuck-mint recovery ladder.

### B6. Resolve the `destinationCaller` contradiction · `[fugu]` → CCTP + runbook (§1/§2b)
§1 claims "rescue via any EOA when `destinationCaller == bytes32(0)`," but §2b sets `destinationCaller = relayer`. Circle strictly enforces `destinationCaller`; if it's the relayer, **only** the relayer can `receiveMessage`. **Decide:** (a) set `bytes32(0)` to allow EOA rescue (more recoverable, less anti-grief), or (b) keep the relayer and **delete** the "any EOA" rescue claim from §1.

### B7. Duplicate-mint: verify, don't assume · `[fugu]` → CCTP (X*)
A `NonceUsed` / "already processed" revert only proves *someone* used that nonce — not that **you** minted the right amount to the right recipient. Before advancing state on a duplicate, read the mint event and verify net amount + recipient.

### B8. Exact permit front-run mitigation · `[both]` → contract (C*)
```solidity
try token.permit(owner, address(this), amount, deadline, v, r, s) {} catch {}
require(token.allowance(owner, address(this)) >= amount, "insufficient allowance");
token.safeTransferFrom(owner, address(this), amount);
```

---

## C. VERIFY against current docs before coding (Fugu is *probably* right — confirm)
- **OpenPix/Woovi API host:** plan used `app.openpix-sandbox.com`; Fugu says the REST host is `api.woovi-sandbox.com`. OpenPix = Woovi, so likely correct → confirm the current sandbox REST base URL. `[fugu]` → P2
- **`type: "PIX_KEY"`** required in the `POST /api/v1/payment` payload → confirm. `[fugu]` → P2
- **CCTP reattest endpoint path** (for B5) → confirm in Circle's current V2 docs. `[fugu]` → X*
- **Mint event name/fields** (for A4/B7 — Fugu cites `MintAndWithdraw`) → confirm against Circle's V2 `TokenMinter` / `MessageTransmitter`. `[fugu]`

---

## D. DO **NOT** APPLY — review errors (would regress the plan)
> These came from the red-team's **first pass**; its second pass was cleaner and did not repeat them. Listed so nobody "helpfully" applies them.

- **❌ The "corrected" `depositForBurn` signature** `depositForBurn(amount, nonce, destinationToken, contractToDeposit)` — **wrong / hallucinated.** The real **V2** signature (which the plan already had right) is:
  ```solidity
  depositForBurn(
    uint256 amount, uint32 destinationDomain, bytes32 mintRecipient,
    address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold
  )
  ```
  **Keep the plan's.**
- **❌ "Fast = ~1000 confirmations (~15 min) / Standard = ~2000 (~30 min)"** — **wrong.** `1000 / 2000` are `minFinalityThreshold` **values** (soft vs hard finality), **not** confirmation counts. Fast is **sub-30 s**. **Keep the plan's.**

---

## E. DECISIONS (owner: Orlando) — with recommendation
- **UUPS vs immutable escrow.** Lean **immutable + a documented "deploy V2 & migrate" runbook** for a solo / 6h-week / portfolio build: smaller audit surface, no storage-collision risk, no `_authorizeUpgrade` matrix. *"I chose immutable because upgradeability adds a surface I don't need yet"* is a **more senior** answer than UUPS-by-default. (Counter: shipping correct UUPS is also a signal.) **→ Recommendation: immutable for v1.**
- **EIP-3009 vs EIP-2612.** 2612 is the decided constraint and the funding path is isolated (~1-day swap later). Fugu's point is fair: EIP-3009 `transferWithAuthorization` is a single-use value-transfer primitive that **removes the entire permit front-run class**. **→ Recommendation: keep 2612 for the first slice, but elevate 3009 from "stretch" to "evaluate for v1" — decide when you build C1.**

---

## F. Build-order mapping (where each correction lands)
| Correction | Lands in |
|---|---|
| A1 release constraint · A5 (contract half) · B8 permit · E (UUPS decision) | Contract **C1/C2** |
| A3 nonce allocator · A6 fee policy · A2 outbox (relayer half) · B1 reorg | Relayer **R2/R3** |
| A4 net-fee · B2 invariant redefinition | Ledger / reconciler **L\*** |
| A2 outbox (PIX half) · B3 webhook hardening · C (OpenPix host / PIX_KEY) | PIX **P2/P3/P4** |
| A5 (DB unique) · B5 reattest · B6 destinationCaller · B7 dup-mint verify · C (reattest / event) | CCTP **X\*** |
| B4 compliance re-screen | Compliance **K\*** |

---

## G. Sequence
1. **Now (Claude Code):** commit this doc; add a pointer at the top of `IMPLEMENTATION_PLAN.md`; patch the outright-wrong spots (release `to` → `releaseToTreasury`, single-equality invariant → the 3-invariant §B2, add A2/A3/A6 notes to §2c, resolve B6). Do **not** touch the items in **D**.
2. **Last Fable day:** produce `docs/design/relayer.md` — the relayer design doc that **bakes in A2, A3, A6, B1** (highest-reasoning artifact; survives Fable expiry).
3. **After:** implement the relayer with **Opus 4.8**, review with **Fugu Ultra**. Then contract (C1/C2) with A1/A5/B8 + the E decisions.
