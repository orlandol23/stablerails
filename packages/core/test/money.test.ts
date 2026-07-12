import { describe, expect, it } from 'vitest';

import {
  MoneyError,
  centavos,
  convertUsdcToBrl,
  formatBRL,
  formatUSDC,
  fxRate,
  microUSDC,
  parseBRL,
  parseFxRate,
  parseUSDC,
  subCentavos,
  subMicroUSDC,
} from '../src/index.js';

describe('parseUSDC', () => {
  it('parses whole and fractional amounts into micro-USDC (6 decimals)', () => {
    expect(parseUSDC('0')).toBe(0n);
    expect(parseUSDC('1')).toBe(1_000_000n);
    expect(parseUSDC('12.34')).toBe(12_340_000n);
    expect(parseUSDC('0.000001')).toBe(1n);
    expect(parseUSDC('25.000000')).toBe(25_000_000n);
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => parseUSDC('1.0000001')).toThrow(MoneyError);
  });

  it.each(['', '-1', '+1', '1.', '.5', '1e6', '0x10', '1,5', ' 1', 'NaN'])(
    'rejects malformed input %j',
    (input) => {
      expect(() => parseUSDC(input)).toThrow(MoneyError);
    },
  );
});

describe('formatUSDC', () => {
  it('formats canonically without trailing zeros', () => {
    expect(formatUSDC(microUSDC(0n))).toBe('0');
    expect(formatUSDC(microUSDC(1_000_000n))).toBe('1');
    expect(formatUSDC(microUSDC(12_340_000n))).toBe('12.34');
    expect(formatUSDC(microUSDC(1n))).toBe('0.000001');
  });
});

describe('BRL centavos (2 decimals)', () => {
  it('parses and formats', () => {
    expect(parseBRL('5432.10')).toBe(543_210n);
    expect(formatBRL(centavos(543_210n))).toBe('5432.1');
    expect(() => parseBRL('1.005')).toThrow(MoneyError);
  });
});

describe('constructors', () => {
  it('reject negative amounts and non-positive rates', () => {
    expect(() => microUSDC(-1n)).toThrow(MoneyError);
    expect(() => centavos(-1n)).toThrow(MoneyError);
    expect(() => fxRate(0n)).toThrow(MoneyError);
  });
});

describe('subtraction underflow', () => {
  it('throws instead of producing negative money', () => {
    expect(() => subMicroUSDC(microUSDC(1n), microUSDC(2n))).toThrow(MoneyError);
    expect(() => subCentavos(centavos(1n), centavos(2n))).toThrow(MoneyError);
  });
});

describe('convertUsdcToBrl', () => {
  it('converts 1 USDC at 5.50 BRL/USDC to 550 centavos', () => {
    expect(convertUsdcToBrl(parseUSDC('1'), parseFxRate('5.5'))).toBe(550n);
  });

  it('rounds down — a payout never exceeds the funded amount', () => {
    // 0.000001 USDC at 5.5 BRL/USDC = 0.00055 centavos → floors to 0.
    expect(convertUsdcToBrl(microUSDC(1n), parseFxRate('5.5'))).toBe(0n);
    // 1.999999 USDC * 5.5 = 10.9999945 BRL → 1099 centavos, not 1100.
    expect(convertUsdcToBrl(parseUSDC('1.999999'), parseFxRate('5.5'))).toBe(1_099n);
  });
});
