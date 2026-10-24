/**
 * PayPal JSON -> result types. Responses are validated with lenient zod schemas: only
 * the fields we read are checked, everything else stays available in `raw`. Shared by the real
 * client and the mock so both produce identical results from identical PayPal-shaped data.
 */
import { z } from "zod";
import { LOCAL_ERROR, PayPalError } from "./errors.js";
import { fromPayPalMoney } from "./money.js";
import type {
  CreateOrderResult,
  DisputeDetails,
  DisputeSummary,
  Money,
  OrderDetails,
  PaymentToken,
  PayoutBatch,
  PayoutItem,
  TransactionRecord,
  VaultSetupToken,
} from "./types.js";

const linkSchema = z.object({ href: z.string(), rel: z.string(), method: z.string().optional() });
const ppMoneySchema = z.object({ currency_code: z.string(), value: z.string() });

export type PayPalLink = z.infer<typeof linkSchema>;

function parseResponse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new PayPalError({
    status: 200,
    name: LOCAL_ERROR.unexpectedResponse,
    message: `PayPal ${what} response did not match the expected shape${first ? ` (${first.path.join(".") || "root"}: ${first.message})` : ""}`,
  });
}

export function findLink(links: readonly PayPalLink[] | undefined, rel: string): string | undefined {
  return links?.find((l) => l.rel === rel)?.href;
}

/** Last path segment of a HATEOAS href, e.g. the dispute id in .../v1/customer/disputes/PP-D-27803. */
export function idFromHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const segments = new URL(href).pathname.split("/").filter(Boolean);
    return segments.at(-1);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------------

const setupTokenSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  customer: z.object({ id: z.string().optional() }).optional(),
  links: z.array(linkSchema).optional(),
});

export function mapSetupToken(raw: unknown): VaultSetupToken {
  const t = parseResponse(setupTokenSchema, raw, "setup token");
  return {
    id: t.id,
    // No approve link means no payer action is pending (e.g. an idempotent replay after approval).
    approveUrl: findLink(t.links, "approve") ?? "",
    status: t.status ?? "CREATED",
    ...(t.customer?.id ? { customerId: t.customer.id } : {}),
  };
}

const paymentTokenSchema = z.object({
  id: z.string().min(1),
  customer: z.object({ id: z.string().optional() }).optional(),
  payment_source: z
    .object({
      paypal: z.object({ email_address: z.string().optional(), payer_id: z.string().optional() }).optional(),
    })
    .optional(),
});

export function mapPaymentToken(raw: unknown): PaymentToken {
  const t = parseResponse(paymentTokenSchema, raw, "payment token");
  const paypal = t.payment_source?.paypal;
  return {
    vaultId: t.id,
    customerId: t.customer?.id ?? "",
    ...(paypal?.email_address ? { payerEmail: paypal.email_address } : {}),
    ...(paypal?.payer_id ? { payerId: paypal.payer_id } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

const paymentSchema = z.object({ id: z.string(), status: z.string().optional(), expiration_time: z.string().optional() });

const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  intent: z.string().optional(),
  payment_source: z.object({ paypal: z.object({ email_address: z.string().optional() }).optional() }).optional(),
  payer: z.object({ email_address: z.string().optional() }).optional(),
  purchase_units: z
    .array(
      z.object({
        amount: ppMoneySchema.optional(),
        custom_id: z.string().optional(),
        invoice_id: z.string().optional(),
        payments: z
          .object({
            captures: z.array(paymentSchema).optional(),
            authorizations: z.array(paymentSchema).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  links: z.array(linkSchema).optional(),
});

export function summarizeOrder(raw: unknown): OrderDetails {
  const o = parseResponse(orderSchema, raw, "order");
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const authorization = unit?.payments?.authorizations?.[0];
  const approveUrl = findLink(o.links, "payer-action") ?? findLink(o.links, "approve");
  // Some documented responses omit status (e.g. return=minimal, or the vault AUTHORIZE example);
  // infer it from the links, or from the payments that only exist on completed orders.
  const status =
    o.status ??
    (findLink(o.links, "payer-action")
      ? "PAYER_ACTION_REQUIRED"
      : findLink(o.links, "approve")
        ? "CREATED"
        : capture || authorization
          ? "COMPLETED"
          : "UNKNOWN");
  const payerEmail = o.payment_source?.paypal?.email_address ?? o.payer?.email_address;
  return {
    id: o.id,
    status,
    raw,
    ...(o.intent ? { intent: o.intent } : {}),
    ...(unit?.amount ? { amount: fromPayPalMoney(unit.amount) } : {}),
    ...(unit?.custom_id ? { customId: unit.custom_id } : {}),
    ...(unit?.invoice_id ? { invoiceId: unit.invoice_id } : {}),
    ...(capture ? { captureId: capture.id } : {}),
    ...(capture?.status ? { captureStatus: capture.status } : {}),
    ...(authorization ? { authorizationId: authorization.id } : {}),
    ...(authorization?.status ? { authorizationStatus: authorization.status } : {}),
    ...(payerEmail ? { payerEmail } : {}),
    ...(approveUrl && (status === "PAYER_ACTION_REQUIRED" || status === "CREATED") ? { approveUrl } : {}),
  };
}

export function orderResult(d: OrderDetails): CreateOrderResult {
  return {
    id: d.id,
    status: d.status,
    ...(d.approveUrl ? { approveUrl: d.approveUrl } : {}),
    ...(d.captureId ? { captureId: d.captureId } : {}),
    ...(d.captureStatus ? { captureStatus: d.captureStatus } : {}),
    ...(d.authorizationId ? { authorizationId: d.authorizationId } : {}),
    ...(d.authorizationStatus ? { authorizationStatus: d.authorizationStatus } : {}),
  };
}

export function authorizationExpiry(raw: unknown): string | undefined {
  const o = orderSchema.safeParse(raw);
  return o.success ? o.data.purchase_units?.[0]?.payments?.authorizations?.[0]?.expiration_time : undefined;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

const resourceStatusSchema = z.object({ id: z.string().min(1), status: z.string().optional() });

export function mapIdStatus(raw: unknown, what: string): { id: string; status: string } {
  const r = parseResponse(resourceStatusSchema, raw, what);
  return { id: r.id, status: r.status ?? "UNKNOWN" };
}

const capturedPaymentSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  amount: ppMoneySchema.optional(),
  payee: z.object({ merchant_id: z.string().optional(), email_address: z.string().optional() }).optional(),
});

export function mapCapturedPayment(raw: unknown) {
  return parseResponse(capturedPaymentSchema, raw, "capture");
}

// ---------------------------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------------------------

const disputeTxnSchema = z.object({
  buyer_transaction_id: z.string().optional(),
  seller_transaction_id: z.string().optional(),
  custom: z.string().optional(),
  gross_amount: ppMoneySchema.optional(),
});

const disputeSchema = z.object({
  dispute_id: z.string().min(1),
  reason: z.string().optional(),
  status: z.string().optional(),
  dispute_state: z.string().optional(),
  dispute_amount: ppMoneySchema.optional(),
  dispute_life_cycle_stage: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  seller_response_due_date: z.string().optional(),
  disputed_transactions: z.array(disputeTxnSchema).optional(),
  evidences: z.array(z.object({ evidence_type: z.string().optional(), source: z.string().optional() })).optional(),
  dispute_outcome: z.object({ outcome_code: z.string().optional() }).optional(),
  links: z.array(linkSchema).optional(),
});

const NO_AMOUNT: Money = { currency: "XXX", value: "0" };

function disputeCore(d: z.infer<typeof disputeSchema>) {
  const txn = d.disputed_transactions?.[0];
  const transactionId = txn?.seller_transaction_id ?? txn?.buyer_transaction_id;
  const money = d.dispute_amount ?? txn?.gross_amount;
  return {
    id: d.dispute_id,
    status: d.status ?? "OTHER",
    reason: d.reason ?? "OTHER",
    amount: money ? fromPayPalMoney(money) : NO_AMOUNT,
    ...(transactionId ? { transactionId } : {}),
    ...(d.dispute_life_cycle_stage ? { stage: d.dispute_life_cycle_stage } : {}),
    ...(d.dispute_state ? { state: d.dispute_state } : {}),
  };
}

export function mapDisputeSummary(raw: unknown): DisputeSummary {
  const d = parseResponse(disputeSchema, raw, "dispute");
  return {
    ...disputeCore(d),
    ...(d.create_time ? { createdAt: d.create_time } : {}),
    ...(d.update_time ? { updatedAt: d.update_time } : {}),
  };
}

export function mapDisputeDetails(raw: unknown): DisputeDetails {
  const d = parseResponse(disputeSchema, raw, "dispute");
  const custom = d.disputed_transactions?.[0]?.custom;
  return {
    ...disputeCore(d),
    raw,
    ...(custom ? { customId: custom } : {}),
    ...(d.seller_response_due_date ? { sellerResponseDueDate: d.seller_response_due_date } : {}),
    allowedActions: (d.links ?? []).map((l) => l.rel).filter((rel) => rel !== "self"),
    requestedEvidence: (d.evidences ?? [])
      .filter((e) => e.source === "REQUESTED_FROM_SELLER" && e.evidence_type)
      .map((e) => e.evidence_type as string),
    ...(d.dispute_outcome?.outcome_code ? { outcome: d.dispute_outcome.outcome_code } : {}),
  };
}

const disputeListSchema = z.object({ items: z.array(z.unknown()).optional(), links: z.array(linkSchema).optional() });

export function parseDisputeList(raw: unknown) {
  return parseResponse(disputeListSchema, raw ?? {}, "dispute list");
}

// ---------------------------------------------------------------------------------------------
// Transaction Search
// ---------------------------------------------------------------------------------------------

const transactionInfoSchema = z.object({
  transaction_id: z.string().min(1),
  transaction_event_code: z.string().optional(),
  transaction_initiation_date: z.string().optional(),
  transaction_updated_date: z.string().optional(),
  transaction_amount: ppMoneySchema.optional(),
  fee_amount: ppMoneySchema.optional(),
  transaction_status: z.string().optional(),
  custom_field: z.string().optional(),
  invoice_id: z.string().optional(),
});

const searchResponseSchema = z.object({
  transaction_details: z.array(z.object({ transaction_info: transactionInfoSchema.optional() })).optional(),
  page: z.number().optional(),
  total_pages: z.number().optional(),
  total_items: z.number().optional(),
});

export function parseSearchResponse(raw: unknown) {
  return parseResponse(searchResponseSchema, raw ?? {}, "transaction search");
}

const TXN_STATUS: Record<string, string> = { S: "COMPLETED", P: "PENDING", V: "REVERSED", D: "DENIED" };

/** Transaction Search dates look like 2014-07-11T04:03:52+0000 (no colon in the offset). */
export function parseReportingDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/** PayPal API date-time with seconds precision, e.g. 2026-10-02T12:00:00Z. */
export function toPayPalDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function mapTransaction(info: z.infer<typeof transactionInfoSchema>): TransactionRecord {
  const code = info.transaction_status ?? "";
  return {
    id: info.transaction_id,
    amount: info.transaction_amount ? fromPayPalMoney(info.transaction_amount) : NO_AMOUNT,
    status: TXN_STATUS[code] ?? (code || "UNKNOWN"),
    ...(info.custom_field ? { customId: info.custom_field } : {}),
    time: parseReportingDate(info.transaction_initiation_date ?? info.transaction_updated_date) ?? "",
    ...(info.invoice_id ? { invoiceId: info.invoice_id } : {}),
    ...(info.transaction_event_code ? { eventCode: info.transaction_event_code } : {}),
    ...(code ? { statusCode: code } : {}),
    ...(info.fee_amount ? { fee: fromPayPalMoney(info.fee_amount) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export const WEBHOOK_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

export function lowerCaseHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

export const verifyResponseSchema = z.object({ verification_status: z.string() });

// ---------------------------------------------------------------------------------------------
// Payouts v1 (money here is { currency, value }, not currency_code)
// ---------------------------------------------------------------------------------------------

const payoutMoneySchema = z.object({ currency: z.string(), value: z.string() });
const payoutSenderHeaderSchema = z.object({ sender_batch_id: z.string().optional() }).loose();

const payoutItemSchema = z
  .object({
    payout_item_id: z.string(),
    payout_batch_id: z.string(),
    transaction_id: z.string().optional(),
    transaction_status: z.string().optional(),
    payout_item_fee: payoutMoneySchema.optional(),
    time_processed: z.string().optional(),
    errors: z.object({ name: z.string(), message: z.string().optional() }).loose().optional(),
    payout_item: z
      .object({
        receiver: z.string(),
        amount: payoutMoneySchema,
        recipient_type: z.string().optional(),
        sender_item_id: z.string().optional(),
        note: z.string().optional(),
      })
      .loose(),
  })
  .loose();

const payoutHeaderSchema = z
  .object({
    payout_batch_id: z.string(),
    batch_status: z.string(),
    time_created: z.string().optional(),
    time_completed: z.string().optional(),
    sender_batch_header: payoutSenderHeaderSchema.optional(),
    amount: payoutMoneySchema.optional(),
    fees: payoutMoneySchema.optional(),
  })
  .loose();

const payoutBatchSchema = z.object({ batch_header: payoutHeaderSchema, items: z.array(payoutItemSchema).optional() }).loose();

export function mapPayoutItem(raw: unknown): PayoutItem {
  const r = parseResponse(payoutItemSchema, raw, "payout item");
  const it = r.payout_item;
  return {
    itemId: r.payout_item_id,
    batchId: r.payout_batch_id,
    status: r.transaction_status ?? "PENDING",
    receiver: it.receiver,
    amount: { currency: it.amount.currency, value: it.amount.value },
    ...(it.recipient_type ? { recipientType: it.recipient_type } : {}),
    ...(it.sender_item_id ? { senderItemId: it.sender_item_id } : {}),
    ...(it.note ? { note: it.note } : {}),
    ...(r.transaction_id ? { transactionId: r.transaction_id } : {}),
    ...(r.payout_item_fee ? { fee: { currency: r.payout_item_fee.currency, value: r.payout_item_fee.value } } : {}),
    ...(r.time_processed ? { processedAt: r.time_processed } : {}),
    ...(r.errors ? { error: { name: r.errors.name, ...(r.errors.message ? { message: r.errors.message } : {}) } } : {}),
  };
}

/** Create response (batch header only) and batch details (header plus items). */
export function mapPayoutBatch(raw: unknown): PayoutBatch {
  const r = parseResponse(payoutBatchSchema, raw, "payout batch");
  const h = r.batch_header;
  return {
    batchId: h.payout_batch_id,
    status: h.batch_status,
    ...(h.sender_batch_header?.sender_batch_id ? { senderBatchId: h.sender_batch_header.sender_batch_id } : {}),
    ...(h.time_created ? { createdAt: h.time_created } : {}),
    ...(h.time_completed ? { completedAt: h.time_completed } : {}),
    ...(h.amount ? { amount: { currency: h.amount.currency, value: h.amount.value } } : {}),
    ...(h.fees ? { fees: { currency: h.fees.currency, value: h.fees.value } } : {}),
    items: (r.items ?? []).map((it) => mapPayoutItem(it)),
    raw,
  };
}

/**
 * The original batch id when PayPal rejected a payout because its sender_batch_id was already used (it
 * links the original payout in the error), else undefined.
 */
export function duplicatePayoutBatchId(e: PayPalError): string | undefined {
  if (e.status < 400 || e.status >= 500) return undefined;
  const href = e.links.find((l) => /\/v1\/payments\/payouts\/[^/?#]+/.test(l.href))?.href;
  if (!href) return undefined;
  const mentionsDuplicate = /duplicate|already|sender_batch_id/i.test(`${e.name} ${e.paypalMessage} ${e.details.map((d) => `${d.issue} ${d.description ?? ""}`).join(" ")}`);
  return mentionsDuplicate ? idFromHref(href) : undefined;
}
