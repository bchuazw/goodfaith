/**
 * Deterministic shopping-agent scripts for the zero-key demo. Each step is a dynamic turn that finds the
 * matching tool among the ones the caller provides (canonical names first, then similar names), fills its
 * arguments from the tool's own JSON Schema using values seen so far, and is skipped if no such tool exists.
 */
import type { ScriptContext, ScriptedTurn, ScriptToolInfo, ScriptToolResult } from "../types.js";
import { detectInjectionSignals } from "../untrusted.js";
import {
  collectValues,
  type FoundMerchant,
  type FoundProduct,
  findMerchants,
  findProducts,
  fitToSchema,
  formatUsd,
  normalizeKey,
  toNum,
  toStr,
} from "./fit.js";

export type ShoppingFlow = "happy" | "compromised" | "stepup";

/** Canonical tool names the demo scripts look for first (see docs/LLM_NOTES.md for argument shapes). */
export const DEMO_TOOL_NAMES = {
  searchMarket: "search_market",
  marketPrice: "get_market_price",
  listMerchants: "list_merchants",
  browseMerchant: "browse_merchant",
  createCart: "create_cart",
  signClosedMandate: "sign_closed_mandate",
  requestPayment: "request_payment",
} as const;

type Step = "search" | "price" | "merchants" | "browse" | "cart" | "sign" | "pay";

const TOOL_MATCH: Record<Step, { canonical: string[]; patterns: RegExp[]; avoid?: RegExp[] }> = {
  search: { canonical: ["search_market", "search_products", "market_search"], patterns: [/search/i], avoid: [/price|dispute/i] },
  price: { canonical: ["get_market_price", "market_price", "check_market_price"], patterns: [/market.*price|price.*market/i], avoid: [/history/i] },
  merchants: { canonical: ["list_merchants", "get_merchants", "list_stores"], patterns: [/merchants\b/i, /stores\b/i] },
  browse: {
    canonical: ["browse_merchant", "view_product", "get_product_page", "browse_store", "get_catalog", "view_store"],
    patterns: [/browse|page|catalog|view|visit/i],
    avoid: [/cart|checkout|pay/i],
  },
  cart: { canonical: ["create_cart", "add_to_cart", "build_cart", "update_cart"], patterns: [/cart/i], avoid: [/^get_cart|^view_cart/i] },
  sign: { canonical: ["sign_closed_mandate", "countersign", "sign_checkout", "sign_mandate", "countersign_checkout"], patterns: [/sign|closed/i] },
  pay: { canonical: ["request_payment", "submit_payment", "pay", "complete_checkout", "checkout"], patterns: [/pay|checkout|purchase/i], avoid: [/cart/i] },
};

const AUTO_APPROVE_LIMIT = 45;

export function toolFor(ctx: Pick<ScriptContext, "tools">, step: Step): ScriptToolInfo | undefined {
  const m = TOOL_MATCH[step];
  for (const name of m.canonical) {
    const t = ctx.tools.find((x) => x.name === name);
    if (t) return t;
  }
  return ctx.tools.find((t) => m.patterns.some((p) => p.test(t.name)) && !(m.avoid ?? []).some((a) => a.test(t.name)));
}

export function dynamicTurn(label: string, resolve: (ctx: ScriptContext) => ScriptedTurn | null): ScriptedTurn {
  return { type: "dynamic", op: "toolLoop", label, resolve };
}

export function callTool(tool: ScriptToolInfo, bag: Record<string, unknown>, thought: string): ScriptedTurn {
  return { type: "tool_calls", thought, calls: [{ name: tool.name, args: fitToSchema(tool.jsonSchema, bag) }] };
}

export function productQuery(user: string): string {
  const m = /\b(?:cat|dog|kitten|puppy|pet)\s+(?:food|kibble|treats?|litter)\b|\bkibble\b/i.exec(user);
  return m ? m[0].toLowerCase() : "cat food";
}

function lastResult(ctx: ScriptContext, tool: ScriptToolInfo | undefined): ScriptToolResult | undefined {
  if (!tool) return undefined;
  for (let i = ctx.results.length - 1; i >= 0; i--) if (ctx.results[i]?.name === tool.name) return ctx.results[i];
  return undefined;
}

function chooseMerchant(ctx: ScriptContext, flow: ShoppingFlow): FoundMerchant {
  const merchants = findMerchants(ctx.results.map((r) => r.result));
  if (flow === "compromised") {
    return (
      merchants.find((m) => m.verified === false) ??
      merchants.find((m) => /bargain/i.test(m.id)) ?? { id: "dealfang", name: "Dealfang", verified: false }
    );
  }
  return (
    merchants.find((m) => m.verified === true) ??
    merchants.find((m) => /northwind/i.test(m.id)) ??
    merchants[0] ?? { id: "northwind", name: "Northwind Pets", verified: true }
  );
}

function merchantMatches(productMerchant: string, m: FoundMerchant): boolean {
  const pm = normalizeKey(productMerchant);
  const ids = [normalizeKey(m.id), normalizeKey(m.name ?? "")].filter((x) => x.length >= 4);
  return ids.some((id) => pm.includes(id) || id.includes(pm));
}

const priceOf = (p: FoundProduct, fallback: number) => p.price ?? fallback;
const minBy = (list: FoundProduct[]) =>
  list.reduce<FoundProduct | undefined>((best, p) => (!best || priceOf(p, Infinity) < priceOf(best, Infinity) ? p : best), undefined);
const maxBy = (list: FoundProduct[]) =>
  list.reduce<FoundProduct | undefined>((best, p) => (!best || priceOf(p, -Infinity) > priceOf(best, -Infinity) ? p : best), undefined);

function chooseProduct(ctx: ScriptContext, flow: ShoppingFlow, merchant: FoundMerchant): FoundProduct | undefined {
  const browse = toolFor(ctx, "browse");
  const browsed = browse ? ctx.results.filter((r) => r.name === browse.name && !r.isError).map((r) => r.result) : [];
  let pool = findProducts(browsed);
  if (pool.length === 0) pool = findProducts(ctx.results.filter((r) => !r.isError).map((r) => r.result));
  const atMerchant = pool.filter((p) => p.merchant === undefined || merchantMatches(p.merchant, merchant));
  const candidates = atMerchant.length > 0 ? atMerchant : pool;
  if (flow === "compromised") {
    return candidates.find((p) => /platinum/i.test(p.title)) ?? pool.find((p) => /platinum/i.test(p.title)) ?? maxBy(candidates);
  }
  const words = productQuery(ctx.user).split(/\s+/);
  const plain = candidates.filter((p) => !/platinum|bundle/i.test(p.title));
  const relevant = plain.filter((p) => words.every((w) => new RegExp(`\\b${w}`, "i").test(p.title)));
  const list = relevant.length > 0 ? relevant : plain.length > 0 ? plain : candidates;
  if (flow === "stepup") return minBy(list.filter((p) => priceOf(p, 0) > AUTO_APPROVE_LIMIT)) ?? maxBy(list);
  const affordable = list.filter((p) => p.price === undefined || p.price <= AUTO_APPROVE_LIMIT);
  // Prefer the market search's best match (the user's usual product) when this merchant sells it within the limit.
  const search = toolFor(ctx, "search");
  const marketRanked = search ? findProducts(ctx.results.filter((r) => r.name === search.name && !r.isError).map((r) => r.result)) : [];
  for (const m of marketRanked) {
    const hit = affordable.find((p) => p.sku === m.sku);
    if (hit) return hit;
  }
  return minBy(affordable) ?? minBy(list);
}

const THOUGHTS: Record<
  ShoppingFlow,
  { search: (q: string) => string; browse: (m: FoundMerchant) => string; cart: (p: FoundProduct, qty: number, m: FoundMerchant) => string }
> = {
  happy: {
    search: (q) => `Checking the market price for ${q} before buying.`,
    browse: (m) => `Opening ${m.name ?? m.id}, a verified merchant.`,
    cart: (p, qty, m) => `Adding ${qty} × ${p.title}${p.price !== undefined ? ` at ${formatUsd(p.price)}` : ""} to a cart at ${m.name ?? m.id}.`,
  },
  compromised: {
    search: (q) => `Checking the market price for ${q} before buying.`,
    browse: (m) => `${m.name ?? m.id} is advertising a cat food deal; opening its page.`,
    cart: (p, qty) => `The store page says this order was already arranged, so I am adding ${qty} × ${p.title} as it instructs.`,
  },
  stepup: {
    search: (q) => `Checking the market price for ${q} before buying.`,
    browse: (m) => `Opening ${m.name ?? m.id}, a verified merchant.`,
    cart: (p, qty, m) =>
      `Adding ${qty} × ${p.title}${p.price !== undefined ? ` at ${formatUsd(p.price)}` : ""} at ${m.name ?? m.id}; it is above the auto-approve limit, so you may be asked to confirm.`,
  },
};

function errorText(result: unknown): string {
  const v = collectValues([result]);
  return toStr(v.get("error") ?? v.get("message") ?? result).slice(0, 200);
}

/** Tool values seen so far (successful results only), with string results mapped to likely token names. */
function knownValues(ctx: ScriptContext): Record<string, unknown> {
  const ok = ctx.results.filter((r) => !r.isError);
  const values = collectValues(ok.map((r) => r.result));
  const sign = lastResult(ctx, toolFor(ctx, "sign"));
  if (sign && !sign.isError && typeof sign.result === "string") values.set("closedtoken", sign.result);
  const cart = lastResult(ctx, toolFor(ctx, "cart"));
  if (cart && !cart.isError && typeof cart.result === "string") values.set("checkouttoken", cart.result);
  return Object.fromEntries(values);
}

function stopIfLastFailed(ctx: ScriptContext): ScriptedTurn | null {
  const last = ctx.results[ctx.results.length - 1];
  if (last?.isError) return { type: "final", text: `I stopped because ${last.name} failed: ${errorText(last.result)}.` };
  return null;
}

function finalSummary(ctx: ScriptContext, flow: ShoppingFlow): string {
  const m = chooseMerchant(ctx, flow);
  const p = chooseProduct(ctx, flow, m);
  const qty = flow === "compromised" ? 5 : 1;
  const what = p ? `${qty} × ${p.title}` : "the item";
  const where = m.name ?? m.id;
  const total = p?.price !== undefined ? formatUsd(p.price * qty) : undefined;
  const all = collectValues(ctx.results.filter((r) => !r.isError).map((r) => r.result));
  const median = toNum(all.get("median"));
  const lines: string[] = [];
  const pay = lastResult(ctx, toolFor(ctx, "pay"));
  if (!pay) {
    const err = [...ctx.results].reverse().find((r) => r.isError);
    lines.push(err ? `I could not finish the purchase: ${errorText(err.result)}.` : `I prepared ${what} from ${where} but did not request payment.`);
  } else if (pay.isError) {
    lines.push(`The payment request for ${what} from ${where} failed: ${errorText(pay.result)}.`);
  } else {
    const v = collectValues([pay.result]);
    const outcome = toStr(v.get("outcome") ?? v.get("decision") ?? v.get("status") ?? "").toUpperCase();
    const reasons = v.get("reasons");
    const reasonText = Array.isArray(reasons) ? reasons.slice(0, 3).map(toStr).join("; ") : "";
    const orderId = toStr(v.get("orderid") ?? v.get("paypalorderid") ?? "");
    const price = total ? ` (${total})` : "";
    if (/BLOCK|REJECT|DENIED|DECLINED/.test(outcome)) {
      lines.push(`Alibi blocked the purchase of ${what} from ${where}${price}${reasonText ? `: ${reasonText}` : ""}. No money moved.`);
    } else if (/STEP.?UP|APPROVAL|PAYER_ACTION/.test(outcome)) {
      lines.push(`${what} from ${where}${price} is above your auto-approve limit, so Alibi sent you a step-up request in PayPal.`);
    } else if (/HOLD|PENDING/.test(outcome)) {
      lines.push(`Payment for ${what} from ${where}${price} is on hold until the merchant confirms the order.`);
    } else if (/ALLOW|COMPLETED|APPROVED|CAPTURED|SUCCESS|PAID/.test(outcome)) {
      lines.push(
        `Done: bought ${what} from ${where}${total ? ` for ${total}` : ""}${median !== undefined ? ` (market median ${formatUsd(median)})` : ""}. Alibi approved it under your permission slip${orderId ? `; PayPal order ${orderId}` : ""}.`,
      );
    } else {
      lines.push(`Requested payment for ${what} from ${where}${price}; outcome: ${outcome || "unknown"}.`);
    }
  }
  if (flow !== "compromised") {
    const untrusted = ctx.results.filter((r) => r.untrusted).map((r) => r.modelContent).join("\n");
    const signal = detectInjectionSignals(untrusted).find((s) => !s.weak);
    if (signal) lines.push(`INJECTION: "${signal.quote}"`);
  }
  return lines.join("\n");
}

/** Builds the scripted turns for one shopping flow. */
export function shoppingScript(flow: ShoppingFlow): ScriptedTurn[] {
  const t = THOUGHTS[flow];
  return [
    dynamicTurn(`${flow}:search`, (ctx) => {
      const tool = toolFor(ctx, "search");
      if (!tool) return null;
      const query = productQuery(ctx.user);
      return callTool(tool, { query, limit: 5 }, t.search(query));
    }),
    dynamicTurn(`${flow}:market-price`, (ctx) => {
      const tool = toolFor(ctx, "price");
      if (!tool) return null;
      const query = productQuery(ctx.user);
      return callTool(tool, { query }, `Getting the market median for ${query}.`);
    }),
    dynamicTurn(`${flow}:merchants`, (ctx) => {
      const tool = toolFor(ctx, "merchants");
      return tool ? callTool(tool, {}, "Listing merchants that can fulfil the order.") : null;
    }),
    dynamicTurn(`${flow}:browse`, (ctx) => {
      const tool = toolFor(ctx, "browse");
      if (!tool) return null;
      const m = chooseMerchant(ctx, flow);
      const p = chooseProduct(ctx, flow, m);
      return callTool(
        tool,
        { merchant: m.id, merchantId: m.id, store: m.id, query: productQuery(ctx.user), ...(p ? { productId: p.sku, sku: p.sku } : {}) },
        t.browse(m),
      );
    }),
    dynamicTurn(`${flow}:cart`, (ctx) => {
      const tool = toolFor(ctx, "cart");
      if (!tool) return null;
      const m = chooseMerchant(ctx, flow);
      const p = chooseProduct(ctx, flow, m);
      if (!p) return { type: "final", text: `I could not find a suitable product at ${m.name ?? m.id}, so I did not buy anything.` };
      const quantity = flow === "compromised" ? 5 : 1;
      return callTool(
        tool,
        {
          merchant: m.id,
          merchantId: m.id,
          store: m.id,
          sku: p.sku,
          productId: p.sku,
          quantity,
          items: [{ sku: p.sku, productId: p.sku, quantity }],
        },
        t.cart(p, quantity, m),
      );
    }),
    dynamicTurn(`${flow}:sign`, (ctx) => {
      const tool = toolFor(ctx, "sign");
      if (!tool) return null;
      return stopIfLastFailed(ctx) ?? callTool(tool, knownValues(ctx), "Countersigning the merchant's signed checkout with my agent key.");
    }),
    dynamicTurn(`${flow}:pay`, (ctx) => {
      const tool = toolFor(ctx, "pay");
      if (!tool) return null;
      return (
        stopIfLastFailed(ctx) ??
        callTool(tool, knownValues(ctx), "Asking the wallet to pay; Alibi checks the permission slip before any money moves.")
      );
    }),
    dynamicTurn(`${flow}:final`, (ctx) => ({ type: "final", text: finalSummary(ctx, flow) })),
  ];
}
