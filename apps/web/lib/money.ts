/**
 * Money as PayPal sends it: a currency code and a decimal string. Arithmetic happens in integer minor
 * units, never in floats. Shared by the server and the browser.
 */
export type Money = { currency: string; value: string };

const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);
const decimals = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : 2);

export function toMinor(m: Money): number {
  const d = decimals(m.currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(m.value.trim());
  if (!match) throw new Error(`not a decimal amount: ${m.value}`);
  const [, sign, whole, frac = ""] = match;
  const minor = Number(whole) * 10 ** d + Number((frac + "0".repeat(d)).slice(0, d) || "0");
  return sign ? -minor : minor;
}

export function fromMinor(minor: number, currency: string): Money {
  const d = decimals(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const value = d === 0 ? String(abs) : `${Math.floor(abs / 10 ** d)}.${String(abs % 10 ** d).padStart(d, "0")}`;
  return { currency, value: `${sign}${value}` };
}

export function sumMoney(list: Money[], currency = "USD"): Money {
  return fromMinor(
    list.filter((m) => m.currency === currency).reduce((acc, m) => acc + toMinor(m), 0),
    currency,
  );
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", SGD: "S$" };

/** "$1,500.00", or "$1,500.00 USD" with `code`. */
export function formatMoney(m: Money, opts: { code?: boolean } = {}): string {
  const minor = toMinor(m);
  const d = decimals(m.currency);
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** d).toLocaleString("en-US");
  const frac = d ? `.${String(abs % 10 ** d).padStart(d, "0")}` : "";
  const symbol = SYMBOL[m.currency];
  const body = symbol ? `${symbol}${whole}${frac}` : `${whole}${frac}`;
  return `${minor < 0 ? "-" : ""}${body}${opts.code || !symbol ? ` ${m.currency}` : ""}`;
}
