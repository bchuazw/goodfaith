/**
 * Schema-aware helpers for the scripted provider. They let the deterministic demo scripts adapt to the
 * tool argument shapes and structured-output schemas that other packages define, by matching property
 * names (case/underscore-insensitive, with synonyms) against a bag of known values.
 */
import type { JsonSchema } from "../types.js";

type S = Record<string, unknown>;
const isObj = (v: unknown): v is S => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SYNONYM_GROUPS: string[][] = [
  ["query", "q", "search", "searchterm", "searchquery", "keywords", "keyword", "term", "text"],
  ["merchant", "merchantid", "store", "storeid", "shop", "shopid", "seller", "sellerid", "vendor", "merchantslug"],
  ["sku", "productid", "itemid", "productsku", "skuid"],
  ["quantity", "qty", "count", "units"],
  ["cartid", "cart"],
  ["checkouttoken", "checkout", "checkoutjwt", "checkoutmandate", "cartmandate", "carttoken", "checkoutmandatetoken"],
  ["closedtoken", "closedmandate", "closedmandatetoken", "closedmandatejwt", "mandatetoken", "agentmandate"],
  ["disputeid", "dispute", "caseid"],
  ["summary", "explanation", "rationale", "reasoning", "notes", "narrative", "message"],
  ["expiresat", "validuntil", "expiry", "expiration", "expires", "expirydate"],
  ["intentmatch", "intentscore", "matchscore", "intentmatchscore"],
  ["injectionsuspected", "injectiondetected", "suspectedinjection", "promptinjection", "injection"],
  ["recommendation", "decision", "verdict", "outcome"],
  ["evidence", "findings", "signals"],
];

function typesOf(s: S): string[] {
  const t = s.type;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return typeof t === "string" ? [t] : [];
}

function primaryType(s: S): string | undefined {
  const t = typesOf(s).find((x) => x !== "null");
  if (t) return t;
  if (isObj(s.properties)) return "object";
  if (isObj(s.items)) return "array";
  return undefined;
}

function variantsOf(s: S): S[] | undefined {
  const v = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined;
  return v?.filter(isObj);
}

function isNullSchema(s: S): boolean {
  const t = typesOf(s);
  return t.length === 1 && t[0] === "null";
}

/** Flattens an object into normalized-key → value (top-level keys win over nested ones). */
export function buildBag(source: unknown, depth = 3): Map<string, unknown> {
  const bag = new Map<string, unknown>();
  const visit = (v: unknown, d: number) => {
    if (!isObj(v) || d > depth) return;
    for (const [k, child] of Object.entries(v)) {
      const nk = normalizeKey(k);
      if (!bag.has(nk) && child !== undefined) bag.set(nk, child);
    }
    for (const child of Object.values(v)) visit(child, d + 1);
  };
  visit(source, 0);
  return bag;
}

export function lookup(bag: Map<string, unknown>, key: string): unknown {
  const nk = normalizeKey(key);
  if (bag.has(nk)) return bag.get(nk);
  const group = SYNONYM_GROUPS.find((g) => g.includes(nk));
  if (group) for (const alt of group) if (bag.has(alt)) return bag.get(alt);
  let best: { key: string; score: number } | undefined;
  for (const bk of bag.keys()) {
    if (bk.length < 6 || nk.length < 6) continue;
    if (nk.includes(bk) || bk.includes(nk)) {
      const score = Math.min(bk.length, nk.length);
      if (!best || score > best.score) best = { key: bk, score };
    }
  }
  return best ? bag.get(best.key) : undefined;
}

/**
 * Builds a value that matches `schema`, taking values from `candidate` (an object whose keys are matched
 * to schema properties by name). Missing required fields get type defaults. Use it to fit canned outputs
 * to whatever schema a caller passes to structured(), or to fill tool arguments.
 */
export function fitToSchema(schema: JsonSchema | undefined, candidate: unknown): unknown {
  if (!schema || !isObj(schema) || Object.keys(schema).length === 0) return candidate;
  return fitNode(schema, candidate, isObj(candidate) ? buildBag(candidate) : new Map()).value;
}

type Fit = { value: unknown; matched: number };

function fitNode(schema: S, value: unknown, bag: Map<string, unknown>): Fit {
  const variants = variantsOf(schema);
  if (variants && variants.length > 0) {
    if (value === null && variants.some(isNullSchema)) return { value: null, matched: 1 };
    const chosen =
      variants.find((v) => !isNullSchema(v) && typeMatches(v, value)) ?? variants.find((v) => !isNullSchema(v)) ?? variants[0];
    return chosen ? fitNode(chosen, value, bag) : { value, matched: 0 };
  }
  if (schema.const !== undefined) return { value: schema.const, matched: 1 };
  if (Array.isArray(schema.enum)) return { value: pickEnum(schema.enum, value), matched: value === undefined ? 0 : 1 };
  if (value === null && typesOf(schema).includes("null")) return { value: null, matched: 1 };
  switch (primaryType(schema)) {
    case "object":
      return fitObject(schema, value, bag);
    case "array": {
      const items = isObj(schema.items) ? schema.items : {};
      if (Array.isArray(value)) {
        const fitted = value.map((v) => fitNode(items, v, isObj(v) ? buildBag(v) : bag));
        return { value: fitted.map((f) => f.value), matched: 1 };
      }
      if (value === undefined || value === null) return { value: [], matched: 0 };
      return { value: [fitNode(items, value, isObj(value) ? buildBag(value) : bag).value], matched: 1 };
    }
    case "string":
      return { value: toStr(value), matched: value === undefined ? 0 : 1 };
    case "number":
      return { value: toNum(value) ?? numberDefault(schema), matched: value === undefined ? 0 : 1 };
    case "integer":
      return { value: Math.round(toNum(value) ?? numberDefault(schema)), matched: value === undefined ? 0 : 1 };
    case "boolean":
      return { value: toBool(value), matched: value === undefined ? 0 : 1 };
    case "null":
      return { value: null, matched: 1 };
    default:
      return { value, matched: value === undefined ? 0 : 1 };
  }
}

function fitObject(schema: S, value: unknown, outerBag: Map<string, unknown>): Fit {
  const props = isObj(schema.properties) ? schema.properties : undefined;
  if (!props) {
    // Free-form object / record: pass objects through untouched.
    return isObj(value) ? { value, matched: 1 } : { value: {}, matched: 0 };
  }
  const bag = isObj(value) ? buildBag(value) : outerBag;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: S = {};
  let matched = 0;
  for (const [key, ps] of Object.entries(props)) {
    if (!isObj(ps)) continue;
    const direct = isObj(value) && value[key] !== undefined ? value[key] : lookup(bag, key);
    if (direct !== undefined) {
      const f = fitNode(ps, direct, bag);
      out[key] = f.value;
      matched += 1;
      continue;
    }
    const pt = primaryType(ps);
    if (pt === "object") {
      const sub = fitObject(ps, undefined, bag);
      if (required.has(key) || sub.matched > 0) out[key] = sub.value;
      matched += sub.matched;
      continue;
    }
    if (pt === "array" && isObj(ps.items) && primaryType(ps.items) === "object") {
      const sub = fitObject(ps.items, undefined, bag);
      if (sub.matched > 0) out[key] = [sub.value];
      else if (required.has(key)) out[key] = [];
      matched += sub.matched;
      continue;
    }
    if (required.has(key)) out[key] = defaultFor(ps);
  }
  return { value: out, matched };
}

function defaultFor(s: S): unknown {
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const variants = variantsOf(s);
  if (variants) {
    const nonNull = variants.find((v) => !isNullSchema(v));
    return nonNull ? defaultFor(nonNull) : null;
  }
  if (typesOf(s).includes("null")) return null;
  switch (primaryType(s)) {
    case "string":
      return "";
    case "number":
    case "integer":
      return numberDefault(s);
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return fitObject(s, undefined, new Map()).value;
    default:
      return null;
  }
}

function numberDefault(s: S): number {
  return typeof s.minimum === "number" ? s.minimum : 0;
}

function typeMatches(s: S, v: unknown): boolean {
  const t = primaryType(s);
  if (v === undefined) return false;
  if (Array.isArray(v)) return t === "array";
  if (isObj(v)) return t === "object";
  if (typeof v === "number") return t === "number" || t === "integer";
  return typeof v === t;
}

function pickEnum(values: unknown[], v: unknown): unknown {
  if (values.includes(v)) return v;
  if (typeof v === "string") {
    const hit = values.find((x) => typeof x === "string" && x.toLowerCase() === v.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return values[0];
}

export function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v) && typeof v.value === "string" && typeof v.currency === "string") return v.value;
  if (Array.isArray(v)) return v.map(toStr).join(", ");
  if (v === undefined || v === null) return "";
  return JSON.stringify(v);
}

export function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (isObj(v)) {
    for (const key of ["value", "amount", "price"]) {
      const n = toNum(v[key]);
      if (n !== undefined) return n;
    }
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|1)$/i.test(v.trim());
  if (typeof v === "number") return v !== 0;
  return false;
}

// ---------------------------------------------------------------------------
// Discovery helpers over tool results
// ---------------------------------------------------------------------------

/** Walks values breadth-first (objects and arrays), calling `visit` on every plain object. */
export function walkObjects(values: unknown[], visit: (o: S) => void, maxDepth = 6): void {
  let frontier: unknown[] = [...values];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const v of frontier) {
      if (Array.isArray(v)) next.push(...v);
      else if (isObj(v)) {
        visit(v);
        next.push(...Object.values(v));
      }
    }
    frontier = next;
  }
}

/** Collects normalized-key → value from tool results; later results override earlier ones. */
export function collectValues(results: unknown[]): Map<string, unknown> {
  const bag = new Map<string, unknown>();
  for (const r of results) {
    const local = new Map<string, unknown>();
    walkObjects([r], (o) => {
      for (const [k, v] of Object.entries(o)) {
        const nk = normalizeKey(k);
        if (!local.has(nk) && v !== undefined && v !== null) local.set(nk, v);
      }
    });
    for (const [k, v] of local) bag.set(k, v);
  }
  return bag;
}

export type FoundProduct = { sku: string; title: string; price?: number; merchant?: string; category?: string };

/** Finds product-like objects: an id/sku plus a title/name, and a price or category. */
export function findProducts(values: unknown[]): FoundProduct[] {
  const out: FoundProduct[] = [];
  const seen = new Set<string>();
  walkObjects(values, (o) => {
    const sku = firstString(o, ["sku", "productId", "product_id", "id"]);
    const title = firstString(o, ["title", "name"]);
    if (!sku || !title) return;
    const priceRaw = o.unitPrice ?? o.unit_price ?? o.price ?? o.amount;
    const price = toNum(priceRaw);
    const category = typeof o.category === "string" ? o.category : undefined;
    if (price === undefined && category === undefined) return;
    const m = o.merchant ?? o.merchantId ?? o.merchant_id ?? o.store;
    const merchant = typeof m === "string" ? m : isObj(m) ? firstString(m, ["id", "name"]) : undefined;
    const key = `${sku}|${merchant ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sku, title, ...(price !== undefined ? { price } : {}), ...(merchant ? { merchant } : {}), ...(category ? { category } : {}) });
  });
  return out;
}

export type FoundMerchant = { id: string; name?: string; verified?: boolean };

/** Finds merchant-like objects: an id plus a boolean `verified`. */
export function findMerchants(values: unknown[]): FoundMerchant[] {
  const out: FoundMerchant[] = [];
  const seen = new Set<string>();
  walkObjects(values, (o) => {
    const id = firstString(o, ["id", "merchantId", "merchant_id"]);
    if (!id || typeof o.verified !== "boolean" || seen.has(id)) return;
    seen.add(id);
    const name = firstString(o, ["name", "displayName"]);
    out.push({ id, ...(name ? { name } : {}), verified: o.verified });
  });
  return out;
}

function firstString(o: S, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
