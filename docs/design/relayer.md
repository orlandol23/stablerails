# Relayer design (R2/R3) — v2, implementation-ready

> **Status:** design v2, pre-implementation. **Owner:** Orlando. **Inputs:** v1 of this doc + the full independent red-team (`stablerails-relayer-adversarial-review.md`, technical source) + `RELAYER-CORRECTIONS.md` (triage/scope overlay). The red-team **affirmed** the core posture (journal-before-broadcast; `SELECT … FOR UPDATE` nonce serialization; sign→persist→broadcast) and tore up the concurrency, reorg, and provider **details** — this revision adopts its corrected schemas and flows, with the testnet ⚑SIMPLIFY cuts applied.
>
> **This is a design doc, not code.** SQL is DDL-shape, TypeScript is interface-shape; names are binding, bodies are not.

## What changed vs. v1

1. **Payout ordering resolved (cross-doc):** v1 assumed release→then→PIX; the escrow's `refund` (requires `Funded`) makes that unrefundable after a PIX failure. **Adopted: funding-final → PIX → (success: `releaseToTreasury` / failure: `refund`)** (§1). The PIX gate is now a **funding-proof**, not a release-proof; `releaseToTreasury` is the post-PIX-success step. `escrow.md` already encodes refund-as-PIX-failure-compensation, so the two docs now agree; this supersedes the plan's §1 step 4–5 ordering and §2e's "release backs PIX" phrasing.
2. **Data model split** (review "architectural disagreements" §1–2, corrections A1/A2/A4): `tx_intents` no longer owns nonce mechanics or hash history. New tables: **`nonce_reservations`** (nonce ownership + replacement generations), **`tx_attempts`** (append-only — every signature is an immutable row; *no broadcast without an attempts row*), **`chain_event_proofs`** (decoded, finalized on-chain evidence — the review's `release_proofs` generalized to `funding|release|refund` after the §1 reordering), and the **`provider_operations` + `provider_attempts`** outbox split. Explicit idempotency keys (`business_action_id`, CCTP message keys) replace the blunt `UNIQUE(payout_id, kind)`.
3. **Two-phase first-signing** (I1): a *short* transaction reserves the nonce and creates a durable `reserved` row; signing happens **outside** the nonce `FOR UPDATE` lock (a KMS brownout can no longer wedge the whole `(chain, signer)` lane); the raw is persisted in a *fenced* transaction; only then broadcast-eligible.
4. **Allocator zero-row → ROLLBACK** (B1): the intent row is locked and re-verified *first*; any expected write touching 0 rows aborts the transaction — a nonce can never advance without a durable owned reservation.
5. **Fencing tokens everywhere** (A3): `lock_token` + `claim_generation` on every worker write, heartbeats on long operations, janitor included (I9). `locked_at` alone is stale-detection, not a fence.
6. **`ops.cancel_nonce` redesigned** (B2) as a **replacement of the existing nonce reservation** (`cancel` attempt on the same nonce), not a new intent — the old design could not even satisfy its own unique constraint.
7. **viem autofill forbidden** (B3): fully-specified EIP-1559 requests only; runtime assert before signing; decode-and-assert the **signed raw** before commit (I2); an RPC-spy test proves zero `eth_getTransactionCount` on the submit path.
8. **Reorg/finality model corrected** (D1/D2): `reverted` is not terminal until final (`mined_reverted → confirmed_reverted → reverted_final`); `confirmed` can reorg — `confirmed → submitted` exists and ledger postings at `confirmed` are provisional; money-moving effects key off `final`.
9. **PIX gate = `finalized`** (D3, ⚑SIMPLIFY: no `safe`-with-credit-caps mode — testnet just waits), and PIX requires **decoded event proof** (D4), not `status == 1`.
10. **Fee policy hardened** (C1–C5, I4–I6): per-chain-family **fee adapters** (Arbitrum ≠ generic EIP-1559), caps + affordability re-asserted on **every replacement** signature, integer bps bump math (`bigint × 1.25` throws), RBF may raise **gas** (not only fees), and replacement eligibility is **block-aware** (no budget burn during RPC/sequencer stall).
11. **Provider outbox contract** (E1/E2): `ambiguous ≠ failed`; transport ambiguity has its own state and horizon; per-provider contract table (idempotency key, GET consistency, terminal statuses) with the OpenPix entries marked VERIFY.
12. **Chaos plan rewritten**: assertions strengthened (decoded-fields, signer-spy zero-resign) and the review's missing cases added; **PR #2 gates on corrections-§F tests 1, 2, 3, 4, 10**.
13. Kept from v1 (affirmed sound, §H): journal-before-broadcast, `FOR UPDATE` nonce leasing, sign-before-persist-before-broadcast, the `max(2×baseFee + priority', bump(oldMaxFee))` replacement *direction*, Postgres-SoR/BullMQ-dispatch split, `SignerAccount` seam, wallet monitor, state-age observability. ⚑SIMPLIFY kept: single reliable RPC per chain (no quorum); `2×` base-fee headroom retained with corrected wording (covers ~5 full max-increase blocks, just short of 6 — C5).

---

**Design invariants (v2 — the review's six, verbatim in spirit; everything below serves them):**

1. **No nonce increment may commit unless an owned, durable reservation exists** (B1: zero-row writes force ROLLBACK).
2. **No signed raw tx may be broadcast unless an append-only `tx_attempts` row records it** (A2: a signed hash can never be lost).
3. **No stale worker may write without a matching fencing token + generation** (A3: losing the fence aborts *without broadcasting*).
4. **No PIX approval may rest on `safe` or on receipt status alone** — only on a **finalized, decoded funding proof** (D3/D4, reordered per §1).
5. **No provider ambiguity may be recorded as `failed`** — transport ambiguity stays `ambiguous`, and nothing compensates from `ambiguous` (E1).
6. **No viem helper may source nonce or fees from RPC on the submit path** — the DB and the fee policy are the only sources (B3).

Plus the standing pair: Postgres is the only system of record (Redis/BullMQ may be flushed at any moment); nothing irreversible happens on the strength of a block that can still disappear.

---

## 1. Payout ordering: funding-final → PIX → release | refund

The v1 flow (release, then PIX) had a hole neither red-team pass owned but both circled: if PIX fails **after** `releaseToTreasury`, the escrow payout is `Released` and `refund()` (which requires `Funded`) can never run — compensation would need funds pushed back *into* the escrow out-of-band. The escrow design already models `refund` as *the* PIX-failure path, which forces the ordering:

```
fund (Permit or CCTP attribution)          on-chain, intent lifecycle §2.3
   └─ funding proof FINALIZED (§5)         chain_event_proofs(kind='funding')
        └─ PIX create → approve            outbox §6, gate §5
             ├─ MOVEMENT_CONFIRMED  → releaseToTreasury intent → release proof → ledger settlement
             └─ MOVEMENT_FAILED     → refund intent (escrow still Funded ✓) → refund proof → ledger reversal
```

Consequences, made explicit:

- **The escrow holds the collateral for the entire PIX window.** USDC leaves escrow only after BRL is confirmed delivered (or back to the merchant on failure). This is strictly better custody semantics than v1 — the treasury never fronts anything.
- **The PIX gate is a funding proof**: the fund tx (`fundWithPermit`) or attribution tx (`fundFromCCTP`) must be **finalized** and its decoded `Funded(payoutId, merchant, amount, source)` event must match the payout (§5). The review's `release_proofs` shape survives as the generalized `chain_event_proofs` (§2.6); a `release`-kind proof now gates the *ledger settlement posting*, and a `refund`-kind proof gates the reversal.
- **`releaseToTreasury` inherits everything in this doc** (intents, reservations, attempts, reorg tracking) but sits *after* the irreversible step — a reorged release is treasury-accounting noise handled by proofs + reconciler, never pay-without-collateral.
- Supersedes: plan §1 steps 4–5 ordering and §2e's "no PIX without a confirmed release" rule (now: "no PIX without a **finalized funding proof**"). `escrow.md` needs no change (its §2.4 already says refund = PIX-failure compensation).

## 2. Data model

Seven tables. `tx_intents` is the business ledger of *what should happen*; `nonce_reservations` owns *which account slot executes it*; `tx_attempts` is the immutable record of *every signature*; `chain_event_proofs` is *what provably happened*; the outbox pair owns *provider side-effects*. Wei/gas columns are `numeric(78,0)`; app layer is `bigint` end-to-end (tests above `Number.MAX_SAFE_INTEGER`; lint bans `Number(...)` on wei fields).

### 2.1 `tx_intents` — business intent only

```sql
CREATE TABLE tx_intents (
  id                   uuid PRIMARY KEY,            -- uuidv7; BullMQ job id embeds this (I8)
  business_action_id   text NOT NULL UNIQUE,        -- explicit idempotency key (A4), e.g.
                                                    --   'payout:{payoutId}:fund' | 'payout:{payoutId}:release'
                                                    --   'payout:{payoutId}:refund' | 'cctp:{srcDomain}:{msgNonce}:attribute'
  payout_id            uuid,                        -- nullable: ops intents have none
  kind                 text NOT NULL,               -- 'escrow.fund_with_permit' | 'escrow.fund_from_cctp'
                                                    -- | 'escrow.release_to_treasury' | 'escrow.refund'
  chain_id             integer NOT NULL,
  signer               text NOT NULL,
  state                text NOT NULL,               -- §2.3
  nonce_reservation_id uuid,                        -- set when reserved (§3.1 phase 1)
  blocked_on_intent_id uuid,                        -- I10: optional dependency edge (unused in v1 flows)
  cctp_message_nonce   numeric(78,0),
  cctp_source_domain   integer,
  attempts             integer NOT NULL DEFAULT 0,  -- incremented AT CLAIM TIME (AI-DLH semantics)
  locked_at            timestamptz,
  lock_token           uuid,                        -- fencing (A3)
  claim_generation     bigint NOT NULL DEFAULT 0,   -- fencing (A3)
  next_attempt_at      timestamptz,
  last_error           text,
  sim_block_hash       text,                        -- I7: simulation evidence
  sim_revert_reason    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (signer ~ '^0x[0-9a-f]{40}$')
);
CREATE UNIQUE INDEX ON tx_intents (cctp_source_domain, cctp_message_nonce)
  WHERE cctp_message_nonce IS NOT NULL;             -- one attribution per CCTP message (A5, plan)
CREATE INDEX ON tx_intents (state, next_attempt_at);
CREATE INDEX ON tx_intents (chain_id, signer, state);
```

### 2.2 `relayer_nonces` + `nonce_reservations` — nonce ownership

```sql
CREATE TABLE relayer_nonces (
  chain_id                integer NOT NULL,
  signer                  text NOT NULL,
  next_nonce              bigint NOT NULL,
  initialized_at          timestamptz NOT NULL,     -- bootstrap is a RUNBOOK, not a side effect (I3)
  initialized_from_latest bigint NOT NULL,
  initialized_from_pending bigint NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, signer),
  CHECK (signer ~ '^0x[0-9a-f]{40}$')
);

CREATE TABLE nonce_reservations (
  id                   uuid PRIMARY KEY,
  chain_id             integer NOT NULL,
  signer               text NOT NULL,
  nonce                bigint NOT NULL,
  owner_intent_id      uuid NOT NULL REFERENCES tx_intents(id),
  state                text NOT NULL,               -- reserved | signed | submitted | settled
                                                    -- | cancel_journaled | cancel_submitted | cancelled
  current_attempt_id   uuid,                        -- pointer only; history lives in tx_attempts
  replacement_count    integer NOT NULL DEFAULT 0,  -- GLOBAL per reservation (retry-storm cap)
  signed_attempt_count integer NOT NULL DEFAULT 0,  -- GLOBAL per reservation; DB hard cap before signing
  cancel_requested_at  timestamptz,
  cancel_reason        text,
  lock_token           uuid,
  claim_generation     bigint NOT NULL DEFAULT 0,
  locked_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, signer, nonce),
  CHECK (signer ~ '^0x[0-9a-f]{40}$')
);
```

**Workers fail closed** if the `relayer_nonces` row for their `(chain, signer)` is absent (I3) — no implicit RPC-seeded initialization, ever. Bootstrap runbook (`docs/runbooks/nonce-bootstrap.md`): pause queues → read `latest` **and** `pending` (⚑SIMPLIFY: on the single configured RPC) → assert no unknown pending tx for the signer → `INSERT` the row once with an `audit_events` entry recording both readings → unpause.

### 2.3 Intent states (business lifecycle)

```
created ─▶ reserved ─▶ submitted ─▶ mined ──────────▶ confirmed ──────────▶ final
                          ▲  │          │ (status=0)      │ (status=0)
                          │  │          ▼                 ▼
                          │  │      mined_reverted ─▶ confirmed_reverted ─▶ reverted_final
                          │  │          │                 │
                          │  └──────────┴─────────────────┘  reorg (block hash gone) → submitted
                          │
    created/reserved ─▶ parked (operator)        reservation cancelled ─▶ cancelled_final
    ambiguity ─▶ unknown ─resolve─▶ mined | submitted | parked
```

| State | Meaning / rules |
|---|---|
| `created` | Intent exists; no nonce. A fee-estimation outage leaves intents here — **nonce-safe, and later intents may advance past it** (I10 decision: cross-payout ordering does not matter; intra-payout ordering is enforced by business preconditions — fund → PIX outcome → release/refund — not by nonce sequencing. `blocked_on_intent_id` exists for future dependency needs and is unused in v1.) |
| `reserved` | Durable `nonce_reservations` row owns a nonce for this intent (§3.1 phase 1). Crash here is recoverable: the reservation is visible, the janitor resumes at signing. |
| `submitted` | ≥1 attempt broadcast-accepted by the RPC (v1's `broadcast`, renamed — one RPC accepting ≠ network propagation). |
| `mined` / `mined_reverted` | Receipt observed (`status` 1/0) at `block_hash` (stored). **Both** remain reorg-checked: block-hash vanishes → back to `submitted` (D1/D2). |
| `confirmed` / `confirmed_reverted` | Depth ≥ `confirmation_depth` **and** stored block-hash still canonical. **Still reorgable** — `confirmed → submitted` exists (D2). Ledger postings here are *provisional* (append-only compensating entries on reorg); money-moving postings wait for `final`. |
| `final` / `reverted_final` | `finalized` tag (or `depth_final` fallback) reached; canonical re-check passed. Terminal. **Only `reverted_final` may trigger business compensation** (D1 — a reverted receipt can reorg into a success; compensating earlier double-pays). |
| `unknown` | Post-send ambiguity (crash, RPC error after send). Resolver scans the **full `tx_attempts` hash set** for the reservation (B5) — never re-signs until every prior hash is accounted for. |
| `parked` | Operator required: replacement/signing caps, affordability rejection, deterministic sim revert, foreign-nonce incident. Loud (alert + runbook), evidence-preserving. |
| `cancelled_final` | The reservation's `cancel` attempt finalized; the business intent was explicitly abandoned (B2, §3.4). |

### 2.4 `tx_attempts` — append-only signature record (A2)

```sql
CREATE TABLE tx_attempts (
  id               uuid PRIMARY KEY,
  reservation_id   uuid NOT NULL REFERENCES nonce_reservations(id),
  intent_id        uuid NOT NULL REFERENCES tx_intents(id),
  attempt_no       integer NOT NULL,
  replacement_kind text NOT NULL,                   -- original | rbf | cancel
  chain_id         integer NOT NULL,
  signer           text NOT NULL,
  nonce            bigint NOT NULL,
  tx_hash          text NOT NULL,
  raw_tx           text NOT NULL,
  decoded_to       text NOT NULL,                   -- I2: decoded-from-raw, not echoed-from-request
  decoded_value    numeric(78,0) NOT NULL,
  decoded_data_hash text NOT NULL,
  max_fee_per_gas  numeric(78,0) NOT NULL,
  max_priority_fee_per_gas numeric(78,0) NOT NULL,
  gas_limit        numeric(78,0) NOT NULL,
  signed_at        timestamptz NOT NULL,
  broadcast_at     timestamptz,                     -- NULL until the RPC accepted it
  rpc_response     jsonb,
  UNIQUE (reservation_id, attempt_no),
  UNIQUE (chain_id, tx_hash),
  CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  CHECK (tx_hash ~ '^0x[0-9a-f]{64}$')
);
```

Rows are never updated except `broadcast_at`/`rpc_response`, never deleted. **Rule (invariant 2): broadcast happens only after this row's transaction committed.** The unknown-resolver, receipt poller, and resync all scan attempts — a signed hash is structurally unlosable, which is what makes concurrent RBF with a stale worker safe (the stale worker's fenced write fails, its signature is discarded *before* broadcast).

### 2.5 Provider outbox — `provider_operations` + `provider_attempts` (E1/E2)

```sql
CREATE TABLE provider_operations (
  id                 uuid PRIMARY KEY,
  payout_id          uuid NOT NULL,
  provider           text NOT NULL,                 -- 'openpix'
  operation          text NOT NULL,                 -- 'payment.create' | 'payment.approve'
  correlation_id     text NOT NULL,                 -- provider-side identity (= payoutId)
  idempotency_key    text NOT NULL,                 -- what the provider actually dedupes on (VERIFY, §6.2)
  status             text NOT NULL,                 -- §6.1 state machine
  request_digest     text NOT NULL,                 -- canonical serialization + schema version
  ambiguity_deadline timestamptz,                   -- provider-specific "definitely absent" horizon
  last_get_status    text,
  post_attempt_count integer NOT NULL DEFAULT 0,
  resolved_at        timestamptz,
  response_snapshot  jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, provider, operation),
  UNIQUE (provider, operation, correlation_id)      -- the provider's real identity axis
);

CREATE TABLE provider_attempts (
  id                uuid PRIMARY KEY,
  operation_id      uuid NOT NULL REFERENCES provider_operations(id),
  attempt_no        integer NOT NULL,
  method            text NOT NULL,                  -- GET | POST
  request_digest    text,
  started_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  transport_status  text,                           -- ok | timeout | reset | http_5xx | http_4xx ...
  http_status       integer,
  response_snapshot jsonb,
  UNIQUE (operation_id, attempt_no)
);
```

Digest discipline: the request body is canonically serialized (stable key order, schema version inside the digest input); before **any** POST — first or retry — the worker re-computes and asserts equality with the stored `request_digest`; mismatch → park + alert, never POST (a retry must be byte-identical in business content or it is a different operation).

### 2.6 `chain_event_proofs` — decoded, finalized evidence (D4; review's `release_proofs`, generalized)

```sql
CREATE TABLE chain_event_proofs (
  id               uuid PRIMARY KEY,
  proof_kind       text NOT NULL,                   -- 'funding' | 'release' | 'refund'
  payout_id        uuid NOT NULL,
  intent_id        uuid REFERENCES tx_intents(id),  -- nullable: proofs are re-derivable from chain alone
  chain_id         integer NOT NULL,
  tx_hash          text NOT NULL,
  block_hash       text NOT NULL,
  block_number     bigint NOT NULL,
  log_index        integer NOT NULL,
  contract_address text NOT NULL,                   -- must equal the registered escrow address
  event_signature  text NOT NULL,                   -- Funded / Released / Refunded topic0
  token            text NOT NULL,
  amount           numeric(78,0) NOT NULL,          -- decoded from the LOG (net amount for CCTP fundings)
  counterparty     text NOT NULL,                   -- merchant (funding/refund) | treasury (release)
  finality_mode    text NOT NULL,                   -- 'finalized' | 'depth_final'
  finalized_at     timestamptz NOT NULL,
  UNIQUE (chain_id, tx_hash, log_index),
  UNIQUE (proof_kind, payout_id)                    -- one finalized proof per kind per payout
);
```

A proof row is written **only** by the proof worker: fetch receipt at the stored block-hash → assert canonical + finalized → decode the expected event from the expected contract → assert every field against the payout row. Consumers (PIX gate §5, ledger postings) read proofs, **never** intent state strings — evidence over state (review architectural point 3).

## 3. Flows

### 3.1 First signing — two-phase (I1, B1, B3, I2)

**Phase 0 — claim + simulate.** Claim the intent with a fresh `lock_token` and incremented `claim_generation` (attempts++ at claim, AI-DLH semantics). Simulate only if business prerequisites are final; **classify** the revert (I7): deterministic business invalidity (e.g. `AlreadyReleased`) → `parked`; missing prerequisite / stale state / dependency-not-final → retryable backoff; unknown → bounded retry, then park with evidence. Persist `sim_block_hash` + `sim_revert_reason` either way. Gas policy runs here: `gas = ceil(simEstimate × gas_multiplier)`, assert `gas ≤ gas_hard_cap` (I4).

**Phase 1 — reserve (short transaction, no external I/O inside):**

```sql
BEGIN;
  SELECT * FROM tx_intents WHERE id = $intent FOR UPDATE;          -- lock the intent FIRST (B1)
  -- verify: state='created' AND lock_token=$token AND claim_generation=$gen; else RAISE → ROLLBACK
  SELECT next_nonce FROM relayer_nonces
    WHERE chain_id=$c AND signer=$s FOR UPDATE;
  UPDATE relayer_nonces SET next_nonce = next_nonce + 1, updated_at = now()
    WHERE chain_id=$c AND signer=$s;                               -- must affect 1 row, else RAISE
  INSERT INTO nonce_reservations (id, chain_id, signer, nonce, owner_intent_id, state)
    VALUES ($rid, $c, $s, $leased, $intent, 'reserved');
  UPDATE tx_intents SET state='reserved', nonce_reservation_id=$rid
    WHERE id=$intent AND state='created'
      AND lock_token=$token AND claim_generation=$gen;             -- must affect 1 row, else RAISE
COMMIT;
```

The transaction helper **raises (→ ROLLBACK) on any statement affecting an unexpected row count** — invariant 1: the nonce cannot advance without a durable owned reservation. A crash after commit leaves an orphaned-but-durable `reserved` reservation; the janitor resumes it at phase 2 (this is the accepted cost of not holding the lock during signing).

**Phase 2 — sign outside every DB lock (I1):** build the request **fully specified from DB/policy values only** (B3): `{chainId, from, to, data, value, gas, nonce, maxFeePerGas, maxPriorityFeePerGas, type:'eip1559'}` — viem's `prepareTransactionRequest` autofills nonce/fees/gas/type by default and is therefore **banned** on this path (at most `parameters: ['gas','type']` if ever used; v1 uses none). Runtime-assert all four critical fields equal the DB values immediately before `signTransaction`. Then sign via `SignerAccount` (env-key or KMS — the KMS network hop now happens lock-free).

**Phase 3 — decode + persist (fenced):** decode the **signed raw bytes** and assert every field (I2): recovered `sender == signer`, `chainId`, `nonce == leased`, `to/data/value/gas/maxFee/maxPriority` equal the request, recomputed `keccak256(raw) == tx_hash`. Then, in one transaction guarded by `WHERE lock_token=$token AND claim_generation=$gen` on the reservation: `INSERT tx_attempts (attempt_no=1, replacement_kind='original', …)`, `UPDATE nonce_reservations SET current_attempt_id, state='signed', signed_attempt_count = signed_attempt_count + 1` (hard-cap-checked in the same statement). **Zero rows → the fence was lost → discard the signature and abort — never broadcast** (invariant 3).

**Phase 4 — broadcast:** `eth_sendRawTransaction(raw)`. On acceptance (incl. "already known"), fenced-update `broadcast_at`, reservation `state='submitted'`, intent `state='submitted'`. Re-sending identical raw bytes is idempotent at the node (§H affirmed) — replay after crash re-runs phase 4 only.

### 3.2 Receipt tracking, reorgs, finality (D1/D2)

The receipt poller scans **all attempts of the reservation** (the full hash set from `tx_attempts` — B5): any hash mined settles the reservation. On a receipt: store `block_hash/number/status`, intent → `mined` or `mined_reverted`. Depth checks **re-verify the stored block-hash is canonical** at every promotion (`mined→confirmed→final`, same for the reverted track); a vanished hash demotes to `submitted` (the raw may re-mine on the new branch — including a formerly-reverted tx now *succeeding*, which is exactly why `reverted` cannot be terminal before `final`, D1). Promotions to `final`/`reverted_final` use the `finalized` block tag where the chain supports it, else `depth ≥ finality_depth` (`finality_mode` recorded). Ledger postings at `confirmed` are provisional and reversible by append-only compensating entries; **money-moving postings and all business compensation key off `final`/`reverted_final` only.**

### 3.3 RBF — replacement flow (C1–C3, I4, I5)

Driven by the **janitor sweep, not BullMQ timers** (corrections §G, adopted — Postgres is where eligibility state lives):

1. **Eligibility (block-aware, I5):** attempt older than the per-chain attempt window **and** new blocks have been produced since `broadcast_at` **and** head timestamp is advancing **and** the RPC is healthy **and** no attempt hash is mined. During an RPC outage or sequencer pause nothing is eligible — replacement budget is not consumed while the chain is stalled.
2. Claim reservation + intent (fenced); resolve the full attempt hash set first — any mined hash exits to §3.2.
3. Fee quote via the **chain-family adapter** (§4): `priority' = bump(priority_prev, bump_bps)`, `maxFee' = max(2×currentBaseFee + priority', bump(maxFee_prev, bump_bps))` — bumping **from the exact fee fields of the attempt being replaced** (C3). Optionally raise `gas` within `gas_hard_cap`, calldata identical (I4).
4. **Caps + affordability, re-asserted before every replacement signature (C1):** `maxFee' ≤ per_chain_max_fee_cap`, `priority' ≤ priority_cap`, `gas × maxFee' ≤ max_eth_at_risk_per_tx`, signer balance covers worst case; any failure → `parked` **before** signing (test: cap breach produces **no** signature).
5. Global caps: `replacement_count < replacement_ceiling (3)` and `signed_attempt_count < signed_attempt_ceiling` enforced **in the DB update** — BullMQ retry storms cannot multiply signatures past the DB cap.
6. Sign outside locks → decode-assert → append `tx_attempts (replacement_kind='rbf')` fenced → broadcast → fenced pointer update. If the **old hash mines after the replacement was signed but before/after its broadcast**, the receipt resolver (scanning all attempts) settles on the mined hash; the replacement either never broadcasts (fence) or becomes a harmless same-nonce loser. `onReplaced` from `waitForTransactionReceipt` is a **hint only** (C4) — classification is confirmed against our own attempt rows (nonce, signer, to, data-hash, value, intent id), and "cancelled" is believed only if a DB-approved cancel attempt exists.

### 3.4 Cancellation — reservation replacement (B2)

`ops.cancel_nonce` is **not an intent**: the wedged intent already owns `(chain, signer, nonce)`. Cancellation is a **replacement attempt on the existing reservation**: operator (runbook) sets `cancel_requested_at/reason` after explicitly abandoning the business intent → janitor signs a self-transfer of 0 ETH at the same nonce under the §3.3 fee/caps machinery, appended as `tx_attempts(replacement_kind='cancel')` → reservation `cancel_journaled → cancel_submitted → cancelled` when the cancel finalizes → intent `cancelled_final`. The abandoned business action, if still wanted, becomes a **new** intent with a **new** `business_action_id` sequence — never a reuse of the cancelled row.

### 3.5 Recovery, janitor, bootstrap, resync (I3, I9, B4)

- **Janitor** (repeatable job) claims with the **same fencing** as workers (I9): re-enqueue `created` rows with no live job (Redis flushed); resume orphaned `reserved` reservations at phase 2; re-broadcast `signed`-but-unbroadcast attempts (identical raw — **not** a new business attempt, no counter increment); move `submitted` rows past `receipt_poll_deadline` (separate knob from `claim_stale_after`) to `unknown` **only if hash/generation still match**; heartbeat long operations (`locked_at` refresh under the same token).
- **Unknown-resolver:** resolve via the full `tx_attempts` hash set: receipt found (any attempt, any branch) → §3.2 states; raw replayable and nonce not consumed → re-broadcast; account nonce advanced past the reservation with **no owned hash canonical** → foreign-nonce **incident**, park + pause lane (B5: `nonce too low` is a trigger, never proof).
- **Bootstrap** (I3): §2.2 runbook; workers fail closed without the row.
- **Resync** (B4, runbook `nonce-resync.md`): pause lane → settle in-flight → read `latest` **and** `pending` (⚑SIMPLIFY: single RPC) → map every nonce in `[latest_count, db_next)` to {canonical receipt | own pending hash | replayable raw | explicit abandon+cancel | foreign incident} → `pending > latest` with unknown hashes = **incident, not a gap** → never cancel a nonce owning a journaled raw unless the business intent is explicitly abandoned → set `next_nonce`, audit event, unpause.

## 4. Fee policy — per-chain-family adapters (A6 + C1–C5, I6)

```ts
interface FeePolicy {
  firstAttempt(ctx: QuoteCtx): Promise<FeeQuote>;     // {maxFeePerGas, maxPriorityFeePerGas}
  replacement(prev: AttemptFees, ctx: QuoteCtx): Promise<FeeQuote>;
  validateCaps(quote: FeeQuote, gasLimit: bigint, signerBalance: bigint): void; // throws → park
}
// Adapters: EthereumSepoliaFeePolicy, BaseSepoliaFeePolicy (OP-stack), ArbitrumSepoliaFeePolicy
```

- **First attempt** (all EVM adapters): `priority = clamp(p50(feeHistory(N).reward), floor, priority_cap)`; `maxFee = 2 × latestBaseFee + priority` — headroom covering ~5 full max-increase (+12.5%) blocks, just short of 6 (`1.125⁶ ≈ 2.03`; C5 wording fixed); `validateCaps` before signing.
- **Replacement:** §3.3 formula with **integer ceiling-division bps math only** (C2 — `bigint × 1.25` throws `TypeError`):

  ```ts
  const bump = (x: bigint, bps: bigint): bigint => (x * (10_000n + bps) + 9_999n) / 10_000n;
  ```

  `replacement_bump_bps` is **per chain/RPC config** (C3 — geth's 10% price-bump is node policy, not consensus; default 2500 bps to clear any sane node with margin); on a replacement-underpriced condition, escalate within caps.
- **Arbitrum Sepolia (I6):** its own adapter — Arbitrum's gas model (L1 data fee + L2 execution, gasLimit absorbing L1 costs) does not map onto the generic percentile policy; the adapter uses Arbitrum's estimation results as the quote source and applies the same cap/affordability discipline. Not a config knob on the generic policy — a separate implementation behind the interface.
- **Alerts (two failure domains, unchanged):** `fee_estimation_failures_total` (cannot price — RPC sick; intents stay `created`, nonce-safe) vs `replacement_exhausted_total` (market outran caps; reservation parked). Plus `fee_cap_rejections_total` for C1 affordability parks.

## 5. Finality & the PIX gate (D3/D4, reordered per §1)

PIX approval (`payment.approve` — the money-moving provider call) requires **all** of:

1. A `chain_event_proofs` row with `proof_kind='funding'` for the payout — decoded `Funded` event from the registered escrow address with `amount`, `counterparty=merchant`, `token=USDC`, `chainId` all matching the payout row (D4: `status==1` proves only no-revert; the decoded log proves the *effect*). For CCTP fundings the proof's amount **is** the net minted amount (plan A4).
2. `finality_mode='finalized'` on that proof (D3). ⚑SIMPLIFY: no `safe`-with-credit-caps mode exists in this system — testnet **waits**. Expected latency on Base Sepolia (`finalized` ≈ L1-anchored, ~10–20 min) is accepted and *shown* in the dashboard timeline (the pending→finalized progression is itself a demo beat). `depth_final` fallback only for chains without the tag.
3. The provider operation is not `ambiguous` (§6).
4. A **canonical re-check within a latency budget** immediately before the POST: re-fetch the funding receipt, assert `blockHash == proof.block_hash` and still finalized; persist `checked_block_hash/number, checked_at, approve_post_started_at`; metric `pix_approval_after_chain_check_latency_ms`; if the budget is exceeded between check and POST, re-check first.
5. The outbox row (with digest) committed before the POST (§6).

Post-PIX (§1): `MOVEMENT_CONFIRMED` (webhook verified per plan B3, or the polling backstop) → enqueue the `escrow.release_to_treasury` intent; its finalized `release` proof gates the ledger settlement posting. `MOVEMENT_FAILED` (provider-declared terminal — never inferred from transport) → enqueue `escrow.refund`; the escrow is still `Funded`, so refund works by construction; its finalized `refund` proof gates the ledger reversal.

## 6. Provider outbox — states & contracts (E1/E2)

### 6.1 Operation state machine

```
created_unknown ─▶ post_inflight ─▶ accepted ─▶ succeeded
                        │               │
                        │               └─▶ business_failed      (provider-declared terminal ONLY)
                        └─▶ ambiguous ◀─────┘ (transport: timeout/reset/5xx/429 after send)
                               │
                               └─▶ operator_review               (ambiguity horizon exceeded)
```

Rules (invariant 5): only an explicit provider terminal rejection becomes `business_failed`; every transport failure after the POST left the process is `ambiguous`; **no compensation, retry-on-alternate-path, or refund is ever driven from `ambiguous`**; `ambiguous` resolves only by GET (`succeeded`/`accepted`/`business_failed` per provider truth) or escalates to `operator_review` at `ambiguity_deadline`.

### 6.2 Per-provider contract (the E2 requirement)

GET-before-re-POST is exactly-once only under a **stated provider contract**. The contract is config + a doc table per provider; the OpenPix row ships with the PIX PR and these entries **must be verified in the sandbox first** (extends PLAN-CORRECTIONS §C):

| Contract item | OpenPix (to VERIFY) |
|---|---|
| Idempotency key | `correlationID` — confirm the API rejects (not duplicates) a re-POST of an existing `correlationID`, for both `payment.create` and `payment.approve` |
| GET consistency | `GET /api/v1/payment/{correlationID}` — measure read-after-write lag in sandbox; a 404 within the lag window is **not** "absent" |
| "Definitely absent" horizon | `ambiguity_deadline = created_at + horizon`; horizon = measured RAW lag × safety factor (default 10 min until measured) |
| Terminal statuses | `CONFIRMED` (succeeded), `FAILED` (business_failed) — per the documented payment state machine |
| Retry horizon | how long a `create`d payment stays approvable before provider-side expiry |

Until verified: `unknown/ambiguous + GET 404` **keeps polling until the horizon** — it never re-POSTs on a single stale 404 (the review's double-approve scenario), and never marks `failed` from transport evidence.

## 7. Error taxonomy — conditions + phases (C4, I7, review §6)

Two classification axes, both persisted with the error:

**Axis 1 — side-effect phase** (what a retry may do):

| Phase | Retry rule |
|---|---|
| `pre_sign` | free retry (no side effect exists) |
| `post_sign_pre_persist` | discard signature, retry from phase 1 (fence prevents its broadcast) |
| `post_persist_pre_send` | replay the **same raw** only (janitor path) |
| `send_ambiguous` | → `unknown`; resolve the full hash set; **never re-sign until every prior hash is accounted** |
| `post_send` | normal receipt tracking owns it |

**Axis 2 — condition** (matched by walking viem `BaseError.walk()` + JSON-RPC error code + normalized message + provider data — **never** by assuming a stable error class; `ReplacementUnderpricedError` is not a documented viem class):

| Condition | Class | Action |
|---|---|---|
| simulation revert — deterministic business invalidity (decoded: `AlreadyReleased`, `PayoutExists`…) | non-retryable | park pre-lease (no nonce consumed); I7: only after classification |
| simulation revert — missing prerequisite / stale state | retryable | backoff; re-simulate (bounded), then park with evidence |
| on-chain `status=0` | — | `mined_reverted` track (§3.2); compensation only at `reverted_final` (D1) |
| insufficient funds | retryable | wallet-monitor alert; backoff |
| nonce-too-low condition | resolve | full hash-set resolution (B5); foreign only after proof |
| replacement-underpriced condition | resolve | escalate bump within caps (C3), counts toward ceiling |
| fee-cap / affordability rejection (ours) | non-retryable | park **before** signing (C1) |
| RPC transport (timeout/5xx/429/reset) | retryable | backoff + RPC-health alert; if post-send → `send_ambiguous` |
| unrecognized | retryable | backoff; park + alert after max attempts; phase axis still applies |

## 8. Interfaces & wiring

- **`SignerAccount`** unchanged from v1 (env-key now, KMS later) — with I1, KMS latency is lock-free by construction, so the seam costs nothing operationally.
- **`FeePolicy`** per §4 — three adapters, one interface; the submitter never computes fees itself.
- **BullMQ (I8):** job id = `tx:{chainId}:{signer}:{intentId}` — unique across chains/signers/intents; the DB (`business_action_id`, reservation uniques) owns semantic idempotency, Redis ids only address rows. Queues: `tx.{chainId}` (concurrency 1 per `(chain, signer)` — throughput choice, not correctness), `outbox.resolve`, `janitor` (repeatable; owns RBF eligibility per §3.3).
- **Single-RPC posture (⚑SIMPLIFY):** one configured RPC per chain for send/receipt/fees; the design keeps the seam (all RPC access behind one client per chain) so quorum/cross-check can be added without refactoring, but v1 does not build it.
- **Observability:** unchanged from v1 (state-age gauges per state incl. the new reverted/ambiguous states, wallet monitor, trace baggage), plus §4's three fee alerts and `pix_approval_after_chain_check_latency_ms`.

## 9. Chaos test plan (anvil + testcontainers)

Assertion upgrades from the review baked in: nonce-delta is never the only assertion (decode the mined tx and match `to/data/value/nonce` + expected event); "no re-sign" is proven by a **signer spy** (count `signTransaction` calls; raw byte-equality with the journal), not by nonce inspection.

| # | Test (— = corrections §F number) | Assertion |
|---|---|---|
| F1 | **Allocator zero-row rollback** — intent state mutates between claim and phase-1; the guarded update hits 0 rows | Transaction rolls back; `relayer_nonces.next_nonce` **unchanged**; no `nonce_reservations` row; intent untouched |
| F2 | **Zero nonce autofill** — RPC spy wraps the transport | Normal submit path performs **zero** `eth_getTransactionCount` calls; fully-specified request asserted at sign time |
| F3 | **Concurrent RBF, stale worker** — worker A signs a replacement, stalls; B reclaims (generation++), signs its own | A's fenced persist fails; A's signature is discarded **unbroadcast**; every broadcast hash exists in `tx_attempts`; no hash lost |
| F4 | **Old hash mines after replacement signed** — mine attempt 1 while attempt 2 awaits broadcast | Resolver settles on attempt 1's receipt; attempt 2 never causes a second business effect; reservation `settled` |
| F10 | **Replacement cap breach** — spike base fee above `per_chain_max_fee_cap` | `validateCaps` parks **before** signing; signer spy proves **no** new signature; `fee_cap_rejections_total` +1 |
| 5 | kill-9 between phase 1 and phase 3 | Orphaned `reserved` reservation resumed by janitor; exactly one broadcast tx; decoded fields match intent |
| 6 | kill-9 between phase 3 and phase 4 | Janitor replays identical raw (signer spy: 0 new signatures); `broadcast_at` set once |
| 7 | kill-9 after send, before state update | `send_ambiguous → unknown` → hash-set resolution → `mined`; no re-sign |
| 8 | duplicate BullMQ delivery (distinct job ids, same intent) | Loser fails the fenced claim; one reservation, one attempt |
| 9 | Redis `FLUSHALL` mid-payout (incl. an outbox op in `post_inflight`) | Janitor re-enqueues from Postgres; payout completes; outbox resolves via GET; zero duplicate POSTs |
| 10 | base-fee spike within caps | Replacement fees satisfy both `≥ bump(old)` and `≥ 2×base + priority'` (asserted on decoded raw); mines |
| 11 | **stalled chain / sequencer pause** (stop anvil mining) | Wall-clock passes but replacement budget is **not** consumed (I5); resumes after mining resumes |
| 12 | reorg after `mined` (snapshot/revert) | `mined → submitted`, re-mines, re-confirms; proof written only once finalized |
| 13 | **reorg after `confirmed` before `final`** | `confirmed → submitted`; provisional ledger postings compensated (append-only); PIX gate never opened |
| 14 | **reverted receipt reorgs, then succeeds** | `mined_reverted → submitted → mined → … final`; **no compensation ran** (it waits for `reverted_final`) |
| 15 | foreign pending nonce during resync | Resync classifies as incident; no blind cancel of a journaled nonce |
| 16 | cancel against owned nonce (B2) | Cancel is a replacement attempt on the same reservation; nonce consumed by the 0-value self-transfer; intent `cancelled_final` |
| 17 | decode-assert mismatch (I2 — corrupt a field between request and sign in test harness) | Phase 3 aborts before persist; nothing broadcast; alert |
| 18 | provider POST accepted + stale GET 404 (mock) | Stays `ambiguous`, keeps polling to horizon; **zero** re-POSTs; later GET-accepted → `succeeded` |
| 19 | provider 500/timeout after accepted POST | Status `ambiguous`, **never** `business_failed`; no compensation triggered |
| 20 | retry storm (BullMQ max attempts × RBF) | `signed_attempt_count` DB cap holds; total signatures ≤ cap regardless of queue retries |
| 21 | missing `relayer_nonces` row (I3) | Worker fails closed; no implicit initialization; alert |
| 22 | double-claim property test (fast-check) | Every row claimed at most once per generation; fenced writes from stale generations always fail |

---

## PR #2 proposal — `feat(relayer): intents, reservations, attempts, submitter core`

**Gate: chaos tests F1, F2, F3, F4, F10** (corrections §F first set) **plus** 5–8, 17, 20–22. Consumer-phase tests (13, 14, 18, 19 — reorg-ledger + outbox-provider) land with the PIX/ledger PRs that consume those designs, but their *schemas* (`chain_event_proofs`, outbox pair) ship now.

**Scope:** §2 schema (all seven tables + hand migrations + enforcement tests), §3 flows for a single chain (anvil), §4 Base/Ethereum adapters (Arbitrum adapter interface stubbed with explicit `NotImplemented` — it lands with the CCTP PR that first needs it), §7 taxonomy, §8 wiring, bootstrap/resync runbooks. **Out:** PIX gate consumer (§5), outbox consumer (§6 — table + GET-resolve protocol in; the OpenPix client adopts it in P-tasks), KMS signer, multi-RPC.

**Files**

| Path | Content |
|---|---|
| `apps/api/src/db/schema/relayer.ts` + hand migrations | `tx_intents`, `relayer_nonces`, `nonce_reservations`, `tx_attempts`, `chain_event_proofs`, `provider_operations`, `provider_attempts` + CHECK/unique enforcement tests |
| `apps/api/src/relayer/claims.ts` | fenced claim helpers (`lock_token`/`claim_generation`, heartbeat, stale reclaim) |
| `apps/api/src/relayer/nonce-allocator.ts` | §3.1 phase 1 (zero-row → ROLLBACK helper) |
| `apps/api/src/relayer/tx-builder.ts` | fully-specified request builder + pre-sign runtime asserts (B3) |
| `apps/api/src/relayer/raw-decode.ts` | §3.1 phase 3 decode-and-assert (I2) |
| `apps/api/src/relayer/tx-submitter.ts` | phases 2–4, receipt tracking §3.2, RBF §3.3, cancel §3.4 |
| `apps/api/src/relayer/fee/{policy.ts, ethereum.ts, base.ts, arbitrum.stub.ts, bump.ts}` | §4 adapters + integer bump math (unit vectors incl. rounding, caps, affordability) |
| `apps/api/src/relayer/error-taxonomy.ts` | §7 condition + phase classification (table-driven tests) |
| `apps/api/src/relayer/recovery.ts` + `janitor.ts` | §3.5 (fenced, heartbeat, identical-raw replay) |
| `apps/api/src/relayer/signer-account.ts` | interface + local impl + **signer spy** test double |
| `apps/api/test/relayer/*.test.ts` | the gate tests above (testcontainers PG/Redis + anvil + RPC spy transport) |
| `docs/runbooks/{nonce-bootstrap.md, nonce-resync.md}` | I3 + B4 as operator documents |
| CI | integration job gains anvil (foundry-toolchain) + testcontainers |

**Acceptance criteria**

| # | Criterion |
|---|---|
| 1 | Chaos tests **F1, F2, F3, F4, F10** green in CI (named exactly; not flake-quarantined), plus 5–8, 17, 20–22 |
| 2 | RPC-spy transport proves the submit path issues zero `eth_getTransactionCount` and zero fee-estimation calls outside the FeePolicy adapter |
| 3 | Signer-spy assertions in every crash test: recovery paths produce **zero** new signatures; replayed raw is byte-identical to `tx_attempts.raw_tx` |
| 4 | Every broadcast in every test is preceded (in the DB) by its `tx_attempts` row — asserted by a test-harness broadcast hook, not by convention |
| 5 | Fee math unit vectors: integer bump strictly exceeds bps threshold after rounding for adversarial values (1 wei, odd values, near-cap); `bigint`-only enforced by types + a lint rule banning `Number(` on wei fields |
| 6 | Grep/lint gates: `getTransactionCount` only in `recovery.ts`; `prepareTransactionRequest` absent from `src/relayer/`; no naked `process.env` |
| 7 | Enforcement tests: all unique indexes + CHECK constraints fire; `tx_attempts` UPDATE/DELETE denied by grants except `broadcast_at`/`rpc_response` |
| 8 | Runbooks exist; tests 15/16/21 cite runbook step numbers in comments |

