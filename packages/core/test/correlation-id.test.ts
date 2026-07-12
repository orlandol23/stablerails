import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CorrelationIdError,
  bytes32ToPayoutId,
  isPayoutId,
  newPayoutId,
  payoutIdToBytes32,
  uuidV7FromParts,
} from '../src/index.js';

const arbRandom = fc.uint8Array({ minLength: 10, maxLength: 10 });
const arbTimestamp = fc.integer({ min: 0, max: 2 ** 48 - 1 });

describe('newPayoutId', () => {
  it('produces a valid UUIDv7 (version and variant bits)', () => {
    const id = newPayoutId();
    expect(isPayoutId(id)).toBe(true);
    expect(id[14]).toBe('7'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(id[19]); // variant bits 0b10
  });

  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newPayoutId()));
    expect(ids.size).toBe(1000);
  });
});

describe('uuidV7FromParts', () => {
  it('is time-ordered: later timestamps sort lexicographically after earlier ones', () => {
    fc.assert(
      fc.property(arbTimestamp, arbTimestamp, arbRandom, arbRandom, (t1, t2, r1, r2) => {
        fc.pre(t1 !== t2);
        const [tLo, tHi] = t1 < t2 ? [t1, t2] : [t2, t1];
        expect(uuidV7FromParts(tLo, r1) < uuidV7FromParts(tHi, r2)).toBe(true);
      }),
    );
  });

  it('rejects timestamps outside the 48-bit range', () => {
    expect(() => uuidV7FromParts(-1, new Uint8Array(10))).toThrow(CorrelationIdError);
    expect(() => uuidV7FromParts(2 ** 48, new Uint8Array(10))).toThrow(CorrelationIdError);
  });
});

describe('bytes32 mapping', () => {
  it('round-trips: bytes32ToPayoutId ∘ payoutIdToBytes32 is the identity', () => {
    fc.assert(
      fc.property(arbTimestamp, arbRandom, (ts, random) => {
        const id = uuidV7FromParts(ts, random);
        expect(bytes32ToPayoutId(payoutIdToBytes32(id))).toBe(id);
      }),
    );
  });

  it('pads the uuid into the low 16 bytes', () => {
    const id = newPayoutId();
    const b32 = payoutIdToBytes32(id);
    expect(b32).toMatch(/^0x0{32}[0-9a-f]{32}$/);
    expect(b32.slice(34)).toBe(id.replaceAll('-', ''));
  });

  it('accepts uppercase input (checksummed logs) case-insensitively', () => {
    const id = newPayoutId();
    expect(bytes32ToPayoutId(payoutIdToBytes32(id).toUpperCase().replace('0X', '0x'))).toBe(id);
  });

  it('rejects non-payout bytes32 values', () => {
    // Not zero-padded.
    expect(() => bytes32ToPayoutId(`0x${'ff'.repeat(32)}`)).toThrow(CorrelationIdError);
    // Zero-padded but version nibble is 4 (a UUIDv4, not v7).
    const v4ish = `0x${'0'.repeat(32)}0189f7c8aaaa4bbb8ccc0123456789ab`;
    expect(() => bytes32ToPayoutId(v4ish)).toThrow(CorrelationIdError);
    // Not hex at all.
    expect(() => bytes32ToPayoutId('0xzz')).toThrow(CorrelationIdError);
  });
});
