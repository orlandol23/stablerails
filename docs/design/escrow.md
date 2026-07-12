# PayoutEscrow design (C1/C2)

> **Status:** design, pre-implementation. **Owner:** Orlando. **Inputs:** `docs/IMPLEMENTATION_PLAN.md` §2a + `docs/PLAN-CORRECTIONS.md` — this doc **bakes in A1 (constrained release), A4 (net-fee attribution), A5 (CCTP attribution binding), B8 (permit front-run pattern)** and **resolves both §E decisions** (immutable-vs-UUPS; EIP-2612-vs-3009). Companion to `docs/design/relayer.md` — the relayer is the only caller of every state-changing function here.
>
> **This is a design doc, not code.** Solidity is signature/shape, not implementation; names are binding, bodies are not.

`PayoutEscrow` is the security-critical on-chain half of StableRails: a single contract on Base Sepolia that holds all escrowed USDC with **per-payout accounting**, so that (a) every dollar on-chain is attributable to exactly one payout, (b) release is exactly-once and un-redirectable, and (c) the reconciler's three-check invariant (plan §2d) has a precise on-chain counterpart to compare the ledger against.

**Design invariants (the contract-level truths everything below serves):**

1. `totalAttributedUnreleased == Σ amount over payouts in state Funded` — maintained by construction on every transition.
2. `usdc.balanceOf(address(this)) >= totalAttributedUnreleased` — money can be attributed only if it is actually there (**A5**), and attributed money can leave only via `releaseToTreasury`/`refund`.
3. No function accepts an operator-supplied destination. Funds exit to exactly two places: the immutable `TREASURY`, or the payout's **recorded** merchant (**A1**).
4. A `payoutId` is consumed once, forever (`None → Funded → (Released | Refunded)`, no other path, no reset).
5. Attribution amounts are **net** amounts observed on-chain (mint event), never requested amounts (**A4**).

---

## 0. The two §E decisions

### 0.1 Immutable, not UUPS — decided

**Decision: immutable contract, no proxy.** This supersedes §2a's UUPS choice (PLAN-CORRECTIONS wins per its header; §E recommends exactly this).

| | Immutable (chosen) | UUPS |
|---|---|---|
| Audit surface | One contract, no proxy semantics | + ERC-1967 slots, initializers, `_disableInitializers`, `_authorizeUpgrade` matrix, storage-gap discipline |
| Failure classes removed | storage collision, initializer front-run, botched `_authorizeUpgrade`, upgrade-to-malicious | — (each needs tests + CI gates the plan had budgeted: C6) |
| "Fix a bug" story | deploy V2 + migrate (runbook §0.1.1) | in-place upgrade |
| Why migration is *cheap here* | Escrow state is **short-lived per payout** (funded → released within minutes/hours). Draining V1 = finishing or refunding open payouts — something the system must be able to do anyway (pause + compensation paths). There is no long-lived user state to port. | n/a |
| Portfolio signal | *"I chose immutable because upgradeability adds a surface I don't need yet — here's my migration runbook"* — a reasoned custody-minimizing call | Correct UUPS is also a signal, but a costlier one, and C6's storage-diff CI budget is better spent on invariant depth |

Consequences: no `UPGRADER_ROLE`, no initializers (a plain `constructor` sets `immutable` config), no storage gaps, and the C6 task shrinks from "upgrade-safety CI" to "deploy script + address registry". The **migration runbook** ships with the contract PR:

**§0.1.1 Deploy-V2-and-migrate runbook (sketch, becomes `docs/runbooks/escrow-migration.md`):** pause V1 → stop creating new payouts against V1 (registry flip is gated) → drive every `Funded` payout to `Released` or `Refunded` (the normal paths; nothing special) → assert `totalAttributedUnreleased == 0` → `skim()` residual dust to treasury → deploy V2, update the address-registry package (one versioned source of truth the relayer reads) → resume. V1 is left paused and empty; optionally `DEFAULT_ADMIN_ROLE` is renounced on it.

### 0.2 EIP-2612 for v1; EIP-3009 elevated to "additive, evaluate at implementation" — decided

**v1 funds via EIP-2612 Permit** ([EIP-2612]) with the B8 pattern (§2.1) — it is the decided constraint, the wagmi/viem signing UX is native, and B8 turns the known permit front-run from a risk into a non-event (grief-only, zero fund risk).

**EIP-3009 is elevated per §E** from "stretch" to a decision recorded here: *not in the v1 slice*, but designed as an **additive** second intake, `fundWithAuthorization`, behind the same internal `_fund` path (~1 day when wanted). Precision that matters when it's built: the right 3009 primitive is **`receiveWithAuthorization`** (not `transferWithAuthorization`) — it requires `to == msg.sender`, i.e. only the escrow itself can submit the merchant's authorization, which eliminates even the *submission* front-run that B8 tolerates. Not building it now keeps the v1 ABI minimal; nothing in the storage or event design blocks it.

## 1. State & storage

```solidity
enum PayoutState { None, Funded, Released, Refunded }   // one-way: None→Funded→(Released|Refunded)

struct Payout {                 // packed into ONE storage slot
    address merchant;           // 160 bits — recorded party; the ONLY refund destination
    uint88  amount;             // 88 bits  — micro-USDC (6 dp); max ≈ 3.09e20 USDC ≫ supply
    PayoutState state;          // 8 bits
}

mapping(bytes32 => Payout) private _payouts;   // key = bytes32(payoutId), uuidv7 in low 16 bytes
uint256 public totalAttributedUnreleased;      // Σ amount where state == Funded

IERC20  public immutable USDC;      // Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
address public immutable TREASURY;  // settlement treasury — set once, in the constructor
```

- **Single-slot packing** (`160 + 88 + 8 = 256`): one `SLOAD` per guard check, one `SSTORE` per transition. The ABI still takes `uint256 amount` and range-checks into `uint88` (`AmountOverflow()`) — callers never see the packing.
- **`TREASURY` is `immutable`** — the strongest possible A1 stance: there is no `setTreasury` to misuse, timelock, or fat-finger. Rotating the treasury = deploying V2 via §0.1.1, which is acceptable precisely because migration is cheap here. (The weaker alternative — `ADMIN_ROLE`-settable behind a timelock — is documented and rejected: it re-opens the redirect-with-patience attack A1 exists to close.)
- **Why immutability kills the storage-collision class:** with no proxy, the compiler's layout *is* the layout forever; there is no future implementation that must agree with it, so no gaps, no layout-diff CI, no `__gap` conventions.
- `payoutId` is the `bytes32` form of the UUIDv7 correlation id (`packages/core` mapping: low 16 bytes, high 16 zero). The contract does not validate the UUID shape — uniqueness-of-consumption (`PayoutExists`) is the guard that matters on-chain.

## 2. Functions

All state-changing functions: `onlyRole(OPERATOR_ROLE)` + `whenNotPaused` + `nonReentrant`. Views are free. Custom errors throughout (`PayoutExists`, `PayoutNotFunded`, `AlreadyReleased`, `AlreadyRefunded`, `InsufficientEscrowBalance`, `AmountOverflow`, `ZeroAmount`, `ZeroAddress`, `InsufficientAllowance`).

### 2.1 `fundWithPermit(bytes32 payoutId, address merchant, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`

Pulls the merchant's USDC using their EIP-2612 signature; the relayer pays gas (gasless for the merchant).

- **Checks:** `payoutId` unused (`_payouts[payoutId].state == None` else `PayoutExists`); `merchant != 0`; `0 < amount ≤ uint88.max`.
- **Effects:** record `{merchant, amount, Funded}`; `totalAttributedUnreleased += amount`.
- **Interactions — the exact B8 pattern, verbatim:**

  ```solidity
  try token.permit(owner, address(this), amount, deadline, v, r, s) {} catch {}
  require(token.allowance(owner, address(this)) >= amount, "insufficient allowance");
  token.safeTransferFrom(owner, address(this), amount);
  ```

  A griefer who front-runs the permit only *executes it for us*: the `catch` swallows the "already used" revert, the allowance check proves spendability, and `safeTransferFrom` proceeds. The front-run class is reduced to paying our approval gas. (`require` shown as in PLAN-CORRECTIONS B8; implementation may use `InsufficientAllowance()` custom error — same semantics.)
- **Event:** `Funded(bytes32 indexed payoutId, address indexed merchant, uint256 amount, FundingSource source)` with `source = Permit`.
- Effects-before-interactions ordering is kept even though the interaction is a pull: if the transfer reverts, the whole frame reverts — and the discipline is uniform across all four functions (uniformity is what auditors and invariant handlers check).

### 2.2 `fundFromCCTP(bytes32 payoutId, address merchant, uint256 netAmount)`

Attributes USDC **already minted into the contract** by CCTP to a payout. The contract cannot know which mint belongs to which payout — attribution is an explicit operator action, made safe by two binds (A5) and one measurement rule (A4):

- **Off-chain bind (precondition, enforced in Postgres before the call):** a row inserted under `UNIQUE(cctp_message_nonce, source_domain)` — one CCTP message attributes at most once, ever. The relayer's tx intent for this call references that row.
- **On-chain bind (the A5 assert, in checks):** `totalAttributedUnreleased + netAmount <= USDC.balanceOf(address(this))` else `InsufficientEscrowBalance` — attribution can never exceed money actually present, so double-attribution of one mint (or attribution of imaginary funds) fails *on-chain* even if the DB layer is bypassed or buggy. Unattributed dust from direct transfers is *not* attributable beyond real balance either.
- **Net-amount rule (A4):** `netAmount` is read by the orchestrator from the **on-chain mint event** on Base Sepolia (Circle deducts the Fast-transfer fee **at mint**, so net = burned gross − fee; event name/fields per PLAN-CORRECTIONS C — verify `MintAndWithdraw` on the V2 TokenMinter at implementation). The requested burn amount never enters this function. This is what keeps reconciler check #2 an *equality* instead of an approximation; the fee posts to `cctp:circle_fee` in the ledger (plan §2d).
- **Checks/Effects/Event:** as 2.1 (unused `payoutId`, record, increment; `source = CCTP`). No token interaction — the money already arrived; this function only *names* it.

### 2.3 `releaseToTreasury(bytes32 payoutId)` — A1

- **Checks:** state == `Funded` (`PayoutNotFunded` if `None`; `AlreadyReleased` / `AlreadyRefunded` for precise diagnostics).
- **Effects (CEI — state closes before value moves):** `state = Released`; `totalAttributedUnreleased -= amount`.
- **Interactions:** `USDC.safeTransfer(TREASURY, amount)` — destination is the immutable; **there is no `to` parameter to misuse**. Operator *triggers*, never *redirects*.
- **Event:** `Released(bytes32 indexed payoutId, address indexed treasury, uint256 amount)`.
- Exactly-once: the second call reverts `AlreadyReleased` — the on-chain half of the rail's exactly-once guarantee (the relayer's intent journal is the off-chain half).

### 2.4 `refund(bytes32 payoutId)`

Compensation path (PIX terminal failure → return funds). Identical discipline to 2.3 with destination `_payouts[payoutId].merchant` — the party **recorded at funding time**, not a parameter. Emits `Refunded(bytes32 indexed payoutId, address indexed merchant, uint256 amount)`. `Released` and `Refunded` are mutually exclusive terminal states by the state machine (no path between them).

### 2.5 `skim()` — dust management

Sends `USDC.balanceOf(address(this)) − totalAttributedUnreleased` (the unattributed surplus: direct transfers, mint dust) to `TREASURY`. `DEFAULT_ADMIN_ROLE`, `nonReentrant`, works while paused (dust evacuation must not require unpausing). No parameters — A1 discipline applies to admin too. Emits `Skimmed(uint256 amount)`. Cannot touch attributed funds by construction (subtraction is the definition of dust).

### 2.6 Views

`payoutOf(bytes32) → Payout`, `totalAttributedUnreleased()` (public var getter), `unattributedBalance() → uint256` (the skimmable amount — also the reconciler's dust gauge input).

## 3. Roles & pause

| Function | `OPERATOR_ROLE` (relayer) | `PAUSER_ROLE` | `DEFAULT_ADMIN_ROLE` |
|---|---|---|---|
| `fundWithPermit` / `fundFromCCTP` | ✅ | — | — |
| `releaseToTreasury` / `refund` | ✅ | — | — |
| `pause` | — | ✅ | — |
| `unpause` | — | — | ✅ |
| `skim` | — | — | ✅ |
| grant/revoke roles | — | — | ✅ |
| change treasury / upgrade | **nobody** (immutable, no proxy) | | |

- `Pausable` gates all four state-changing payout functions (`whenNotPaused`). Pause is the circuit breaker the reconciler's drift alert can pull (plan §2d step 6; testnet: operator CLI, mainnet-path: monitoring automation holding only `PAUSER_ROLE` — pause is safe to automate *because* it is grief-limited and admin can revoke).
- Role holders (testnet): admin = deployer EOA (mainnet-path note: multisig + timelock); operator = the relayer signer; pauser = relayer signer **and** admin.

**What a stolen `OPERATOR_ROLE` key can do** — the A1 threat walk (threat T1, plan §2i):

| Action | Possible? | Worst-case impact |
|---|---|---|
| Drain escrow to attacker address | **No** — no function takes a destination | — |
| `releaseToTreasury` payouts early | Yes | Funds land in **our** treasury — sequencing noise, ledger flags it (reconciler check #2 mismatch vs payout states), zero loss |
| `refund` funded payouts | Yes | Funds return to the **recorded merchants** — unwinds business state, no theft |
| Misattribute a CCTP mint to the wrong payout | Yes (within the A5 balance bound) | Ledger↔chain attribution mismatch → reconciler check #2 **trips**, releases halt; no money moves to the attacker; bounded by money actually present |
| Fabricate attribution beyond balance | **No** — on-chain A5 assert | — |
| Spam `pause`-adjacent grief (fund/release flapping) | Bounded by role revocation | Admin revokes `OPERATOR_ROLE` (incident runbook: pause → rotate operator role → resync relayer) |

## 4. Invariant hooks (what the reconciler reads)

The contract exposes exactly the two numbers the plan-§2d three-check invariant needs, both readable at a pinned `blockHash` (B1/B2 anchoring is the reconciler's job; the contract just has to be *precise*):

1. **Attribution (strict equality):** `ledger.balance(escrow:onchain) == totalAttributedUnreleased()` at block B. Holds exactly *because of A4*: both sides are built from the same on-chain observations — `Funded` events with net amounts, `Released`/`Refunded` events — never from requested amounts. Every unit that increments/decrements the counter is evented, so the ledger can replay the counter from events alone.
2. **Solvency (dust-tolerant):** `USDC.balanceOf(escrow) >= totalAttributedUnreleased()`; delta = `unattributedBalance()` = the dust gauge. Maintained by construction: fund paths move ≥ the attributed amount in (2.1) or assert presence (2.2); exits decrement the counter before transferring exactly that amount out.
3. **Block anchoring:** both reads carry no contract requirement beyond being `view` — the reconciler pins `blockHash` and reads both sides there.

`Funded(payoutId, merchant, amount, source)` / `Released` / `Refunded` / `Skimmed` are the complete posting triggers for the ledger's on-chain-driven entries (plan §2d lifecycle table) — indexed on `payoutId` and party so the ledger's event-ingestion can filter cheaply.

## 5. CCTP boundary

- **How money arrives:** `depositForBurn` on the source chain sets `mintRecipient = bytes32(escrow)`; the mint lands as a plain USDC `transfer` to the contract. `destinationCaller = bytes32(0)` (decided, B6) — anyone may submit `receiveMessage`, so rescue-by-any-EOA works and Circle's Forwarding Service remains a drop-in mint submitter. The escrow has **zero CCTP-specific code in v1** — deliberately: the CCTP surface (message formats, attestations) stays off the audited-money contract entirely.
- **How money gets named:** orchestrator observes the mint (B7 — *verify, don't assume*: read the mint event, check recipient = escrow and take the **net** amount), inserts the `UNIQUE(cctp_message_nonce, source_domain)` row, then journals a `tx_intent` (`kind='escrow.fund_from_cctp'`, relayer design §1) calling `fundFromCCTP(payoutId, merchant, net)`. A duplicate or externally-submitted mint changes nothing: the DB unique blocks re-attribution, the A5 assert bounds it on-chain.
- **Stretch (unchanged from plan §6):** `depositForBurnWithHook` carrying `payoutId` in hook data would make attribution trustless — the v1 design isolates that upgrade to `fundFromCCTP`'s call site.

## 6. Foundry test plan

| Layer | Contents |
|---|---|
| **Unit** | Full revert table (each custom error × each trigger); role matrix (every function × every role, incl. admin-cannot-release and operator-cannot-skim); pause gating (paused ⇒ every payout function reverts; `skim` still works); event assertions (`vm.expectEmit`, all indexed fields); B8 paths: permit ok / permit pre-executed by front-runner (`vm.prank` executes the permit first — fund must still succeed) / expired deadline / bad signature with no allowance (revert) / bad signature but pre-approved allowance (succeeds — documents that allowance, not the permit, is the authority); `uint88` boundary (max ok, max+1 `AmountOverflow`); refund-then-release and release-then-refund both revert |
| **Fuzz** | amounts across full 6-dp range; random payoutId reuse attempts; interleaved fund/release/refund sequences on disjoint ids |
| **Invariant** (handler-based, ghost variables; `profile.ci`: runs=1000, depth=100) | Handler ops: fundPermit, fundCCTP (with a `deal`-simulated mint first), release, refund, skim, directTransfer (dust injection), pause/unpause. Invariants: **(I1)** `totalAttributedUnreleased == Σ ghost_funded − Σ ghost_released − Σ ghost_refunded`; **(I2 — the required one)** handler maintains a mirror double-entry ledger (the off-chain analog posting on every op) and asserts `ledgerMirror.balance(escrow) == totalAttributedUnreleased()` — *`sum(ledger) == escrow` as an executable Foundry invariant*; **(I3)** `USDC.balanceOf(escrow) >= totalAttributedUnreleased` under arbitrary dust injection; **(I4)** no payout ever observed in both `Released` and `Refunded` (ghost state history); **(I5)** paused ⇒ handler's payout ops all reverted this depth |
| **Fork** (Base Sepolia, `vm.createSelectFork`; nightly + pre-deploy) | Real USDC `0x036C…F7e`: read `version()`/`DOMAIN_SEPARATOR` live and sign a real permit (answers plan §7 open question 2); full fund→release round-trip with real token; CCTP-shaped test: replay a recorded real `receiveMessage(message, attestation)` against the forked MessageTransmitterV2 (attester set is real on fork), observe the mint event, attribute the **net** amount — proving the A4 measurement path without live cross-chain latency |
| **Gas** | `forge snapshot` committed (`.gas-snapshot`); CI diffs via the existing gas-report PR-comment job — regressions are review items, not silent |
| **Static** | slither gate (high/med clean or triaged inline), `forge fmt --check` |

Mutation spot-checks (the "tests bite" proof, mirroring the plan's C4 note): swap CEI order in `releaseToTreasury`, remove the A5 assert, remove the `PayoutExists` guard — each must fail at least one invariant/unit test, recorded in the PR description.

## 7. Security checklist (contract-owned threat rows)

| Area | Disposition |
|---|---|
| Reentrancy / CEI | CEI in all four payout functions + `nonReentrant` belt-and-suspenders; USDC has no transfer hooks (documented assumption: canonical Circle FiatToken, no FoT/rebase/callbacks — the contract is **not** generic-ERC20-safe and says so) |
| Access control | Role matrix §3 with negative tests; no destination parameters anywhere (A1); `TREASURY` immutable; stolen-operator walk §3 shows worst case = sequencing noise, not theft |
| Arithmetic / decimals | All amounts micro-USDC (6 dp) in `uint88` (range-checked from `uint256` ABI); no rate math on-chain (FX lives off-chain, plan §2d); counter updates are ±exact recorded amounts — no rounding surface |
| Permit replay / signature | USDC's own permit nonce prevents signature replay; `payoutId` one-shot prevents intent replay; short deadlines set by the frontend (plan T4); B8 makes front-run harmless |
| Upgrade safety | **N/A by design** — no proxy, no initializers, no storage gaps (§0.1); the migration runbook replaces the entire class |
| Griefing | Permit front-run → B8; `payoutId` squatting impossible from outside (all writers are `OPERATOR_ROLE`); dust injection → bounded by I3 + `skim` |
| Event completeness | Every state change evented with indexed `payoutId` (§4) — the ledger can reconstruct the counter from events alone (tested: replay events in the invariant handler's mirror) |
| Pause coverage | All payout functions gated; `skim` deliberately not (dust evacuation under incident); unpause is admin-only |

---

## First PR for the contract (proposal)

**PR #4 — `feat(contracts): PayoutEscrow v1 (immutable) + invariant/fork suites`** *(assumes relayer PR #2/#3 numbering; adjust)*

Scope: everything in §1–§5 as one immutable contract + the §6 test plan's unit/fuzz/invariant layers and the fork suite gated behind an RPC env var. Explicitly **out**: EIP-3009 intake (§0.2, additive later), CCTP hook attribution (stretch), KMS/multisig role rotation (testnet uses EOAs), the ledger-side ingestion (lands with L-tasks — but the event shapes here are already its contract).

**Files**

| Path | Content |
|---|---|
| `packages/contracts/src/PayoutEscrow.sol` | The contract (§1–§5): OZ v5 `AccessControl` + `Pausable` + `ReentrancyGuard` + `SafeERC20`, custom errors, packed struct |
| `packages/contracts/src/interfaces/IPayoutEscrow.sol` | External interface + events + errors (what the TS side codegen consumes) |
| `packages/contracts/test/PayoutEscrow.t.sol` | Unit + fuzz (§6 rows 1–2) |
| `packages/contracts/test/invariant/PayoutEscrow.invariant.t.sol` + `handlers/EscrowHandler.sol` | I1–I5 incl. the **ledger-mirror invariant I2**; ghost accounting; dust injection |
| `packages/contracts/test/fork/PayoutEscrow.fork.t.sol` | Base Sepolia fork: real-USDC permit, recorded `receiveMessage` replay, net-amount attribution (skipped unless `BASE_SEPOLIA_RPC_URL` set; wired into `nightly.yml`) |
| `packages/contracts/script/DeployPayoutEscrow.s.sol` | `forge script` deploy (constructor: USDC, treasury, admin) + broadcast artifact |
| `packages/core/src/addresses.ts` (or new `packages/addresses`) | Versioned address registry entry the relayer/API read |
| `packages/contracts/.gas-snapshot` | Committed baseline |
| `docs/runbooks/escrow-migration.md` | §0.1.1 as an operator document |
| CI | `forge snapshot --check` added to the contracts job (diff comment via the existing gas-report pattern); slither stays gating |

**Acceptance criteria**

| # | Criterion |
|---|---|
| 1 | **Invariant I2 green** — the handler's mirror double-entry ledger equals `totalAttributedUnreleased()` at `runs=1000, depth=100` (ci profile) with dust injection and pause/unpause in the op mix; I1/I3/I4/I5 likewise |
| 2 | Fork test signs a **real** EIP-2612 permit against Base Sepolia USDC (domain read live, not hardcoded) and completes fund→release; recorded-message CCTP replay attributes the **net** minted amount (A4 proven end-to-end) |
| 3 | Role-matrix tests: every function × every role, including all denials; **no function signature contains a destination address parameter** (checked by an ABI-shape test, not convention) |
| 4 | B8 front-run test: a third party executing the permit first does not block funding; permit-replay and `payoutId`-reuse both revert |
| 5 | Gas snapshot committed; CI fails on unacknowledged regression (`forge snapshot --check`); slither high/med clean or triaged inline |
| 6 | Mutation spot-checks documented in the PR description: CEI swap, A5-assert removal, and `PayoutExists`-guard removal each break a named test |
