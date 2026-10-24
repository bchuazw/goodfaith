/**
 * The refundable deposit behind a bounty claim: an Orders v2 AUTHORIZE order. The researcher approves
 * it in PayPal (JS SDK v6 in live mode, the mock sheet in mock mode); authorizing it places a hold, not
 * a charge, and makes triage due. Every PayPal call uses a fixed PayPal-Request-Id, and every state
 * change is a compare-and-set, so double clicks, webhook/browser races and retries converge.
 */
import { isMockPayPal } from "@goodfaith/paypal";
import { AppError, notFound, paypalErrorInfo, paypalFailure, paypalIssue } from "./errors";
import { requestIds } from "./ids";
import { paypalCall } from "./ledger";
import { formatMoney } from "../money";
import type { Services } from "./services";
import { type DepositRecord, KEEP, type ReportRecord } from "./store";
import { queuedForTriage, runTriage } from "./triage";

const HONOR_PERIOD_MS = 3 * 24 * 3600 * 1000;
const OPEN: ReadonlyArray<DepositRecord["status"]> = ["CREATED", "APPROVED"];
const HELD_OR_RESOLVED: ReadonlyArray<DepositRecord["status"]> = ["AUTHORIZED", "VOIDING", "VOIDED", "CAPTURING", "CAPTURED"];

async function bountyClaimAwaitingDeposit(svc: Services, reportId: string): Promise<ReportRecord> {
  const report = await svc.db.reports.value(reportId);
  if (!report) throw notFound("Report");
  if (report.kind !== "bounty") throw new AppError("NOT_A_BOUNTY_CLAIM", "Free reports need no deposit", 409);
  return report;
}

/** Creates (or reuses) the AUTHORIZE order for a bounty claim's deposit. */
export async function createDepositOrder(svc: Services, reportId: string, opts: { origin: string }): Promise<{ deposit: DepositRecord; approveUrl?: string }> {
  const report = await bountyClaimAwaitingDeposit(svc, reportId);
  const existing = await svc.db.deposits.value(reportId);
  if (existing && HELD_OR_RESOLVED.includes(existing.status)) return { deposit: existing };
  if (report.status !== "awaiting_deposit") throw new AppError("DEPOSIT_NOT_NEEDED", "This report does not need a deposit", 409);
  if (existing && OPEN.includes(existing.status)) {
    // Reuse the open order: a second click must not create a second hold.
    const order = await svc.paypal.getOrder(existing.orderId).catch(() => undefined);
    if (order && (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED" || order.status === "APPROVED")) {
      return { deposit: existing, ...(order.approveUrl ? { approveUrl: order.approveUrl } : {}) };
    }
  }

  const attempt = (existing?.orderAttempt ?? 0) + 1;
  const amount = svc.program.deposit;
  const order = await paypalCall(
    svc,
    "orders.create",
    { reportId },
    () =>
      svc.paypal.createOrder({
        intent: "AUTHORIZE",
        amount,
        description: `Refundable deposit for bounty claim ${reportId} (${svc.program.name})`,
        customId: reportId,
        invoiceId: `gf-dep-${reportId}-${attempt}`,
        items: [{ name: `${svc.program.name} bounty claim deposit (refundable hold)`, sku: "gf-deposit", unitAmount: amount, quantity: 1, category: "DIGITAL_GOODS" }],
        returnUrl: `${opts.origin}/r/${reportId}?deposit=approved`,
        cancelUrl: `${opts.origin}/r/${reportId}?deposit=cancelled`,
        requestId: requestIds.depositOrder(reportId, attempt),
      }),
    (o) => ({ summary: `Created AUTHORIZE order for the ${formatMoney(amount)} deposit`, ids: { orderId: o.id }, status: o.status }),
    "Could not create the deposit order",
  ).catch((e) => {
    throw paypalFailure("create the deposit order", e);
  });

  const now = svc.now().toISOString();
  const fresh: DepositRecord = { reportId, amount, status: "CREATED", orderId: order.id, orderAttempt: attempt, source: "buyer", createdAt: now, updatedAt: now };
  const res = await svc.db.deposits.update(reportId, (cur) => (!cur || cur.orderAttempt < attempt || cur.status === "FAILED" ? fresh : KEEP));
  svc.signals.notify(reportId);
  // If another request won the race, answer with its order: PayPal deduped ours by request id anyway.
  return { deposit: res.value ?? fresh, ...(order.approveUrl && res.value?.orderId === order.id ? { approveUrl: order.approveUrl } : {}) };
}

/**
 * The researcher approved the order in PayPal: authorize it (place the hold) and start triage. Safe to
 * call twice, from the browser's onApprove and from the CHECKOUT.ORDER.APPROVED webhook.
 */
export async function approveDeposit(svc: Services, reportId: string, opts: { orderId: string }): Promise<DepositRecord> {
  await bountyClaimAwaitingDeposit(svc, reportId);
  const dep = await svc.db.deposits.value(reportId);
  if (!dep) throw notFound("Deposit");
  if (dep.orderId !== opts.orderId) throw new AppError("ORDER_MISMATCH", "That PayPal order is not this report's deposit", 409);
  if (HELD_OR_RESOLVED.includes(dep.status)) {
    await markQueued(svc, reportId);
    return dep;
  }

  let auth: Awaited<ReturnType<typeof svc.paypal.authorizeOrder>>;
  try {
    auth = await paypalCall(
      svc,
      "orders.authorize",
      { reportId },
      () => svc.paypal.authorizeOrder(dep.orderId, requestIds.authorize(reportId, dep.orderAttempt)),
      (r) => ({
        summary: `Authorized the ${formatMoney(dep.amount)} hold (not a charge)`,
        ids: { orderId: r.id, ...(r.authorizationId ? { authorizationId: r.authorizationId } : {}) },
        ...(r.authorizationStatus ? { status: r.authorizationStatus } : {}),
      }),
      "Could not authorize the deposit",
    );
  } catch (e) {
    const issue = paypalIssue(e);
    const at = svc.now().toISOString();
    await svc.db.deposits.update(reportId, (cur) =>
      cur && OPEN.includes(cur.status) ? { ...cur, lastError: { code: issue ?? paypalErrorInfo(e).name, message: paypalErrorInfo(e).message, ...(paypalErrorInfo(e).debugId ? { debugId: paypalErrorInfo(e).debugId as string } : {}), at }, updatedAt: at } : KEEP,
    );
    if (issue === "ORDER_NOT_APPROVED") throw new AppError("ORDER_NOT_APPROVED", "PayPal has not approved this order yet", 409);
    throw paypalFailure("authorize the deposit", e);
  }
  if (!auth.authorizationId) throw new AppError("PAYPAL_ERROR", "PayPal authorized the order but returned no authorization id", 502);

  const payerEmail = await svc.paypal
    .getOrder(dep.orderId)
    .then((o) => o.payerEmail)
    .catch(() => undefined);
  const now = svc.now();
  const res = await svc.db.deposits.update(reportId, (cur) => {
    if (!cur || !OPEN.includes(cur.status)) return KEEP;
    return {
      ...cur,
      status: "AUTHORIZED",
      authorizationId: auth.authorizationId as string,
      ...(auth.authorizationStatus ? { authorizationStatus: auth.authorizationStatus } : {}),
      ...(auth.expiresAt ? { authorizationExpiresAt: auth.expiresAt } : {}),
      honorUntil: new Date(now.getTime() + HONOR_PERIOD_MS).toISOString(),
      ...(payerEmail ? { payerEmail } : {}),
      approvedAt: cur.approvedAt ?? now.toISOString(),
      authorizedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  });
  await markQueued(svc, reportId);
  return res.value as DepositRecord;
}

/** Deposit held: the bounty claim is due for triage (once). */
async function markQueued(svc: Services, reportId: string): Promise<void> {
  const nowIso = svc.now().toISOString();
  const res = await svc.db.reports.update(reportId, (r) => (r && r.status === "awaiting_deposit" ? queuedForTriage(r, nowIso) : KEEP));
  svc.signals.notify(reportId);
  if (res.changed) svc.defer(() => runTriage(svc, reportId));
}

/** PayPal reported the order approved (webhook) before the browser called back. */
export async function noteOrderApproved(svc: Services, reportId: string, orderId: string): Promise<void> {
  const at = svc.now().toISOString();
  await svc.db.deposits.update(reportId, (cur) => (cur && cur.orderId === orderId && cur.status === "CREATED" ? { ...cur, status: "APPROVED", approvedAt: at, updatedAt: at } : KEEP));
  svc.signals.notify(reportId);
}

/**
 * Judge mode: post the deposit without a PayPal login. Mock mode simulates the researcher's approval
 * on the mock sheet; live mode charges an authorization hold to the demo researcher's vaulted sandbox
 * wallet (PAYPAL_SANDBOX_VAULT_ID), a real merchant-initiated AUTHORIZE order.
 */
export async function postDemoDeposit(svc: Services, reportId: string, opts: { origin: string; payerEmail?: string }): Promise<DepositRecord> {
  const report = await bountyClaimAwaitingDeposit(svc, reportId);
  if (isMockPayPal(svc.paypal)) {
    const { deposit } = await createDepositOrder(svc, reportId, opts);
    if (deposit.status === "CREATED") svc.paypal.simulateBuyerApproval(deposit.orderId, opts.payerEmail ? { email: opts.payerEmail } : undefined);
    return approveDeposit(svc, reportId, { orderId: deposit.orderId });
  }
  const vaultId = svc.config.sandboxVaultId;
  if (!vaultId) throw new AppError("DEMO_NEEDS_APPROVAL", "No saved sandbox wallet (PAYPAL_SANDBOX_VAULT_ID): approve the deposit with the PayPal button instead", 409);
  if (report.status !== "awaiting_deposit") {
    const dep = await svc.db.deposits.value(reportId);
    if (dep) return dep;
    throw new AppError("DEPOSIT_NOT_NEEDED", "This report does not need a deposit", 409);
  }
  const existing = await svc.db.deposits.value(reportId);
  if (existing && HELD_OR_RESOLVED.includes(existing.status)) return existing;

  const attempt = (existing?.orderAttempt ?? 0) + 1;
  const amount = svc.program.deposit;
  const order = await paypalCall(
    svc,
    "orders.create",
    { reportId },
    () =>
      svc.paypal.createOrder({
        intent: "AUTHORIZE",
        amount,
        vaultId,
        description: `Refundable deposit for bounty claim ${reportId} (${svc.program.name})`,
        customId: reportId,
        invoiceId: `gf-dep-${reportId}-${attempt}`,
        items: [{ name: `${svc.program.name} bounty claim deposit (refundable hold)`, sku: "gf-deposit", unitAmount: amount, quantity: 1, category: "DIGITAL_GOODS" }],
        requestId: requestIds.depositOrder(reportId, attempt),
      }),
    (o) => ({
      summary: `Authorized the ${formatMoney(amount)} hold on the demo researcher's saved sandbox wallet`,
      ids: { orderId: o.id, ...(o.authorizationId ? { authorizationId: o.authorizationId } : {}) },
      ...(o.authorizationStatus ? { status: o.authorizationStatus } : {}),
    }),
    "Could not authorize the demo deposit",
  ).catch((e) => {
    throw paypalFailure("authorize the demo deposit", e);
  });
  if (!order.authorizationId) throw new AppError("PAYPAL_ERROR", "PayPal returned no authorization for the vaulted deposit", 502);
  const details = await svc.paypal.getOrder(order.id).catch(() => undefined);
  const now = svc.now();
  const fresh: DepositRecord = {
    reportId,
    amount,
    status: "AUTHORIZED",
    orderId: order.id,
    orderAttempt: attempt,
    source: "vault",
    authorizationId: order.authorizationId,
    ...(order.authorizationStatus ? { authorizationStatus: order.authorizationStatus } : {}),
    honorUntil: new Date(now.getTime() + HONOR_PERIOD_MS).toISOString(),
    ...(details?.payerEmail ? { payerEmail: details.payerEmail } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvedAt: now.toISOString(),
    authorizedAt: now.toISOString(),
  };
  const res = await svc.db.deposits.update(reportId, (cur) => (!cur || !HELD_OR_RESOLVED.includes(cur.status) ? fresh : KEEP));
  await markQueued(svc, reportId);
  return res.value ?? fresh;
}
