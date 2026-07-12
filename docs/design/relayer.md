# Relayer design (R2/R3)

> **Status:** design, pre-implementation. **Owner:** Orlando. **Inputs:** `docs/IMPLEMENTATION_PLAN.md` §2c + `docs/PLAN-CORRECTIONS.md` — this doc **bakes in A2 (provider-operation outbox), A3 (Postgres nonce allocator), A6 (explicit EIP-1559 fee policy), B1 (reorg safety)** and inherits the AI-DLH queue semantics (atomic claim, attempt-at-claim, error taxonomy, stale-lock recovery) that the plan adopted as the behavioral spec.
>
> **This is a design doc, not code.** SQL is DDL-shape, TypeScript is interface-shape; names are binding, bodies are not.

The relayer is the component that turns a durable *intent* ("release payout X", "submit this CCTP mint") into exactly one on-chain transaction — or one externally-visible provider call — under crashes, retries, duplicate deliveries, fee spikes, and reorgs. Everything else in StableRails leans on it, which is why it is built and chaos-tested first.

**Design invariants (the six sentences everything below serves):**

1. Postgres is the only system of record; Redis/BullMQ may be flushed at any moment without correctness loss.
2. No transaction is broadcast before its signed bytes are durably journaled (**journal-before-broadcast**).
3. No external provider is POSTed before an outbox row exists; after a crash, provider state is **read** before any re-POST (**A2**).
4. A nonce exists in exactly one place before use: the Postgres allocator, leased in the same transaction that journals the intent (**A3**).
5. Fees are computed from the live market on first attempt *and* on every replacement (**A6**); a bump of a stale price is not a strategy.
6. Nothing irreversible (PIX) happens on the strength of a block that could still disappear (**B1**).

---

## 1. Transaction-intent state machine

One row per intended on-chain transaction. The row is created by business logic (payout worker, CCTP orchestrator) and driven to a terminal state by the `TxSubmitter` worker. Replacements (RBF) reuse the **same row** — same nonce, new hash — so "one intent = at most one mined tx" is a table-level truth.

### 1.1 Table

```sql
CREATE TABLE tx_intents (
  id                    uuid PRIMARY KEY,          -- uuidv7
  payout_id             uuid NOT NULL,
  kind                  text NOT NULL,             -- 'escrow.fund_with_permit' | 'escrow.release_to_treasury'
                                                   -- | 'escrow.refund' | 'cctp.receive_message' | 'ops.cancel_nonce'
  chain_id              integer NOT NULL,
  signer                text NOT NULL,             -- lowercase 0x address of the operator account
  state                 text NOT NULL,             -- see §1.2
  -- set atomically at journal time (same tx as the nonce lease, §2):
  nonce                 bigint,
  tx_hash               text,                      -- keccak256(signed raw tx)
  raw_tx                text,                      -- signed raw tx hex — the replayable artifact
  max_fee_per_gas       numeric(30,0),
  max_priority_fee_per_gas numeric(30,0),
  gas_limit             numeric(30,0),
  replacement_count     integer NOT NULL DEFAULT 0,
  superseded_hashes     text[] NOT NULL DEFAULT '{}',  -- prior RBF hashes; any of them may still mine
  -- set when a receipt is first observed (B1: hash, not just number):
  block_hash            text,
  block_number          bigint,
  receipt_status        smallint,                  -- 1 success / 0 reverted
  -- queue bookkeeping (AI-DLH semantics):
  attempts              integer NOT NULL DEFAULT 0,   -- incremented AT CLAIM TIME
  locked_at             timestamptz,                  -- stale-lock crash recovery
  next_attempt_at       timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (payout_id, kind),                        -- idempotency: one intent per action per payout
  UNIQUE (chain_id, signer, nonce)                 -- one intent per leased nonce
);
CREATE INDEX ON tx_intents (state, next_attempt_at);
CREATE INDEX ON tx_intents (chain_id, signer, state);
```

`UNIQUE (payout_id, kind)` is the enqueue-side dedup (the AI-DLH partial-unique-index lesson, without the partial-index/drizzle-kit trap — this one is total). A duplicate business request hits `23505` and adopts the existing intent.

### 1.2 States and transitions

```
created ──▶ journaled ──▶ broadcast ──▶ mined ──▶ confirmed ──▶ final
              │               │  ▲         │
              │               │  └─(RBF: journaled', same row, same nonce, new hash)
              │               │            └─(reorg: block gone) ──▶ broadcast
              │               └─(nonce_too_low & no receipt) ──▶ unknown ──resolve──▶ mined | parked
              └─(park paths) ──▶ parked | reverted
```

| State | Meaning | Entered by | Leaves by |
|---|---|---|---|
| `created` | Business intent exists; no nonce, no signature | business logic INSERT | worker claim → journal step |
| `journaled` | Nonce leased + tx signed + `{nonce, tx_hash, raw_tx, fees}` persisted, **not yet sent** | the §2 allocator transaction | broadcast step |
| `broadcast` | `eth_sendRawTransaction` accepted (incl. "already known") | worker | receipt observed → `mined`; timeout → RBF re-journal; error → taxonomy (§6) |
| `mined` | Receipt seen; `block_hash/number/status` stored (**B1**) | receipt poll | depth ≥ `confirmation_depth` **and** block-hash still canonical → `confirmed`; block vanishes → back to `broadcast`; `receipt_status=0` → `reverted` |
| `confirmed` | Deep enough for ledger postings | depth check | depth ≥ `finality_depth` (or `safe`/`finalized` tag) → `final` |
| `final` | Safe for irreversible follow-ons (PIX may proceed — §5) | finality gate | terminal ✔ |
| `unknown` | Crash/ambiguity: journaled-or-broadcast but on-chain status unproven | recovery sweep (§3.3) | resolver: receipt found → `mined`; raw replayable → `broadcast`; else → `parked` |
| `parked` | Needs an operator: RBF ceiling hit, nonce wedged, unclassified error storm | worker/resolver | runbook action → re-enqueued or cancelled via `ops.cancel_nonce` |
| `reverted` | Mined with `status=0` — **nonce consumed**, action failed permanently | receipt poll | terminal ✖ (alert; compensation is a *new* business decision, never a retry of this row) |

Rules the implementation must honor:

- **Attempts increment at claim time** (crash between claim and send still consumes an attempt) — AI-DLH `blockchain-queue.service.ts:167-175` semantics.
- Ledger postings key off `confirmed`; PIX submission keys off `final` (§5). Nothing keys off `mined`.
- `reverted` is terminal even though the payout may retry *via a new intent with a new `kind` qualifier* — the `UNIQUE(payout_id, kind)` row is evidence of what happened, never overwritten.
- Every transition writes `updated_at` and an `audit_events` row (plan §2f hash chain).

## 2. Nonce allocator (A3)

### 2.1 Why not `getTransactionCount(pending)` + mutex

An in-process mutex serializes one process. Two workers (a second container, a janitor replay, an operator CLI) each reading `getTransactionCount(pending)` can observe the same value and sign two different transactions with the same nonce: one mines, the other becomes a phantom that may mine *later* if fees drift, executing a stale intent. The pending-pool view also lies under mempool eviction and RPC load-balancing (two nodes, two answers). Correctness must come from our own serialization point, which we already have: Postgres.

### 2.2 Schema + lease

```sql
CREATE TABLE relayer_nonces (
  chain_id   integer NOT NULL,
  signer     text    NOT NULL,
  next_nonce bigint  NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, signer)
);
```

The lease happens inside the **same transaction** that journals the intent — nonce allocation and journal are one atomic fact (A3):

```sql
BEGIN;
  SELECT next_nonce FROM relayer_nonces
    WHERE chain_id = $1 AND signer = $2
    FOR UPDATE;                                   -- serialization point

  UPDATE relayer_nonces SET next_nonce = next_nonce + 1, updated_at = now()
    WHERE chain_id = $1 AND signer = $2;

  UPDATE tx_intents SET
    state = 'journaled', nonce = $leased, tx_hash = $hash, raw_tx = $raw,
    max_fee_per_gas = $mf, max_priority_fee_per_gas = $mp, gas_limit = $gl
    WHERE id = $intent AND state = 'created';     -- claim-guarded
COMMIT;
```

Signing happens *before* `BEGIN` is impossible (the nonce is inside the signature), so the flow is: open tx → lease nonce → sign in-process with that nonce (fast, local, no I/O to chain) → write journal → commit. If the process dies mid-transaction, Postgres rolls back both the lease and the journal together — no leaked nonce, no orphan intent. A crash **after** commit is the §3.3 recovery case: the nonce is leased *and* the signed bytes are durable, so replay is safe.

Consequences:

- Concurrent journal attempts serialize on `FOR UPDATE` — distributed-safe with N processes, no configuration required. BullMQ `concurrency=1` per `(chain, signer)` queue remains as a **throughput/ordering nicety** (avoids n+1-before-n broadcast stalls), never as the correctness mechanism.
- RBF does **not** lease a new nonce: a replacement re-signs the same intent row's nonce with new fees and appends the old hash to `superseded_hashes`.
- A journaled intent that can never broadcast (e.g., signer rejects after a config change) wedges nonce *n* for everyone behind it. The unwedge is `ops.cancel_nonce`: a self-transfer of 0 ETH at nonce *n* with the same fee policy — the nonce gets consumed by a no-op, the wedged intent goes `parked`, follow-ons flow. This is an explicit intent `kind`, journaled and audited like any other.

### 2.3 Disaster-recovery resync (the *only* legitimate `getTransactionCount` call)

Trigger: `parked` pile-up, `nonce too low` on a *journaled* nonce we believe is fresh, or operator suspicion after an incident. Procedure (runbook `docs/runbooks/nonce-resync.md`, rehearsed in the chaos suite):

1. **Pause** the `(chain, signer)` queue (BullMQ pause + `system_flags` row the workers honor).
2. Wait until no intent is in `broadcast` with a live RBF timer (bounded by the attempt timeout).
3. Resolve every `journaled|broadcast|unknown` intent via `eth_getTransactionByHash`/`getTransactionReceipt` on **each** of `tx_hash ∪ superseded_hashes` → settle rows to `mined`/`parked`.
4. `chain_nonce := getTransactionCount(signer, 'latest')`. `db_next := relayer_nonces.next_nonce`.
5. If `chain_nonce > db_next`: someone signed outside the allocator (incident — investigate before proceeding). If `chain_nonce < db_next`: gap — for each missing nonce either re-broadcast its journaled raw or `ops.cancel_nonce` it.
6. Set `next_nonce := max(chain_nonce, resolved journaled maximum + 1)`, log an `audit_events` entry with both values, unpause.

## 3. Journal-before-broadcast + provider outbox (A2)

### 3.1 On-chain: sign → hash → persist → send

The AI-DLH gap this closes: it sent first and persisted after, so a crash in between could double-submit. Here the order is fixed:

1. Build the tx (`prepareTransactionRequest` semantics: to/data/value/gas/fees/nonce).
2. Sign **locally** via the `SignerAccount` seam (§7) — no network.
3. `tx_hash = keccak256(raw_tx)` — the hash is a pure function of the signed bytes; we know it before any node does.
4. Persist (§2.2 transaction).
5. `eth_sendRawTransaction(raw_tx)` → state `broadcast`.

Re-sending the same `raw_tx` is idempotent at the node: "already known" is success; "nonce too low" means *some* tx with that nonce mined — resolve by hash lookup (ours ⇒ `mined`; not ours ⇒ incident, see §2.3 step 5). This is what makes crash-replay safe *by construction* rather than by luck.

### 3.2 Off-chain: the provider-operation outbox

The same crash window exists for OpenPix and any other external POST: provider accepted, we died before recording it. On-chain we get idempotency from the nonce; off-chain we must build it (A2):

```sql
CREATE TABLE provider_operations (
  id              uuid PRIMARY KEY,               -- uuidv7
  payout_id       uuid NOT NULL,
  provider        text NOT NULL,                  -- 'openpix' | 'iris' | ...
  operation       text NOT NULL,                  -- 'payment.create' | 'payment.approve' | ...
  correlation_id  text NOT NULL,                  -- provider-side idempotency handle (= payoutId for OpenPix)
  status          text NOT NULL DEFAULT 'unknown',-- 'unknown' | 'succeeded' | 'failed'
  request_digest  text NOT NULL,                  -- sha256 of canonical request body (tamper/diff evidence)
  response_snapshot jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (payout_id, provider, operation)         -- one op per action per payout
);
```

Protocol (mirrors §3.1 exactly — it is the same idea with `GET` standing in for the nonce):

1. **Before** the POST: commit the row with `status='unknown'` in its own transaction.
2. POST. On response, update to `succeeded`/`failed` with the snapshot (separate tx).
3. On any retry/redelivery/restart: if a row for `(payout_id, provider, operation)` exists with `status='unknown'`, the worker **must** resolve it by reading provider truth — `GET /api/v1/payment/{correlationID}` for OpenPix, a chain read (mint event by message nonce) for CCTP — and settle the row **before any re-POST is even considered**. *GET provider state before re-POST* is a hard rule; a blind re-POST when an `unknown` row exists is a bug by definition, and the chaos suite (§8, test 9) asserts it can't happen.

### 3.3 Crash-recovery sweep

On worker boot and on a repeatable schedule (the janitor):

- `tx_intents` in `journaled` with no live claim → re-broadcast `raw_tx` (idempotent, §3.1) → `broadcast`.
- `tx_intents` in `broadcast` past their receipt-poll deadline with locks stale → resolve by hash set; unresolvable → `unknown` → resolver.
- `provider_operations` in `unknown` older than a grace window → GET-resolve as §3.2(3).
- Rows in `created` with no BullMQ job (Redis flushed) → re-enqueue with the deterministic job id.

The sweep is idempotent and safe to run concurrently with normal traffic (everything is claim-guarded).

## 4. EIP-1559 fee policy (A6)

Two decisions, both explicit, both per-chain-configurable:

**First attempt** (no more "let the library default it"):

```
priority  = clamp(percentile(feeHistory(N_blocks, [p50]).reward), floor_wei, priority_cap)
maxFee    = 2 × latestBaseFee + priority          # headroom ≈ six consecutive +12.5% base-fee blocks
assert maxFee ≤ per_chain_max_fee_cap             # circuit breaker: refuse to sign absurd prices
```

Per-chain defaults (testnet; tuned constants live in config, not code): Base Sepolia `{N=5, p50, floor 0.001 gwei, attempt_timeout 30 s}` (2 s blocks — a stuck tx is knowable fast); Ethereum Sepolia `{N=10, p50, floor 1 gwei, attempt_timeout 90 s}`; Arbitrum Sepolia `{N=5, p50, floor 0.01 gwei, attempt_timeout 45 s}`.

**Replacement** (on attempt timeout without a receipt):

```
priority' = priority × 1.25                        # ≥ +10% node rule, with margin
maxFee'   = max(2 × currentBaseFee + priority',    # re-read the market — the A6 point
               oldMaxFee × 1.25)                   # AND satisfy the node's replacement minimum
```

The `max()` is the heart of A6: during a base-fee spike, `oldMaxFee × 1.25` alone can still sit below the current base fee and never mine; during calm, `2×base + priority'` alone might violate the node's ≥ +10%-on-both-fields replacement rule. Taking the max satisfies both regimes. Each replacement re-signs the same nonce (§2.2), appends the prior hash to `superseded_hashes`, increments `replacement_count`; `waitForTransactionReceipt`'s `onReplaced` callback classifies `repriced` (our bump mined — success) vs `cancelled`.

**Ceiling & alerts** — two *separate* failure domains, two alerts:

- `stablerails.tx.fee_estimation_failures_total` — `eth_feeHistory`/`gasPrice` RPC failures. Meaning: we can't even price a tx; the RPC layer is sick. No replacement math will fix it; page on sustained failure.
- `stablerails.tx.replacement_exhausted_total` — `replacement_count` hit the ceiling (3); intent → `parked`, runbook link in the alert annotation. Meaning: the market outran our caps or the tx is unmineable; a human raises the cap or cancels the nonce.

## 5. Reorg safety (B1)

PIX is irreversible; blocks are not. The bridge between them is gated three times:

1. **Store the hash, not just the number.** `mined` records `block_hash`; every depth check re-fetches the receipt (or the block at that height) and compares hashes — a same-height different-hash answer means our block was orphaned: state rolls back to `broadcast` (the tx usually re-mines; the journal makes that free), and `stablerails.tx.reorged_total` increments.
2. **Finality gate before PIX.** `pix.submit` is enqueued only when the `escrow.release_to_treasury` intent reaches `final`: depth ≥ `finality_depth` on chains where depth is the only tool, or the `safe`/`finalized` block tag where the chain provides one (Base, an OP-stack chain, does; prefer the tag — it is the chain's own safety claim, not our heuristic). Testnet demo config: Base Sepolia `finality_depth=12` *or* tag-`safe`, whichever the RPC supports ⚠️ verify tag support on the chosen RPC at implementation time; mainnet guidance documented alongside.
3. **Canonical re-check at the last moment.** Immediately before `POST /api/v1/payment/approve` (the money-moving step; `payment.create` is reversible by non-approval), the worker re-fetches the release receipt and asserts `status == 1 ∧ blockHash == stored ∧ depth ≥ finality`. Only then approve. Any mismatch → abort, alert, intent back to the depth-wait loop. The window between check and approve is accepted risk, minimized to one HTTP call, and *recorded* (the check result is journaled in the outbox row's `response_snapshot`).

## 6. Error taxonomy (viem), retries, parking

Ported from AI-DLH (`web3.service.ts:166-182` semantics), re-expressed on viem error classes; the queue treats anything not explicitly non-retryable as retryable with backoff (AI-DLH backoff table `[1 m, 5 m, 30 m]`, max attempts 5 — chain-action attempts are distinct from RBF replacements, which ride *inside* one attempt):

| viem error (walked via `err.walk()`) | Class | Action |
|---|---|---|
| `ContractFunctionRevertedError` (simulation) | non-retryable | never broadcast; intent → `parked` with decoded revert; nonce **not** leased (simulate before journal) |
| receipt `status = 0` (on-chain revert) | non-retryable | → `reverted` (nonce consumed); alert; compensation is a new business decision |
| `InsufficientFundsError` | retryable | wallet-monitor alert (top-up); backoff |
| `NonceTooLowError` on broadcast | resolve | hash-set lookup: ours mined ⇒ `mined`; foreign ⇒ incident (§2.3.5) |
| replacement underpriced (`ReplacementUnderpricedError` / RPC -32000 text match) | resolve | recompute §4 fees, re-replace (counts toward ceiling) |
| `TransactionNotFoundError` during receipt poll | retryable | keep polling until attempt timeout, then RBF |
| `HttpRequestError`, `TimeoutError`, `RpcRequestError` 5xx/429 | retryable | backoff; sustained ⇒ RPC-health alert (distinct from fee-estimation alert) |
| `FeeCapTooHighError` / local cap breach | non-retryable | `parked` — config problem, not market problem |
| anything unrecognized | retryable | backoff; after max attempts → `parked` + alert (never silent) |

Parking is always **loud** (alert + runbook link) and always **evidence-preserving** (`last_error`, full hash set, fee history in the row). Nothing is ever deleted to "clean up".

## 7. Interfaces & wiring

### 7.1 `SignerAccount` — the env-key / KMS seam

```ts
interface SignerAccount {
  readonly address: `0x${string}`;
  signTransaction(tx: PreparedTx): Promise<`0x${string}`>;  // returns signed raw bytes
}
// v1: LocalSignerAccount   — viem privateKeyToAccount(env.OPERATOR_PRIVATE_KEY)
// vNext: KmsSignerAccount  — AWS KMS secp256k1 sign; key never leaves the HSM
```

`TxSubmitter` depends only on this interface (constructor argument). Local signing keeps §2.2's "sign inside the DB transaction" cheap; the KMS implementation adds one network hop there — acceptable, and the lease window stays small because signing is the only I/O inside the transaction. No other component may hold or see key material.

### 7.2 BullMQ-as-dispatcher over Postgres-as-SoR

- **Queues:** `tx.{chainId}` (worker concurrency 1 per `(chain, signer)`), `outbox.resolve`, `janitor` (repeatable). Job id = `"{kind}:{payoutId}"` — deterministic, so Redis-level dedup mirrors the DB unique constraint instead of replacing it.
- **Claim helpers** (from AI-DLH, generalized): single-row conditional `UPDATE … WHERE id = $1 AND state = ANY($claimable) AND (locked_at IS NULL OR locked_at < now() - stale) … RETURNING`; batch claim via `FOR UPDATE SKIP LOCKED`. A BullMQ redelivery that loses the claim exits silently — duplicate delivery is a no-op by design, not by hope.
- **Janitor:** §3.3 sweep as a repeatable job; also re-enqueues `created`/eligible rows with no live job. This is the `FLUSHALL`-healing mechanism: Redis is a performance cache of "what should run soon", reconstructible from Postgres at any time.
- **Observability hooks:** every state transition emits a span event on the payout's trace (baggage-carried `payout_id`), plus the §4/§6 counters and a `stablerails.tx.state_age_seconds` gauge per state (the stuck-anything detector).

## 8. Anvil chaos test plan

All tests run against testcontainers-Postgres + Redis + anvil (Foundry). Each test states its **assertion** — what must be true, not what must merely not crash. These are the merge gate for the relayer PRs.

| # | Test | Setup / injection | Assertion |
|---|---|---|---|
| 1 | kill-9 between journal and broadcast | Crash hook after §2.2 commit, before `sendRawTransaction`; restart → sweep | Exactly **one** tx for the nonce on-chain (`getTransactionCount` delta = 1); intent reaches `confirmed`; no second signature exists (journal `tx_hash` unchanged) |
| 2 | kill-9 after broadcast, before state update | Crash hook after `sendRawTransaction` returns; restart | Sweep resolves by hash → `mined` without re-sign, without new nonce lease (`relayer_nonces.next_nonce` unchanged by recovery) |
| 3 | duplicate BullMQ delivery | Same job delivered twice concurrently (manual `add` with same payload, different job id to defeat Redis dedup) | Second delivery loses the DB claim and exits; one journal row, one broadcast |
| 4 | nonce-gap injection | Out-of-band tx from the same signer directly via anvil (simulates a foreign signer / incident) | Next broadcast hits `NonceTooLowError`-class resolution → incident path: queue pauses, resync runbook (§2.3) rehearsed by the test, `next_nonce` corrected, subsequent intents mine |
| 5 | base-fee spike | `anvil_setNextBlockBaseFeePerGas` ≫ first-attempt `maxFee` after broadcast | Replacement fires with `maxFee' = max(2×base+prio', old×1.25)` (both node rules satisfied — asserted on the raw tx fields); tx mines within M blocks |
| 6 | replacement exhaustion | Cap `per_chain_max_fee_cap` below spiked base fee | After 3 replacements: intent `parked`, `replacement_exhausted_total` +1, alert payload contains runbook link; **no** 4th signature |
| 7 | fee-estimation outage | Stub RPC: `eth_feeHistory` errors | `fee_estimation_failures_total` increments (distinct metric from #6); intent stays `created` (no nonce leaked); recovers when RPC heals |
| 8 | `FLUSHALL` Redis mid-payout | Flush between `journaled` and receipt | Janitor re-enqueues from Postgres; intent completes; `UNIQUE(payout_id, kind)` + nonce accounting show zero duplicates |
| 9 | crash between outbox-`unknown` and provider POST | Mock provider counts POSTs; crash hook after outbox commit, before POST; restart | Retry path performs **GET first** (mock records the GET), then exactly one POST total across both lives; `provider_operations` ends `succeeded` |
| 10 | crash after provider POST, before outcome recorded | Crash hook after mock accepts POST; restart | GET-resolve settles the `unknown` row from provider truth; **zero** re-POSTs (mock count stays 1) |
| 11 | reorg of a mined release | `evm_snapshot` before mine → `evm_revert` + re-mine different block (or `anvil_reorg` where available) | Intent falls `mined → broadcast`, `reorged_total` +1, re-confirms on the new chain; PIX gate (`final`) never opened on the orphaned block |
| 12 | reverted tx | Intent whose calldata reverts on-chain (mined, `status=0`) | → `reverted` terminal; nonce consumed (next intent gets n+1); alert emitted; no automatic retry of the same row |
| 13 | double-claim property test | fast-check: N concurrent claimers over M rows, random kill/timeouts | Every row claimed at most once per generation; attempts == claims; no row lost (liveness: all reach a terminal or claimable state) |

Tests 1, 2, 3, 5, 8, 13 gate the first relayer PR; the rest gate R3 completion.

---

## First PR for the relayer (proposal)

**PR #2 — `feat(relayer): intent journal, nonce allocator, submitter core (R2 + R3 core)`**

Scope: the §1–§4 + §6 core against anvil, single chain (Base Sepolia chain id via anvil), `SignerAccount` local implementation, BullMQ wiring minimal (one `tx` queue + janitor). Explicitly **out**: reorg/finality gate (B1 lands with the PIX bridge PR where it has a consumer), OpenPix outbox consumer (outbox *table* + GET-resolve protocol land now; the PIX worker adopts it in P-tasks), CCTP intents, KMS signer.

**Files**

| Path | Content |
|---|---|
| `apps/api/src/db/schema/relayer.ts` + hand-written migration | `tx_intents`, `relayer_nonces`, `provider_operations` (+ enforcement tests for uniques) |
| `apps/api/src/relayer/nonce-allocator.ts` | §2.2 lease-in-journal-tx |
| `apps/api/src/relayer/tx-submitter.ts` | §3.1 sign→hash→persist→send; receipt loop; RBF via §4 |
| `apps/api/src/relayer/fee-policy.ts` | §4 first-attempt + replacement math (pure functions) |
| `apps/api/src/relayer/error-taxonomy.ts` | §6 mapping (pure) |
| `apps/api/src/relayer/claims.ts` | conditional-UPDATE + `FOR UPDATE SKIP LOCKED` helpers |
| `apps/api/src/relayer/recovery.ts` | §3.3 sweep + §2.3 resync (behind an operator flag) |
| `apps/api/src/relayer/signer-account.ts` | interface + local impl |
| `apps/api/src/queues/{tx.queue,janitor}.ts` | BullMQ wiring, deterministic job ids |
| `apps/api/test/relayer/*.test.ts` | chaos tests **1, 2, 3, 5, 8, 13** + fee-math unit vectors + taxonomy table tests |
| `docs/runbooks/nonce-resync.md` | §2.3 as an operator document |
| CI | integration job gains anvil (foundry-toolchain) + testcontainers services |

**Acceptance criteria**

| # | Criterion |
|---|---|
| 1 | Chaos tests 1, 2, 3, 5, 8, 13 green in CI (not flake-quarantined) |
| 2 | Fee math: unit vectors prove replacement satisfies *both* the ≥+10% node rule and current-base-fee viability across calm/spike fixtures |
| 3 | grep/lint gate: `getTransactionCount` appears **only** in `recovery.ts`; no `Date.now`-based money/fee logic; no naked `process.env` |
| 4 | `pnpm turbo run lint typecheck test build` green; new tables covered by enforcement tests (unique violations, append-only where declared) |
| 5 | Every §6 taxonomy row has a table-driven test; unknown-error path proves park-with-alert after max attempts |
| 6 | Runbook `nonce-resync.md` exists and test 4's rehearsal follows it step-for-step (test comments cite runbook step numbers) |
