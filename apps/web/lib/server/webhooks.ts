/**
 * PayPal webhooks: verified with PayPal's verify-webhook-signature postback (or the mock's own
 * signature check), deduplicated by event id, then applied to deposit, payout and funding state.
 * Webhooks only record what PayPal already did, or finish a payment the payer already approved (they
 * authorize an approved deposit or capture an approved sponsor order); they never release, capture or
 * pay a deposit or a bounty on their own.
 */
import type { PayPalWebhookEvent } from "@goodfaith/paypal";
import { isMockPayPal } from "@goodfaith/paypal";
import { approveDeposit, noteOrderApproved } from "./deposits";
import { appendLedger } from "./ledger";
import { applyPayoutBatch, statusRank } from "./payouts";
import type { Services } from "./services";
import { captureFunding } from "./sponsor";
import { type DepositRecord, KEEP, StoreConflictError } from "./store";

export type WebhookResult = { status: number; outcome: string };

type Resource = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Resource => (v && typeof v === "object" ? (v as Resource) : {});

function relatedIds(resource: Resource): { orderId?: string; authorizationId?: string } {
  const related = obj(obj(resource.supplementary_data).related_ids);
  const up = Array.isArray(resource.links) ? (resource.links as Resource[]).find((l) => l.rel === "up") : undefined;
  const upHref = str(up?.href);
  const fromUp = (kind: string) => (upHref?.includes(`/${kind}/`) ? upHref.split("/").pop() : undefined);
  return {
    ...((str(related.order_id) ?? fromUp("orders")) ? { orderId: (str(related.order_id) ?? fromUp("orders")) as string } : {}),
    ...((str(related.authorization_id) ?? fromUp("authorizations")) ? { authorizationId: (str(related.authorization_id) ?? fromUp("authorizations")) as string } : {}),
  };
}

async function depositWhere(svc: Services, match: (d: DepositRecord) => boolean): Promise<DepositRecord | undefined> {
  return (await svc.db.deposits.list()).find(match);
}

function webhookIdFor(svc: Services): string | undefined {
  return isMockPayPal(svc.paypal) ? svc.paypal.webhookId : svc.config.webhookId;
}

export async function handleWebhook(svc: Services, req: { headers: Record<string, string>; body: string }): Promise<WebhookResult> {
  const webhookId = webhookIdFor(svc);
  if (!webhookId) return { status: 503, outcome: "PAYPAL_WEBHOOK_ID is not configured: refusing unverifiable webhooks" };
  // A 5xx or network failure while verifying throws, so PayPal redelivers later.
  const verified = await svc.paypal.verifyWebhookSignature({ headers: req.headers, body: req.body, webhookId });
  if (!verified) return { status: 400, outcome: "Signature verification failed" };

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(req.body) as PayPalWebhookEvent;
  } catch {
    return { status: 400, outcome: "Body is not JSON" };
  }
  const resource = obj(event.resource);
  const receivedAt = svc.now().toISOString();
  try {
    await svc.db.webhooks.create(event.id, {
      id: event.id,
      eventType: event.event_type,
      resourceType: event.resource_type,
      ...(str(resource.id) ? { resourceId: str(resource.id) as string } : {}),
      summary: event.summary,
      receivedAt,
      outcome: "processing",
    });
  } catch (e) {
    if (e instanceof StoreConflictError) return { status: 200, outcome: "Duplicate delivery ignored" };
    throw e;
  }

  const outcome = await dispatch(svc, event, resource);
  await svc.db.webhooks.update(event.id, (w) => (w ? { ...w, outcome } : KEEP));
  return { status: 200, outcome };
}

async function dispatch(svc: Services, event: PayPalWebhookEvent, resource: Resource): Promise<string> {
  const type = event.event_type;
  const at = svc.now().toISOString();
  const trail = async (reportId: string | undefined, summary: string, ids: Record<string, string>) =>
    appendLedger(svc, { op: "webhook", ok: true, ...(reportId ? { reportId } : {}), summary: `Webhook ${type}: ${summary}`, ids: { eventId: event.id, ...ids }, ...(str(resource.status) ? { status: str(resource.status) as string } : {}) });

  switch (type) {
    case "CHECKOUT.ORDER.APPROVED": {
      const orderId = str(resource.id);
      if (!orderId) return "No order id";
      const dep = await depositWhere(svc, (d) => d.orderId === orderId);
      if (dep) {
        await noteOrderApproved(svc, dep.reportId, orderId);
        await trail(dep.reportId, "the researcher approved the deposit", { orderId });
        // Finish what the researcher approved even if their browser never called back.
        svc.defer(async () => {
          await approveDeposit(svc, dep.reportId, { orderId }).catch(() => undefined);
        });
        return `Deposit ${dep.reportId} approved; authorizing`;
      }
      if (await svc.db.fundings.value(orderId)) {
        await trail(undefined, "a sponsor approved a pool contribution", { orderId });
        svc.defer(async () => {
          await captureFunding(svc, orderId).catch(() => undefined);
        });
        return `Sponsor order ${orderId} approved; capturing`;
      }
      return "Order not ours";
    }

    case "PAYMENT.AUTHORIZATION.CREATED":
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      const authorizationId = str(resource.id);
      const { orderId } = relatedIds(resource);
      const dep = await depositWhere(svc, (d) => (!!authorizationId && d.authorizationId === authorizationId) || (!!orderId && d.orderId === orderId));
      if (!dep) return "Authorization not ours";
      if (type === "PAYMENT.AUTHORIZATION.VOIDED") {
        await svc.db.deposits.update(dep.reportId, (d) => {
          if (!d || d.status === "VOIDED") return KEEP;
          if (d.status === "CAPTURED" || d.status === "CAPTURING") return KEEP; // cannot both be true; keep our record
          return { ...d, status: "VOIDED", voidedAt: d.voidedAt ?? at, resolution: d.resolution ?? { action: "void", requestId: "external", claimedAt: at, completedAt: at }, updatedAt: at };
        });
        await trail(dep.reportId, "PayPal confirms the hold is voided", { authorizationId: authorizationId ?? "" });
        svc.signals.notify(dep.reportId);
        return `Deposit ${dep.reportId} voided`;
      }
      await svc.db.deposits.update(dep.reportId, (d) =>
        d && authorizationId && !d.authorizationId ? { ...d, authorizationId, authorizationStatus: str(resource.status) ?? "CREATED", updatedAt: at } : KEEP,
      );
      await trail(dep.reportId, "PayPal confirms the hold", { authorizationId: authorizationId ?? "" });
      svc.signals.notify(dep.reportId);
      return `Deposit ${dep.reportId} authorization recorded`;
    }

    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      const captureId = str(resource.id);
      const { orderId, authorizationId } = relatedIds(resource);
      const dep = await depositWhere(svc, (d) => (!!authorizationId && d.authorizationId === authorizationId) || (!!captureId && d.captureId === captureId));
      if (dep) {
        await svc.db.deposits.update(dep.reportId, (d) => {
          if (!d) return KEEP;
          if (type === "PAYMENT.CAPTURE.COMPLETED" && d.status !== "CAPTURED" && d.resolution?.action !== "void") {
            return { ...d, status: "CAPTURED", captureId: captureId ?? d.captureId, captureStatus: "COMPLETED", capturedAt: d.capturedAt ?? at, updatedAt: at } as DepositRecord;
          }
          return captureId && d.captureId === captureId ? { ...d, captureStatus: str(resource.status) ?? d.captureStatus, updatedAt: at } as DepositRecord : KEEP;
        });
        await trail(dep.reportId, `deposit capture is ${str(resource.status) ?? type.split(".").pop()}`, { ...(captureId ? { captureId } : {}) });
        svc.signals.notify(dep.reportId);
        return `Deposit ${dep.reportId} capture ${type.split(".").pop()}`;
      }
      const fundingId = orderId && (await svc.db.fundings.value(orderId)) ? orderId : undefined;
      if (fundingId) {
        await svc.db.fundings.update(fundingId, (f) =>
          f ? { ...f, ...(captureId ? { captureId } : {}), captureStatus: str(resource.status) ?? f.captureStatus, ...(type === "PAYMENT.CAPTURE.COMPLETED" ? { status: "COMPLETED" as const } : {}), updatedAt: at } : KEEP,
        );
        await trail(undefined, `pool contribution capture is ${str(resource.status) ?? "updated"}`, { orderId: fundingId, ...(captureId ? { captureId } : {}) });
        return `Funding ${fundingId} capture ${type.split(".").pop()}`;
      }
      return "Capture not ours";
    }

    case "PAYMENT.PAYOUTSBATCH.PROCESSING":
    case "PAYMENT.PAYOUTSBATCH.SUCCESS":
    case "PAYMENT.PAYOUTSBATCH.DENIED": {
      const header = obj(resource.batch_header);
      const batchId = str(header.payout_batch_id);
      const status = str(header.batch_status);
      const payout = batchId ? (await svc.db.payouts.list()).find((p) => p.batchId === batchId) : undefined;
      if (!payout || !batchId) return "Payout batch not ours";
      await svc.db.payouts.update(payout.reportId, (p) =>
        p && status && p.batchStatus !== status && statusRank(status) >= statusRank(p.batchStatus) ? { ...p, batchStatus: status, updatedAt: at } : KEEP,
      );
      await trail(payout.reportId, `payout batch is ${status}`, { batchId });
      svc.signals.notify(payout.reportId);
      return `Payout batch ${batchId} ${status}`;
    }

    default: {
      if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
        const batchId = str(resource.payout_batch_id);
        const itemId = str(resource.payout_item_id);
        const payout = batchId ? (await svc.db.payouts.list()).find((p) => p.batchId === batchId) : undefined;
        if (!payout || !batchId) return "Payout item not ours";
        const item = obj(resource.payout_item);
        const fee = obj(resource.payout_item_fee);
        const errors = obj(resource.errors);
        await applyPayoutBatch(svc, payout.reportId, {
          batchId,
          status: payout.batchStatus ?? "PROCESSING",
          items: [
            {
              itemId: itemId ?? "",
              batchId,
              status: str(resource.transaction_status) ?? "PENDING",
              receiver: str(item.receiver) ?? payout.receiver,
              amount: payout.amount,
              senderItemId: str(item.sender_item_id) ?? payout.reportId,
              ...(str(resource.transaction_id) ? { transactionId: str(resource.transaction_id) as string } : {}),
              ...(str(fee.value) && str(fee.currency) ? { fee: { currency: str(fee.currency) as string, value: str(fee.value) as string } } : {}),
              ...(str(errors.name) ? { error: { name: str(errors.name) as string, ...(str(errors.message) ? { message: str(errors.message) as string } : {}) } } : {}),
            },
          ],
        });
        return `Payout item ${itemId} ${str(resource.transaction_status)}`;
      }
      if (type.startsWith("CUSTOMER.DISPUTE.")) {
        const txns = Array.isArray(resource.disputed_transactions) ? (resource.disputed_transactions as Resource[]) : [];
        const captureId = str(txns[0]?.seller_transaction_id);
        const dep = captureId ? await depositWhere(svc, (d) => d.captureId === captureId) : undefined;
        if (!dep) return "Dispute not about a deposit";
        const disputeId = str(resource.dispute_id) ?? "";
        await svc.db.deposits.update(dep.reportId, (d) =>
          d ? { ...d, dispute: { id: disputeId, status: str(resource.status) ?? "OPEN", ...(str(resource.reason) ? { reason: str(resource.reason) as string } : {}), updatedAt: at }, updatedAt: at } : KEEP,
        );
        await trail(dep.reportId, `the researcher disputed the captured deposit (${str(resource.status) ?? "OPEN"})`, { disputeId });
        svc.signals.notify(dep.reportId);
        return `Dispute ${disputeId} recorded on ${dep.reportId}`;
      }
      return "Event type not handled";
    }
  }
}
