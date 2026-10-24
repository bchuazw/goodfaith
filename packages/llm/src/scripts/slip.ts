/**
 * Deterministic permission-slip drafter used by the scripted provider (zero-key demo). It reads the
 * user's words and produces AP2 IntentConstraints-shaped limits. A real LLM does this in live mode; the
 * human always reviews the deterministic render before signing.
 */
import { formatUsd } from "./fit.js";

export type Money = { currency: string; value: string };

export type DraftConstraints = {
  maxPerOrder: Money;
  budget?: { max: Money; period: "week" | "month" | "total" };
  categories?: string[];
  requireVerifiedMerchant?: boolean;
  maxQuantityPerItem?: number;
  priceRule?: { maxMultipleOfMarketMedian: number };
  stepUpAbove?: Money;
};

export type PermissionSlipDraft = {
  constraints: DraftConstraints;
  /** One-line plain-English summary of the limits. */
  summary: string;
  /** ISO timestamp. */
  expiresAt: string;
  /** The user asked for delivery to their saved home address (the wallet fills `shipTo`). */
  shipToHome: boolean;
  /** Interpretations and defaults the user should check on the trusted surface. */
  assumptions: string[];
  naturalLanguage: string;
};

/** The intent Maya types in Act 1 of the demo. */
export const DEMO_INTENT_TEXT =
  "Keep Miso stocked with her usual cat food. Up to $45 an order and no more than $120 a month, only from verified stores, ship to my home, never pay more than the market price, and ask me otherwise. Good until the end of the year.";

type Kind = "order" | "month" | "week" | "total" | "stepup" | "ceiling";

/** Explicit hard caps, e.g. "never more than $100", "hard cap of $150". */
const CEILING_BEFORE_RE =
  /\b(?:never (?:more than|over|above|exceed(?:ing)?)|hard (?:cap|limit|ceiling|max(?:imum)?)(?: of)?|absolute (?:max(?:imum)?|limit)(?: of)?|no (?:single )?order (?:over|above|more than))\s*$/i;

const AMOUNT_RE =
  /(?:US\$|\$|USD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars?|usd|bucks)\b/gi;

const AFTER_RULES: Array<[Kind, RegExp]> = [
  [
    "order",
    /\b(?:per|an?|each|every|a single|one|for any)\s+(?:order|purchase|transaction|buy|checkout|delivery)\b|\/\s?order\b|\bper item\b|\beach time\b|\bat a time\b/i,
  ],
  ["month", /\b(?:a|per|each|every|in a)\s+month\b|\/\s?month\b|\bmonthly\b/i],
  ["week", /\b(?:a|per|each|every|in a)\s+week\b|\/\s?week\b|\bweekly\b/i],
  ["total", /\b(?:in total|total|overall|altogether|in all|for the year|a year|per year|yearly|annually)\b/i],
];

const ASK_ME_RE =
  /\b(?:ask|check with|confirm with|ping|text|message|notify) me\b|\bmy (?:ok|okay|approval|permission|sign-?off)\b|\bget (?:my )?approval\b/i;

const CATEGORY_RULES: Array<[string, RegExp]> = [
  ["pet-food", /\b(?:cat|dog|kitten|puppy|pet)\s*(?:food|kibble|chow|treats?|meals?)\b|\bkibble\b|\bwet food\b/i],
  ["pet-supplies", /\b(?:cat litter|litter|scratch(?:ing)? posts?|pet supplies|cat toys?|dog toys?|leash(?:es)?|collars?|pet beds?)\b/i],
  ["groceries", /\b(?:groceries|grocery|coffee beans?|snacks?|pantry)\b/i],
  ["electronics", /\b(?:chargers?|headphones?|earbuds?|cables?|electronics?|batter(?:y|ies)|phones?)\b/i],
  ["household", /\b(?:paper towels?|detergent|toilet paper|cleaning supplies|dish soap|trash bags?)\b/i],
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1 };

export function draftPermissionSlip(text: string, opts: { now?: Date; currency?: string } = {}): PermissionSlipDraft {
  const now = opts.now ?? new Date();
  const currency = opts.currency ?? "USD";
  const money = (cents: number): Money => ({ currency, value: (cents / 100).toFixed(2) });
  const fmt = (cents: number) => formatUsd(cents / 100);
  const assumptions: string[] = [];

  // --- amounts -------------------------------------------------------------
  const found: Array<{ cents: number; start: number; end: number }> = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const whole = (m[1] ?? m[3] ?? "0").replace(/,/g, "");
    const frac = (m[2] ?? m[4] ?? "").padEnd(2, "0").slice(0, 2);
    const start = m.index ?? 0;
    found.push({ cents: Number.parseInt(whole, 10) * 100 + Number.parseInt(frac || "0", 10), start, end: start + m[0].length });
  }
  const byKind: Record<Kind, number[]> = { order: [], month: [], week: [], total: [], stepup: [], ceiling: [] };
  const unclassified: number[] = [];
  found.forEach((a, idx) => {
    const nextStart = found[idx + 1]?.start ?? text.length;
    const prevEnd = found[idx - 1]?.end ?? 0;
    const after = text.slice(a.end, Math.min(nextStart, a.end + 40));
    const before = text.slice(Math.max(prevEnd, a.start - 40), a.start);
    const clause = clauseAround(text, a.start);
    const capPhrase = /\b(?:no|not|never)\s+(?:more than|over|above)\s*$|\bup to\s*$/i.test(before);
    if (!capPhrase && /\b(?:over|above|more than|exceed(?:s|ing)?|beyond)\s*$/i.test(before) && ASK_ME_RE.test(clause)) {
      byKind.stepup.push(a.cents);
      return;
    }
    let best: { kind: Kind; index: number } | undefined;
    for (const [kind, re] of AFTER_RULES) {
      const m = re.exec(after);
      if (m && (!best || m.index < best.index)) best = { kind, index: m.index };
    }
    const periodic = best !== undefined && best.kind !== "order";
    if (!periodic && CEILING_BEFORE_RE.test(before)) byKind.ceiling.push(a.cents);
    else if (best) byKind[best.kind].push(a.cents);
    else if (/\bbudget\b/i.test(before)) byKind.month.push(a.cents);
    else unclassified.push(a.cents);
  });
  for (const cents of unclassified) {
    if (byKind.order.length === 0) byKind.order.push(cents);
    else if (byKind.month.length + byKind.week.length + byKind.total.length === 0) byKind.month.push(cents);
  }

  let budget: { cents: number; period: "week" | "month" | "total" } | undefined;
  if (byKind.month[0] !== undefined) budget = { cents: byKind.month[0], period: "month" };
  else if (byKind.week[0] !== undefined) budget = { cents: byKind.week[0], period: "week" };
  else if (byKind.total[0] !== undefined) budget = { cents: byKind.total[0], period: "total" };

  const ceiling = byKind.ceiling[0];
  let perOrder = byKind.order[0] ?? ceiling;
  if (perOrder === undefined && budget === undefined) {
    perOrder = 4500;
    budget = { cents: 12000, period: "month" };
    assumptions.push("No amounts found; using the demo defaults of $45.00 per order and $120.00 per month.");
  } else if (perOrder === undefined && budget !== undefined) {
    perOrder = budget.cents;
    assumptions.push(`No per-order limit found; each order is capped at the ${fmt(budget.cents)} budget.`);
  }
  const orderCents = perOrder ?? 4500;

  // "Ask me otherwise": the stated per-order amount becomes the auto-approve (step-up) threshold and the
  // hard cap is the explicit ceiling if one was given, else the budget (no single order can exceed it anyway).
  let maxPerOrderCents = Math.max(orderCents, ceiling ?? 0);
  let stepUpCents: number | undefined;
  const askMe = ASK_ME_RE.test(text);
  const hardCap = ceiling ?? budget?.cents;
  if (byKind.stepup[0] !== undefined) {
    stepUpCents = byKind.stepup[0];
    maxPerOrderCents = Math.max(maxPerOrderCents, stepUpCents);
  } else if (askMe && hardCap !== undefined && hardCap > orderCents) {
    stepUpCents = orderCents;
    maxPerOrderCents = hardCap;
    assumptions.push(
      `Orders up to ${fmt(orderCents)} go through automatically; above that you are asked to approve (step-up), up to ${
        ceiling !== undefined ? `your hard cap of ${fmt(ceiling)}` : `the ${fmt(hardCap)} budget`
      } per order.`,
    );
  }

  // --- other limits ----------------------------------------------------------
  const categories = CATEGORY_RULES.filter(([, re]) => re.test(text)).map(([slug]) => slug);
  if (categories.length === 0) assumptions.push("No product category recognised; the slip does not restrict categories.");

  const verifiedStated = /\b(?:verified|trusted|reputable|legit(?:imate)?)\b/i.test(text);
  if (!verifiedStated) assumptions.push("Defaulted to verified merchants only.");

  const priceRule = /\b(?:market (?:price|median|rate|value)|fair price|overpay|over-?priced|below market|at or below|cheapest|best price|good deal)\b/i.test(text)
    ? { maxMultipleOfMarketMedian: 1 }
    : undefined;

  let maxQuantity = 1;
  const qty =
    /\b(?:at most|max(?:imum)?|up to|no more than|only)\s+(\d+|one|two|three|four|five|six|a|an|single)\s+(?:bags?|items?|units?|box(?:es)?|packs?|cans?|of each|per item)\b/i.exec(
      text,
    );
  if (qty?.[1]) maxQuantity = Number.parseInt(qty[1], 10) || NUMBER_WORDS[qty[1].toLowerCase()] || 1;
  else assumptions.push("Defaulted to at most 1 of each item per order.");

  const shipToHome = /\b(?:ship|deliver|send)(?:ped|ed)?\b[^.]{0,20}\bhome\b|\bhome address\b/i.test(text);

  // --- expiry ----------------------------------------------------------------
  const year = now.getUTCFullYear();
  let expires: Date;
  const span = /\b(?:for|next|within)\s+(\d+|a|one|two|three|six)\s+(days?|weeks?|months?)\b/i.exec(text);
  if (/\b(?:end of (?:the )?year|year[- ]end|dec(?:ember)?\.?\s*31(?:st)?)\b/i.test(text)) {
    expires = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  } else if (span?.[1] && span[2]) {
    const n = Number.parseInt(span[1], 10) || NUMBER_WORDS[span[1].toLowerCase()] || 1;
    const unit = span[2].toLowerCase();
    const days = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
    expires = new Date(now.getTime() + days * 86_400_000);
  } else if (/\bend of (?:the )?month\b/i.test(text)) {
    expires = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0, 23, 59, 59));
  } else {
    expires = new Date(now.getTime() + 30 * 86_400_000);
    assumptions.push("No end date found; the slip expires in 30 days.");
  }
  const expiresAt = expires.toISOString();

  const constraints: DraftConstraints = {
    maxPerOrder: money(maxPerOrderCents),
    ...(budget ? { budget: { max: money(budget.cents), period: budget.period } } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    requireVerifiedMerchant: true,
    maxQuantityPerItem: maxQuantity,
    ...(priceRule ? { priceRule } : {}),
    ...(stepUpCents !== undefined ? { stepUpAbove: money(stepUpCents) } : {}),
  };

  const parts: string[] = [
    stepUpCents !== undefined
      ? `Auto-approve up to ${fmt(stepUpCents)} per order and ask you above that (hard cap ${fmt(maxPerOrderCents)})`
      : `Up to ${fmt(maxPerOrderCents)} per order`,
  ];
  if (budget) parts.push(budget.period === "total" ? `${fmt(budget.cents)} in total` : `${fmt(budget.cents)} per ${budget.period}`);
  if (categories.length > 0) parts.push(`${categories.join(", ")} only`);
  parts.push("verified merchants only");
  if (priceRule) parts.push("price at or below the market median");
  parts.push(`at most ${maxQuantity} of each item`);
  if (shipToHome) parts.push("ships to your saved home address");
  parts.push(`expires ${expiresAt.slice(0, 10)}`);

  return {
    constraints,
    summary: `${parts.join("; ")}.`,
    expiresAt,
    shipToHome,
    assumptions,
    naturalLanguage: text,
  };
}

function clauseAround(text: string, index: number): string {
  const seps = /[,;.!?\n]/;
  let start = index;
  while (start > 0 && !seps.test(text[start - 1] ?? "")) start--;
  let end = index;
  while (end < text.length && !seps.test(text[end] ?? "")) end++;
  return text.slice(start, end);
}

/** A flat bag of draft values for fitting to any caller schema (constraints at top level and nested). */
export function slipBag(draft: PermissionSlipDraft): Record<string, unknown> {
  return {
    ...draft.constraints,
    constraints: draft.constraints,
    summary: draft.summary,
    expiresAt: draft.expiresAt,
    shipToHome: draft.shipToHome,
    assumptions: draft.assumptions,
    clarifications: draft.assumptions,
    naturalLanguage: draft.naturalLanguage,
  };
}
