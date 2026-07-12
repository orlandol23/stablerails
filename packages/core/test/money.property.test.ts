import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addMicroUSDC,
  centavos,
  convertUsdcToBrl,
  formatBRL,
  formatUSDC,
  fxRate,
  microUSDC,
  parseBRL,
  parseUSDC,
  subMicroUSDC,
} from '../src/index.js';

// Comfortably above any real amount (1e15 micro-USDC = 1e9 USDC).
const MICRO_MAX = 10n ** 15n;
const arbMicro = fc.bigInt({ min: 0n, max: MICRO_MAX }).map((v) => microUSDC(v));
const arbCentavos = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((v) => centavos(v));
const arbRate = fc.bigInt({ min: 1n, max: 100n * 10n ** 8n }).map((v) => fxRate(v));

describe('money properties', () => {
  it('formatUSDC ∘ parseUSDC is the identity on micro-USDC', () => {
    fc.assert(
      fc.property(arbMicro, (amount) => {
        expect(parseUSDC(formatUSDC(amount))).toBe(amount);
      }),
    );
  });

  it('formatBRL ∘ parseBRL is the identity on centavos', () => {
    fc.assert(
      fc.property(arbCentavos, (amount) => {
        expect(parseBRL(formatBRL(amount))).toBe(amount);
      }),
    );
  });

  it('add then subtract is the identity (no drift)', () => {
    fc.assert(
      fc.property(arbMicro, arbMicro, (a, b) => {
        expect(subMicroUSDC(addMicroUSDC(a, b), b)).toBe(a);
      }),
    );
  });

  it('conversion floors: converted value never exceeds the exact product', () => {
    const DESCALE = 10n ** 12n; // micro (1e-6) × rate (1e-8) → centavos (1e-2)
    fc.assert(
      fc.property(arbMicro, arbRate, (amount, rate) => {
        const out = convertUsdcToBrl(amount, rate);
        const exact = amount * rate;
        expect(out * DESCALE).toBeLessThanOrEqual(exact);
        expect((out + 1n) * DESCALE).toBeGreaterThan(exact);
      }),
    );
  });

  it('conversion is monotonic in the amount', () => {
    fc.assert(
      fc.property(arbMicro, arbMicro, arbRate, (a, b, rate) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(convertUsdcToBrl(lo, rate)).toBeLessThanOrEqual(convertUsdcToBrl(hi, rate));
      }),
    );
  });
});
