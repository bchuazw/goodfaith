/**
 * Sponsors fund a program's bounty pool with PayPal Checkout: an Orders v2 CAPTURE order the sponsor
 * approves (JS SDK v6 live, the mock sheet in mock mode), captured server-side.
 */
import { isMockPayPal } from "@goodfaith/paypal";
import { z } from "zod";
import { formatMoney, fromMinor, type Money, toMinor } from "../money";
import { AppError, notFound, paypalFailure, paypalIssue } from "./errors";
import { requestIds } from "./ids";
import { paypalCall } from "./ledger";
import type { Services } from "./services";
import { type FundingRecord, KEEP } from "./store";

export const FUNDING_PRESETS = ["100.00", "250.00", "500.00", "1000.00"] as const;

export const fundRequestSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,5}(\.\d{2})?$/, "Enter a whole dollar amount, or dollars and cents")
    .transform((v) => (v.includes(".") ? v : `${v}.00`))
    .refine((v) => Number(v) >= 5 && Number(v) <= 10_000, "Sponsor between $5 and $10,000"),
  sponsor: z.string().trim().min(2, "Name the sponsor").max(60),
});

export async function createFundingOrder(svc: Services, raw: unknown, opts: { origin: string }): Promise<{ funding: FundingRecord; approveUrl?: string }> {
  const parsed = fundRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_FUNDING", parsed.error.issues[0]?.message ?? "Invalid amount", 422);
  const amount: Money = { currency: "USD", value: parsed.data.amount };
  const key = crypto.randomUUID();
  const order = await paypalCall(
    svc,
    "orders.create",
    { fundingId: key },
    () =>
      svc.paypal.createOrder({
        intent: "CAPTURE",
        amount,
        description: `Contribution to the ${svc.program.name} bug-bounty pool on Good Faith`,
        customId: `fund:${svc.program.id}`,
        invoiceId: `gf-fund-${key}`,
        items: [{ name: `${svc.program.name} bounty pool contribution`, sku: "gf-pool", unitAmount: amount, quantity: 1, category: "DIGITAL_GOODS" }],
        returnUrl: `${opts.origin}/p/${svc.program.id}?funding=approved`,
        cancelUrl: `${opts.origin}/p/${svc.program.id}?funding=cancelled`,
        requestId: requestIds.fundingOrder(key),
      }),
    (o) => ({ summary: `Created CAPTURE order for a ${formatMoney(amount)} pool contribution`, ids: { orderId: o.id }, status: o.status }),
    "Could not create the sponsor order",
  ).catch((e) => {
    throw paypalFailure("create the sponsor order", e);
  });
  const now = svc.now().toISOString();
  const funding: FundingRecord = { id: order.id, programId: svc.program.id, sponsor: parsed.data.sponsor, amount, status: "CREATED", source: "buyer", createdAt: now, updatedAt: now };
  await svc.db.fundings.create(order.id, funding);
  return { funding, ...(order.approveUrl ? { approveUrl: order.approveUrl } : {}) };
}

/** The sponsor approved: capture the order (idempotent per order). */
export async function captureFunding(svc: Services, orderId: string): Promise<FundingRecord> {
  const funding = await svc.db.fundings.value(orderId);
  if (!funding) throw notFound("Sponsor order");
  if (funding.status === "COMPLETED") return funding;
  let result: Awaited<ReturnType<typeof svc.paypal.captureOrder>>;
  try {
    result = await paypalCall(
      svc,
      "orders.capture",
      { fundingId: orderId },
      () => svc.paypal.captureOrder(orderId, requestIds.fundingCapture(orderId)),
      (r) => ({ summary: `Captured ${formatMoney(funding.amount)} into the ${svc.program.name} bounty pool`, ids: { orderId, ...(r.captureId ? { captureId: r.captureId } : {}) }, status: r.captureStatus ?? r.status }),
      "Could not capture the sponsor order",
    );
  } catch (e) {
    if (paypalIssue(e) === "ORDER_NOT_APPROVED") throw new AppError("ORDER_NOT_APPROVED", "PayPal has not approved this order yet", 409);
    if (paypalIssue(e) !== "ORDER_ALREADY_CAPTURED") throw paypalFailure("capture the sponsor order", e);
    const order = await svc.paypal.getOrder(orderId);
    result = { id: orderId, status: order.status, ...(order.captureId ? { captureId: order.captureId } : {}), ...(order.captureStatus ? { captureStatus: order.captureStatus } : {}) };
  }
  const payerEmail = await svc.paypal
    .getOrder(orderId)
    .then((o) => o.payerEmail)
    .catch(() => undefined);
  const at = svc.now().toISOString();
  const ok = result.captureStatus ? result.captureStatus === "COMPLETED" || result.captureStatus === "PENDING" : result.status === "COMPLETED";
  const res = await svc.db.fundings.update(orderId, (f) =>
    f && f.status !== "COMPLETED"
      ? {
          ...f,
          status: ok ? "COMPLETED" : "FAILED",
          ...(result.captureId ? { captureId: result.captureId } : {}),
          ...(result.captureStatus ? { captureStatus: result.captureStatus } : {}),
          ...(payerEmail ? { payerEmail } : {}),
          capturedAt: at,
          updatedAt: at,
        }
      : KEEP,
  );
  return res.value as FundingRecord;
}

/** Mock mode only: approve and capture in one step (judge mode's "fund the pool"). */
export async function fundWithMockApproval(svc: Services, raw: unknown, opts: { origin: string }): Promise<FundingRecord> {
  if (!isMockPayPal(svc.paypal)) throw new AppError("MOCK_ONLY", "Simulated approval exists only in mock mode", 409);
  const { funding } = await createFundingOrder(svc, raw, opts);
  svc.paypal.simulateBuyerApproval(funding.id);
  return captureFunding(svc, funding.id);
}

export type PoolBalance = { funded: Money; paid: Money; committed: Money; available: Money; slopTax: Money; sponsors: number };

/** The bounty pool: what sponsors put in, minus bounties paid or in flight. The slop tax is kept apart. */
export async function poolBalance(svc: Services): Promise<PoolBalance> {
  const fundings = (await svc.db.fundings.list()).filter((f) => f.programId === svc.program.id && f.status === "COMPLETED");
  const payouts = await svc.db.payouts.list();
  const deposits = await svc.db.deposits.list();
  const minor = (list: Money[]) => list.reduce((acc, m) => acc + (m.currency === "USD" ? toMinor(m) : 0), 0);
  const funded = minor(fundings.map((f) => f.amount));
  const paid = minor(payouts.filter((p) => p.status === "SUCCESS").map((p) => p.amount));
  const committed = minor(payouts.filter((p) => !["SUCCESS", "FAILED", "RETURNED", "REVERSED", "DENIED", "CANCELED"].includes(p.status)).map((p) => p.amount));
  const slop = minor(deposits.filter((d) => d.status === "CAPTURED").map((d) => d.amount));
  const usd = (n: number): Money => fromMinor(n, "USD");
  return { funded: usd(funded), paid: usd(paid), committed: usd(committed), available: usd(funded - paid - committed), slopTax: usd(slop), sponsors: new Set(fundings.map((f) => f.sponsor.toLowerCase())).size };
}
