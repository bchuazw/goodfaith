/**
 * Random sources and PayPal-like identifier formats.
 *
 * With a seed, every id the mock produces is reproducible (sfc32 over a cyrb128 hash of the seed).
 * Without one, ids come from crypto.getRandomValues. Formats copy what PayPal's documented examples
 * look like, e.g. order 5O190127TN364715T, payment token jwgvx42, payer AJM9JTWQJCFTA,
 * dispute PP-R-AYP-10135034, debug id b1d1f06c7246c, event WH-3F562076HD293871E-75F399086E414290U.
 */

export type Rng = () => number; // uniform in [0, 1)

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seed?: string): Rng {
  if (seed !== undefined) {
    const [a, b, c, d] = cyrb128(seed);
    const rng = sfc32(a, b, c, d);
    for (let i = 0; i < 15; i++) rng(); // warm up
    return rng;
  }
  const buf = new Uint32Array(64);
  let i = buf.length;
  return () => {
    if (i >= buf.length) {
      globalThis.crypto.getRandomValues(buf);
      i = 0;
    }
    return (buf[i++] ?? 0) / 4294967296;
  };
}

const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HEX = "0123456789abcdef";

function pick(rng: Rng, chars: string): string {
  return chars.charAt(Math.floor(rng() * chars.length));
}

function draw(rng: Rng, chars: string, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += pick(rng, chars);
  return s;
}

/** 17-character transaction-style id (orders, captures, authorizations, refunds, setup tokens). */
export function transactionId(rng: Rng): string {
  let s = pick(rng, DIGITS);
  for (let i = 1; i < 17; i++) s += rng() < 0.2 ? pick(rng, UPPER) : pick(rng, DIGITS);
  return s;
}

/** Vault payment token id, e.g. "jwgvx42". */
export function paymentTokenId(rng: Rng): string {
  return draw(rng, LOWER_ALNUM, 7);
}

/** PayPal account / merchant id (13 chars), e.g. "AJM9JTWQJCFTA". */
export function accountId(rng: Rng): string {
  return draw(rng, UPPER_ALNUM, 13);
}

export function customerId(rng: Rng): string {
  return `customer_${draw(rng, DIGITS, 10)}`;
}

export function disputeId(rng: Rng): string {
  return `PP-R-${draw(rng, UPPER, 3)}-10${draw(rng, DIGITS, 6)}`;
}

export function debugId(rng: Rng): string {
  return draw(rng, HEX, 13);
}

export function webhookEventId(rng: Rng): string {
  return `WH-${transactionId(rng)}-${transactionId(rng)}`;
}

export function uuid(rng: Rng): string {
  const h = draw(rng, HEX, 32).split("");
  h[12] = "4";
  h[16] = HEX.charAt(8 + Math.floor(rng() * 4));
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function base64Bytes(rng: Rng, n: number): string {
  let bin = "";
  for (let i = 0; i < n; i++) bin += String.fromCharCode(Math.floor(rng() * 256));
  return btoa(bin);
}

/** A fresh PayPal-Request-Id for calls where the caller did not supply one. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}
