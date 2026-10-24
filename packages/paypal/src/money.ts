import { validationError } from "./errors.js";
import type { Money } from "./types.js";

/** PayPal currencies that do not support decimals (PayPal "Currency codes" reference). */
const ZERO_DECIMAL_CURRENCIES = new Set(["HUF", "JPY", "TWD"]);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Parses a Money value into integer minor units (cents). Throws CLIENT_VALIDATION_ERROR for
 * malformed values or more decimals than the currency allows (PayPal would answer DECIMAL_PRECISION).
 */
export function toMinor(m: Money, label = "amount"): number {
  if (!m || typeof m !== "object") throw validationError(`${label} must be { currency, value }`);
  if (typeof m.currency !== "string" || !CURRENCY_RE.test(m.currency)) {
    throw validationError(`${label}.currency must be a 3-letter ISO 4217 code`);
  }
  if (typeof m.value !== "string") throw validationError(`${label}.value must be a decimal string`);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(m.value.trim());
  if (!match) throw validationError(`${label}.value "${m.value}" is not a decimal string`);
  const [, sign, whole = "0", frac = ""] = match;
  const decimals = decimalsFor(m.currency);
  if (frac.length > decimals) {
    throw validationError(`${label}.value "${m.value}" has more than ${decimals} decimal places for ${m.currency}`);
  }
  const minor = Number(whole) * 10 ** decimals + (frac.length ? Number(frac.padEnd(decimals, "0")) : 0);
  if (!Number.isSafeInteger(minor)) throw validationError(`${label}.value is too large`);
  return sign ? -minor : minor;
}

export function fromMinor(minor: number, currency: string): Money {
  const decimals = decimalsFor(currency);
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  if (decimals === 0) return { currency, value: `${negative ? "-" : ""}${abs}` };
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return { currency, value: `${negative ? "-" : ""}${whole}.${frac}` };
}

/** Normalises e.g. "38.5" to "38.50" so the mock and the real client send identical bodies. */
export function normalizeMoney(m: Money, label = "amount"): Money {
  return fromMinor(toMinor(m, label), m.currency);
}

/** Validates a strictly positive amount and returns its minor units. */
export function positiveMinor(m: Money, label = "amount"): number {
  const minor = toMinor(m, label);
  if (minor <= 0) throw validationError(`${label} must be greater than zero`);
  return minor;
}

/** PayPal wire format. */
export function toPayPalMoney(m: Money): { currency_code: string; value: string } {
  return { currency_code: m.currency, value: m.value };
}

export function fromPayPalMoney(m: { currency_code: string; value: string }): Money {
  return { currency: m.currency_code, value: m.value };
}
