/**
 * Money kernel. Two hard rules, enforced by construction:
 *
 * 1. Amounts are ALWAYS bigint minor units — micro-USDC (USDC has 6
 *    decimals, not 18) and BRL centavos. `number` money is banned.
 * 2. Every conversion between representations is an explicit, named
 *    function with a documented rounding direction. There is no implicit
 *    rounding anywhere: parsing rejects excess precision instead of
 *    rounding it away.
 */

declare const microUsdcBrand: unique symbol;
declare const centavosBrand: unique symbol;
declare const fxRateBrand: unique symbol;

/** USDC amount in minor units (1 USDC = 1_000_000 micro-USDC). */
export type MicroUSDC = bigint & { readonly [microUsdcBrand]: true };

/** BRL amount in minor units (1 BRL = 100 centavos). */
export type Centavos = bigint & { readonly [centavosBrand]: true };

/** BRL-per-USDC rate scaled by 1e8 (e.g. 5.50 BRL/USDC = 550_000_000n). */
export type FxRate = bigint & { readonly [fxRateBrand]: true };

export const USDC_DECIMALS = 6;
export const BRL_DECIMALS = 2;
export const FX_RATE_DECIMALS = 8;

export const MICRO_PER_USDC = 10n ** BigInt(USDC_DECIMALS);
export const CENTAVOS_PER_BRL = 10n ** BigInt(BRL_DECIMALS);
export const FX_RATE_SCALE = 10n ** BigInt(FX_RATE_DECIMALS);

export class MoneyError extends RangeError {
  override name = 'MoneyError';
}

function requireNonNegative(value: bigint, what: string): void {
  if (value < 0n) {
    throw new MoneyError(`${what} must be >= 0, got ${value}`);
  }
}

/** Wrap a raw bigint as micro-USDC. Negative amounts are rejected: the
 * ledger models corrections as reversing entries, never negative money. */
export function microUSDC(value: bigint): MicroUSDC {
  requireNonNegative(value, 'MicroUSDC');
  return value as MicroUSDC;
}

/** Wrap a raw bigint as BRL centavos. */
export function centavos(value: bigint): Centavos {
  requireNonNegative(value, 'Centavos');
  return value as Centavos;
}

/** Wrap a raw scaled bigint as an FX rate. Zero is rejected — a zero rate
 * is always an upstream bug, never a real quote. */
export function fxRate(value: bigint): FxRate {
  if (value <= 0n) {
    throw new MoneyError(`FxRate must be > 0, got ${value}`);
  }
  return value as FxRate;
}

const MAX_DECIMAL_INPUT_LENGTH = 40;

function parseDecimalString(input: string, decimals: number, what: string): bigint {
  if (input.length === 0 || input.length > MAX_DECIMAL_INPUT_LENGTH) {
    throw new MoneyError(`${what}: invalid input length`);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new MoneyError(
      `${what}: expected an unsigned decimal like "12" or "12.34", got ${JSON.stringify(input)}`,
    );
  }
  const whole = match[1] ?? '0'; // group 1 always matches; ?? satisfies noUncheckedIndexedAccess
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    // Excess precision is an error, not a rounding opportunity.
    throw new MoneyError(`${what}: at most ${decimals} decimal places allowed, got "${input}"`);
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(frac.padEnd(decimals, '0') || '0');
}

function formatMinorUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** "12.34" → 12_340_000n micro-USDC. Rejects >6 decimal places. */
export function parseUSDC(input: string): MicroUSDC {
  return microUSDC(parseDecimalString(input, USDC_DECIMALS, 'parseUSDC'));
}

/** Canonical decimal string: no trailing zeros, no dangling dot.
 * Round-trips exactly through {@link parseUSDC}. */
export function formatUSDC(value: MicroUSDC): string {
  return formatMinorUnits(value, USDC_DECIMALS);
}

/** "5432.10" → 543_210n centavos. Rejects >2 decimal places. */
export function parseBRL(input: string): Centavos {
  return centavos(parseDecimalString(input, BRL_DECIMALS, 'parseBRL'));
}

/** Canonical decimal string; round-trips exactly through {@link parseBRL}. */
export function formatBRL(value: Centavos): string {
  return formatMinorUnits(value, BRL_DECIMALS);
}

/** "5.5" (BRL per USDC) → 550_000_000n. Rejects >8 decimal places. */
export function parseFxRate(input: string): FxRate {
  return fxRate(parseDecimalString(input, FX_RATE_DECIMALS, 'parseFxRate'));
}

export function addMicroUSDC(a: MicroUSDC, b: MicroUSDC): MicroUSDC {
  return (a + b) as MicroUSDC;
}

/** Throws instead of going negative — an underflow here is always a bug. */
export function subMicroUSDC(a: MicroUSDC, b: MicroUSDC): MicroUSDC {
  if (b > a) {
    throw new MoneyError(`subMicroUSDC underflow: ${a} - ${b}`);
  }
  return (a - b) as MicroUSDC;
}

export function addCentavos(a: Centavos, b: Centavos): Centavos {
  return (a + b) as Centavos;
}

export function subCentavos(a: Centavos, b: Centavos): Centavos {
  if (b > a) {
    throw new MoneyError(`subCentavos underflow: ${a} - ${b}`);
  }
  return (a - b) as Centavos;
}

/**
 * Convert USDC to BRL centavos at a scaled rate, rounding DOWN.
 *
 * Units: micro-USDC (1e-6 USDC) × rate (1e-8 BRL/USDC) = 1e-14 BRL;
 * one centavo is 1e-2 BRL, so the product is descaled by 1e12.
 *
 * Floor rounding is a policy choice, not an accident: a payout may never
 * exceed what the funded USDC covers. The truncated remainder is bounded
 * by one centavo and stays in the fx account (visible, not lost).
 */
export function convertUsdcToBrl(amount: MicroUSDC, rate: FxRate): Centavos {
  const CONVERSION_DESCALE = 10n ** BigInt(USDC_DECIMALS + FX_RATE_DECIMALS - BRL_DECIMALS);
  return ((amount * rate) / CONVERSION_DESCALE) as Centavos;
}
