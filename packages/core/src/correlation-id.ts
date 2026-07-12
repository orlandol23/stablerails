/**
 * Correlation ids. One id — the payout id — threads the entire rail:
 * API request → ledger transfer → on-chain events (`bytes32`) → OpenPix
 * `correlationID` → OTel `stablerails.payout.id`.
 *
 * Format: UUIDv7 (RFC 9562) — time-ordered, so ids sort by creation time
 * in Postgres indexes and in logs.
 *
 * On-chain mapping: the UUID's 16 bytes are the LOW 16 bytes of a
 * `bytes32` (i.e. `bytes32(uint256(uuid))`, high 16 bytes zero). The
 * inverse direction validates the padding and the UUID version/variant
 * bits, so a foreign `bytes32` can never be mistaken for a payout id.
 */

import { randomBytes } from 'node:crypto';

declare const payoutIdBrand: unique symbol;

/** A UUIDv7 string (lowercase, dashed). */
export type PayoutId = string & { readonly [payoutIdBrand]: true };

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_UNIX_MS_48_BIT = 2 ** 48 - 1;

export class CorrelationIdError extends Error {
  override name = 'CorrelationIdError';
}

export function isPayoutId(value: string): value is PayoutId {
  return UUID_V7_RE.test(value);
}

export function payoutId(value: string): PayoutId {
  if (!isPayoutId(value)) {
    throw new CorrelationIdError(`not a UUIDv7 payout id: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Deterministic UUIDv7 assembly from parts (exported for tests; production
 * callers use {@link newPayoutId}). Layout per RFC 9562 §5.7:
 * 48-bit big-endian unix-ms timestamp, 4-bit version (7), 12+62 random
 * bits, 2-bit variant (0b10).
 */
export function uuidV7FromParts(timestampMs: number, random: Uint8Array): PayoutId {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_UNIX_MS_48_BIT) {
    throw new CorrelationIdError(`timestamp out of 48-bit range: ${timestampMs}`);
  }
  if (random.length < 10) {
    throw new CorrelationIdError('need at least 10 random bytes');
  }
  const bytes = new Uint8Array(16);
  let ts = BigInt(timestampMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = 0x70 | ((random[0] as number) & 0x0f);
  bytes[7] = random[1] as number;
  bytes[8] = 0x80 | ((random[2] as number) & 0x3f);
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = random[3 + i] as number;
  }
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as PayoutId;
}

/** Mint a fresh payout id (UUIDv7, cryptographic randomness). */
export function newPayoutId(): PayoutId {
  return uuidV7FromParts(Date.now(), randomBytes(10));
}

/** A 0x-prefixed 32-byte hex string, as used in contract events. */
export type Bytes32 = `0x${string}`;

const BYTES32_RE = /^0x[0-9a-f]{64}$/;

/** `bytes32(uint256(uuid))`: uuid in the low 16 bytes, high 16 bytes zero. */
export function payoutIdToBytes32(id: PayoutId): Bytes32 {
  const hex = id.replaceAll('-', '');
  return `0x${'0'.repeat(32)}${hex}` as Bytes32;
}

/** Inverse of {@link payoutIdToBytes32}; rejects anything that is not a
 * zero-padded UUIDv7 (wrong padding, version, or variant). */
export function bytes32ToPayoutId(value: string): PayoutId {
  const normalized = value.toLowerCase();
  if (!BYTES32_RE.test(normalized)) {
    throw new CorrelationIdError(`not a bytes32 hex string: ${JSON.stringify(value)}`);
  }
  const body = normalized.slice(2);
  if (!body.startsWith('0'.repeat(32))) {
    throw new CorrelationIdError('bytes32 is not a zero-padded payout id');
  }
  const hex = body.slice(32);
  const candidate = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return payoutId(candidate);
}
