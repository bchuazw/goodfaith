/**
 * Payout status. PayPal processes a batch asynchronously (PENDING to SUCCESS in about 30 s on the
 * sandbox), so status arrives three ways: polling right after the payout (inside the settling request's
 * `after()`), the PAYMENT.PAYOUTS-ITEM.* webhooks, and an on-read refresh when a viewer looks at a payout
 * that is still pending. All three write through the same compare-and-set update.
 */
import type { PayoutBatch } from "@goodfaith/paypal";
import { appendLedger } from "./ledger";
import type { Services } from "./services";
import { KEEP, type PayoutRecord } from "./store";

/** Item statuses after which nothing changes without the receiver acting (UNCLAIMED waits up to 30 days). */
export const FINAL_PAYOUT_STATUSES = new Set(["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "UNCLAIMED", "DENIED", "CANCELED"]);

export const isPayoutFinal = (p: Pick<PayoutRecord, "status" | "batchStatus">) =>
  FINAL_PAYOUT_STATUSES.has(p.status) || p.batchStatus === "DENIED" || p.batchStatus === "CANCELED";

/**
 * Webhooks can arrive out of order (PROCESSING after SUCCESS), so a status only moves forward:
 * CREATING < PENDING < PROCESSING < anything final. UNCLAIMED may still become SUCCESS when claimed.
 */
export function statusRank(status: string | undefined): number {
  if (!status || status === "CREATING") return 0;
  if (status === "PENDING" || status === "NEW") return 1;
  if (status === "PROCESSING" || status === "ONHOLD") return 2;
  if (status === "UNCLAIMED") return 3;
  return 4;
}

/** Applies what PayPal said about a batch (from a read or a webhook) to the payout record. */
export async function applyPayoutBatch(svc: Services, reportId: string, batch: Pick<PayoutBatch, "batchId" | "status" | "items">): Promise<PayoutRecord | undefined> {
  const at = svc.now().toISOString();
  let before: string | undefined;
  const res = await svc.db.payouts.update(reportId, (p) => {
    if (!p || (p.batchId && p.batchId !== batch.batchId)) return KEEP;
    before = `${p.status}/${p.batchStatus ?? ""}`;
    const item = batch.items.find((i) => i.senderItemId === reportId) ?? batch.items[0];
    const itemForward = item && statusRank(String(item.status)) >= statusRank(p.status);
    const next: PayoutRecord = {
      ...p,
      batchId: batch.batchId,
      batchStatus: statusRank(batch.status) >= statusRank(p.batchStatus) ? batch.status : (p.batchStatus as string),
      ...(item && itemForward
        ? {
            status: String(item.status),
            itemId: item.itemId,
            ...(item.transactionId ? { transactionId: item.transactionId } : {}),
            ...(item.fee ? { fee: item.fee } : {}),
            ...(item.error ? { error: item.error } : {}),
          }
        : {}),
      checkedAt: at,
      updatedAt: at,
    };
    if (isPayoutFinal(next) && !p.completedAt) next.completedAt = at;
    return next;
  });
  const after = res.value ? `${res.value.status}/${res.value.batchStatus ?? ""}` : undefined;
  if (res.changed && res.value && after !== before) {
    await appendLedger(svc, {
      op: "payouts.get",
      ok: true,
      reportId,
      summary: `Payout is ${res.value.status}${res.value.error?.name ? ` (${res.value.error.name})` : ""}; batch ${res.value.batchStatus ?? "unknown"}`,
      ids: { batchId: batch.batchId, ...(res.value.itemId ? { itemId: res.value.itemId } : {}), ...(res.value.transactionId ? { transactionId: res.value.transactionId } : {}) },
      status: res.value.status,
    });
  }
  svc.signals.notify(reportId);
  return res.value;
}

/** Reads the batch from PayPal once and records the result. */
export async function refreshPayout(svc: Services, reportId: string): Promise<PayoutRecord | undefined> {
  const payout = await svc.db.payouts.value(reportId);
  if (!payout?.batchId || !svc.paypal.getPayoutBatch) return payout;
  const batch = await svc.paypal.getPayoutBatch(payout.batchId);
  return applyPayoutBatch(svc, reportId, batch);
}

/** Polls until the payout is final or `budgetMs` runs out (well inside the 300 s function limit). */
export async function pollPayout(svc: Services, reportId: string, opts: { budgetMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.budgetMs ?? 150_000);
  for (const wait of [1500, 3000, 5000, 8000, 10_000, 15_000, 15_000, 20_000, 20_000, 30_000, 30_000]) {
    try {
      const p = await refreshPayout(svc, reportId);
      if (!p || isPayoutFinal(p)) return;
    } catch (e) {
      console.error(`[goodfaith] payout refresh for ${reportId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Date.now() + wait > deadline) return;
    await sleep(wait);
  }
}

/** On-read refresh, throttled: a pending payout seen by a viewer is re-read at most every 8 s. */
export function maybeRefreshPayout(svc: Services, payout: PayoutRecord | undefined): void {
  if (!payout?.batchId || isPayoutFinal(payout)) return;
  const last = Date.parse(payout.checkedAt ?? payout.updatedAt);
  if (Number.isFinite(last) && svc.now().getTime() - last < 8_000) return;
  svc.defer(async () => {
    await refreshPayout(svc, payout.reportId);
  });
}
