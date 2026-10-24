/**
 * In-memory PayPal simulator implementing the same PayPalClient interface as the real client.
 *
 * It validates input with the same builders, stores the exact request bodies the real client would
 * send, renders PayPal-shaped JSON (orders, captures, disputes, transaction search rows, webhook
 * events), and runs it through the same mappers. State machines follow PayPal's documented flows:
 *
 *   setup token   PAYER_ACTION_REQUIRED -> APPROVED (simulateBuyerApproval) -> VAULTED (createPaymentToken)
 *   order         PAYER_ACTION_REQUIRED|CREATED -> APPROVED -> COMPLETED; vault_id orders complete at once
 *   authorization CREATED -> CAPTURED | PARTIALLY_CAPTURED | VOIDED
 *   capture       COMPLETED -> PARTIALLY_REFUNDED -> REFUNDED
 *   dispute       WAITING_FOR_SELLER_RESPONSE -> UNDER_REVIEW (evidence) -> RESOLVED (simulateDisputeDecision)
 *
 * Errors use PayPal's documented names and issue codes (ORDER_NOT_APPROVED, PAYMENT_DENIED, ...).
 * With a seed, ids are deterministic; pass `now` too for fully reproducible snapshots.
 */
import { LOCAL_ERROR, PayPalError, type PayPalErrorDetail } from "./errors.js";
import { PAYPAL_API_BASE, PAYPAL_WEB_BASE } from "./http.js";
import {
  type Rng,
  accountId,
  base64Bytes,
  createRng,
  customerId as newCustomerId,
  debugId as newDebugId,
  disputeId as newDisputeId,
  paymentTokenId,
  transactionId,
  uuid,
  webhookEventId,
} from "./ids.js";
import {
  lowerCaseHeaders,
  mapDisputeDetails,
  mapDisputeSummary,
  mapPaymentToken,
  mapPayoutBatch,
  mapPayoutItem,
  mapSetupToken,
  mapTransaction,
  orderResult,
  summarizeOrder,
  toPayPalDate,
  WEBHOOK_HEADERS,
} from "./mappers.js";
import { decimalsFor, fromMinor, toMinor, toPayPalMoney } from "./money.js";
import {
  type OrderMode,
  type OrderRequestBody,
  type SetupTokenRequestBody,
  assertRequestId,
  assertResourceId,
  buildCaptureAuthorizationRequest,
  buildEvidence,
  buildOrderRequest,
  buildPaymentTokenRequest,
  buildPayoutRequest,
  buildRefundRequest,
  buildSetupTokenRequest,
  parseSandboxDisputeInput,
} from "./requests.js";
import type {
  CreatePayoutInput,
  CreateSandboxDisputeInput,
  DisputeSummary,
  PayPalClient,
  PayPalWebhookEvent,
  PayoutBatch,
  PayoutItem,
  TransactionRecord,
  WebhookDelivery,
} from "./types.js";

export type MockPayPalOptions = {
  seed?: string;
  /** Make every vault_id (merchant-initiated) charge fail with 422 PAYMENT_DENIED. */
  failVaultCharges?: boolean;
  // Extensions:
  /** Clock for all timestamps (default: real time). */
  now?: () => Date;
  /** Artificial latency per API call, in ms (default 0). */
  latencyMs?: number;
  /**
   * Base URL for approval links (default https://www.sandbox.paypal.com). Point it at the app, e.g.
   * "https://app.example/mock-paypal", to serve a fake approval sheet at /checkoutnow and /agreements/approve.
   */
  webBaseUrl?: string;
  /** Base URL used in HATEOAS links (default https://api-m.sandbox.paypal.com). */
  apiBaseUrl?: string;
  /** Webhook id that verifyWebhookSignature accepts (default: generated). */
  webhookId?: string;
  merchant?: { merchantId?: string; email?: string; name?: string };
  buyer?: { email?: string; givenName?: string; surname?: string };
  /** Receives every webhook the mock emits, asynchronously after the API call that caused it. */
  emitWebhook?: (delivery: WebhookDelivery) => void | Promise<void>;
  /** Receives every event-log entry as it is recorded. */
  onEvent?: (event: MockEvent) => void;
};

export type MockEvent = {
  seq: number;
  at: string;
  kind: "api" | "buyer" | "webhook" | "simulation";
  action: string;
  id?: string;
  status?: string;
  detail?: Record<string, unknown>;
  error?: { status: number; name: string; issue?: string };
};

export type BuyerApprovalResult = {
  kind: "setup_token" | "order";
  id: string;
  status: string;
  /** Where PayPal would send the buyer next (return or cancel URL with PayPal's query parameters). */
  redirectUrl: string;
};

export type MockSnapshot = {
  merchant: { merchantId: string; email: string; name: string };
  setupTokens: unknown[];
  paymentTokens: unknown[];
  orders: unknown[];
  authorizations: unknown[];
  captures: unknown[];
  refunds: unknown[];
  disputes: unknown[];
  transactions: unknown[];
  eventCount: number;
  webhookCount: number;
};

export interface MockPayPal extends PayPalClient {
  readonly mode: "mock";
  /** The webhook id this mock signs for; use it as `webhookId` when verifying in mock mode. */
  readonly webhookId: string;
  createSandboxDispute(i: CreateSandboxDisputeInput): Promise<{ id: string }>;
  /** Batches start PENDING and are processed on first read: items SUCCESS, or UNCLAIMED for "unregistered" emails. */
  createPayout(i: CreatePayoutInput): Promise<PayoutBatch>;
  getPayoutBatch(batchId: string, opts?: { page?: number; pageSize?: number }): Promise<PayoutBatch>;
  getPayoutItem(itemId: string): Promise<PayoutItem>;
  _state(): MockSnapshot;
  /** The buyer approves a setup token (saves PayPal) or an order (pays) on the PayPal sheet. */
  simulateBuyerApproval(orderOrSetupTokenId: string, buyer?: { email?: string; givenName?: string; surname?: string }): BuyerApprovalResult;
  /** The buyer closes the PayPal sheet; nothing changes on PayPal's side. */
  simulateBuyerCancel(orderOrSetupTokenId: string): BuyerApprovalResult;
  /** Sandbox "Settle dispute" (/adjudicate): needs status UNDER_REVIEW. */
  simulateDisputeDecision(disputeId: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): { status: string; outcome: string };
  /** Sandbox "Update dispute status" (/require-evidence): UNDER_REVIEW -> WAITING_FOR_SELLER_RESPONSE. */
  simulateDisputeRequireEvidence(disputeId: string): { status: string };
  events(): MockEvent[];
  webhooks(): WebhookDelivery[];
  onEvent(listener: (e: MockEvent) => void): () => void;
  onWebhook(listener: (w: WebhookDelivery) => void | Promise<void>): () => void;
  /** Resolves once every emitted webhook has been delivered to listeners. */
  flushWebhooks(): Promise<void>;
}

export function isMockPayPal(client: PayPalClient): client is MockPayPal {
  return (client as Partial<MockPayPal>).mode === "mock";
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

type Party = { payerId: string; email: string; givenName: string; surname: string };

type SetupTokenRec = {
  id: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "VAULTED";
  customerId: string;
  request: SetupTokenRequestBody;
  returnUrl: string;
  cancelUrl: string;
  payer?: Party;
  paymentTokenId?: string;
  createTime: string;
  updateTime: string;
  expiresAt: number;
};

type PaymentTokenRec = { id: string; customerId: string; setupTokenId: string; payer: Party; request: SetupTokenRequestBody; createTime: string };

type OrderRec = {
  id: string;
  intent: "CAPTURE" | "AUTHORIZE";
  status: "CREATED" | "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  mode: OrderMode;
  request: OrderRequestBody;
  vaultId?: string;
  payer?: Party;
  currency: string;
  amountMinor: number;
  customId?: string;
  invoiceId?: string;
  returnUrl?: string;
  cancelUrl?: string;
  captureIds: string[];
  authorizationIds: string[];
  createTime: string;
  updateTime: string;
};

type AuthorizationRec = {
  id: string;
  orderId: string;
  status: "CREATED" | "CAPTURED" | "PARTIALLY_CAPTURED" | "VOIDED";
  currency: string;
  amountMinor: number;
  capturedMinor: number;
  customId?: string;
  invoiceId?: string;
  captureIds: string[];
  createTime: string;
  updateTime: string;
  expiresAt: number;
};

type CaptureRec = {
  id: string;
  orderId: string;
  authorizationId?: string;
  status: "COMPLETED" | "PARTIALLY_REFUNDED" | "REFUNDED";
  currency: string;
  amountMinor: number;
  feeMinor: number;
  refundedMinor: number;
  finalCapture: boolean;
  customId?: string;
  invoiceId?: string;
  refundIds: string[];
  disputeId?: string;
  vault: boolean;
  createTime: string;
  updateTime: string;
};

type RefundRec = {
  id: string;
  captureId: string;
  currency: string;
  amountMinor: number;
  note?: string;
  customId?: string;
  invoiceId?: string;
  createTime: string;
};

type PayoutItemRec = {
  id: string;
  batchId: string;
  receiver: string;
  recipientType: string;
  currency: string;
  amountMinor: number;
  feeMinor: number;
  note?: string;
  senderItemId?: string;
  status: "PENDING" | "SUCCESS" | "UNCLAIMED";
  transactionId?: string;
  timeProcessed?: string;
};

type PayoutBatchRec = {
  id: string;
  senderBatchId: string;
  status: "PENDING" | "SUCCESS";
  /** The first item's currency; amount and fees total the items in it. */
  currency: string;
  amountMinor: number;
  feeMinor: number;
  itemIds: string[];
  createTime: string;
  completedTime?: string;
};

type EvidenceJson = {
  evidence_type: string;
  source: string;
  date: string;
  dispute_life_cycle_stage: string;
  notes?: string;
  documents?: { name: string }[];
  evidence_info?: { refund_ids: string[] };
};

type DisputeRec = {
  id: string;
  captureId: string;
  buyerTransactionId: string;
  reason: string;
  status: "WAITING_FOR_SELLER_RESPONSE" | "UNDER_REVIEW" | "RESOLVED";
  stage: "INQUIRY" | "CHARGEBACK";
  channel: "INTERNAL" | "EXTERNAL";
  currency: string;
  amountMinor: number;
  evidences: EvidenceJson[];
  outcome?: string;
  createTime: string;
  updateTime: string;
  sellerResponseDueDate?: string;
};

type TxnRec = {
  id: string;
  eventCode: string;
  currency: string;
  amountMinor: number;
  feeMinor: number;
  status: "S" | "P" | "V" | "D";
  customField?: string;
  invoiceId?: string;
  referenceId?: string;
  referenceType?: "ODR" | "TXN";
  time: number;
};

/** A fresh object per render, so callers mutating `raw` cannot corrupt later responses. */
const sellerProtection = () => ({ status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] });
const DAY_MS = 24 * 3600 * 1000;

function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export function createMockPayPal(opts: MockPayPalOptions = {}): MockPayPal {
  const rng: Rng = createRng(opts.seed);
  const clock = opts.now ?? (() => new Date());
  const apiBase = (opts.apiBaseUrl ?? PAYPAL_API_BASE.sandbox).replace(/\/+$/, "");
  const webBase = (opts.webBaseUrl ?? PAYPAL_WEB_BASE.sandbox).replace(/\/+$/, "");
  const webhookIdValue = opts.webhookId ?? transactionId(rng);
  const merchant = {
    merchantId: opts.merchant?.merchantId ?? accountId(rng),
    email: opts.merchant?.email ?? `sb-${transactionId(rng).toLowerCase().slice(0, 12)}@business.example.com`,
    name: opts.merchant?.name ?? "Good Faith Demo",
  };
  const defaultBuyer: Party = {
    payerId: accountId(rng),
    email: opts.buyer?.email ?? `sb-${transactionId(rng).toLowerCase().slice(0, 12)}@personal.example.com`,
    givenName: opts.buyer?.givenName ?? "Maya",
    surname: opts.buyer?.surname ?? "Buyer",
  };
  const buyerIds = new Map<string, string>([[defaultBuyer.email, defaultBuyer.payerId]]);
  const certUrl = `${apiBase.replace("api-m.", "api.")}/v1/notifications/certs/CERT-360caa42-fca2a594-${uuid(rng).slice(0, 8)}`;

  const setupTokens = new Map<string, SetupTokenRec>();
  const paymentTokens = new Map<string, PaymentTokenRec>();
  const orders = new Map<string, OrderRec>();
  const authorizations = new Map<string, AuthorizationRec>();
  const captures = new Map<string, CaptureRec>();
  const refunds = new Map<string, RefundRec>();
  const disputes = new Map<string, DisputeRec>();
  const payoutBatches = new Map<string, PayoutBatchRec>();
  const payoutItems = new Map<string, PayoutItemRec>();
  /** sender_batch_id -> batch id: PayPal pays a sender_batch_id at most once. */
  const payoutsBySender = new Map<string, string>();
  const transactions: TxnRec[] = [];
  /** PayPal-Request-Id replay: `${operation}:${requestId}` -> resource id. */
  const idempotency = new Map<string, string>();
  const eventLog: MockEvent[] = [];
  const delivered: WebhookDelivery[] = [];
  const eventListeners = new Set<(e: MockEvent) => void>();
  const webhookListeners = new Set<(w: WebhookDelivery) => void | Promise<void>>();
  const pending = new Set<Promise<void>>();
  if (opts.onEvent) eventListeners.add(opts.onEvent);
  if (opts.emitWebhook) webhookListeners.add(opts.emitWebhook);
  let seq = 0;

  const nowMs = () => clock().getTime();
  const ts = () => toPayPalDate(clock());
  const money = (minor: number, currency: string) => toPayPalMoney(fromMinor(minor, currency));
  const link = (path: string, rel: string, method = "GET") => ({ href: `${apiBase}${path}`, rel, method });

  // ------------------------------------------------------------------ event log + webhooks

  function record(e: Omit<MockEvent, "seq" | "at">): void {
    const entry: MockEvent = { seq: ++seq, at: clock().toISOString(), ...e };
    eventLog.push(entry);
    for (const l of eventListeners) {
      try {
        l(entry);
      } catch {
        // listeners must not break the simulation
      }
    }
  }

  function emit(eventType: string, resourceType: string, resourceVersion: string, summary: string, resource: Record<string, unknown>): void {
    const id = webhookEventId(rng);
    const event: PayPalWebhookEvent = {
      id,
      event_version: "1.0",
      create_time: clock().toISOString(),
      resource_type: resourceType,
      resource_version: resourceVersion,
      event_type: eventType,
      summary,
      resource: deepClone(resource),
      links: [
        link(`/v1/notifications/webhooks-events/${id}`, "self"),
        link(`/v1/notifications/webhooks-events/${id}/resend`, "resend", "POST"),
      ],
    };
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [WEBHOOK_HEADERS.authAlgo]: "SHA256withRSA",
      [WEBHOOK_HEADERS.certUrl]: certUrl,
      [WEBHOOK_HEADERS.transmissionId]: uuid(rng),
      [WEBHOOK_HEADERS.transmissionSig]: base64Bytes(rng, 256),
      [WEBHOOK_HEADERS.transmissionTime]: toPayPalDate(clock()),
    };
    const delivery: WebhookDelivery = { event, headers, body, webhookId: webhookIdValue };
    delivered.push(delivery);
    record({ kind: "webhook", action: eventType, id, detail: { resourceId: resource.id ?? resource.dispute_id } });
    // Real webhooks arrive after the API response, so deliver on a later macrotask.
    const p = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      for (const l of [...webhookListeners]) {
        try {
          // Each listener gets its own copy so it cannot alter what verifyWebhookSignature checks against.
          await l(deepClone(delivery));
        } catch (err) {
          record({ kind: "webhook", action: "listener_error", id, detail: { message: err instanceof Error ? err.message : String(err) } });
        }
      }
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  // ------------------------------------------------------------------ errors

  function fail(status: number, name: string, message: string, method: string, path: string, details: PayPalErrorDetail[] = []): never {
    throw new PayPalError({ status, name, message, debugId: newDebugId(rng), details, method, path });
  }
  const notFound = (method: string, path: string): never =>
    fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", method, path, [
      { issue: "INVALID_RESOURCE_ID", description: "Specified resource ID does not exist. Please check the resource ID and try again." },
    ]);
  const unprocessable = (method: string, path: string, issue: string, description: string): never =>
    fail(422, "UNPROCESSABLE_ENTITY", "The requested action could not be performed, semantically incorrect, or failed business validation.", method, path, [
      { issue, description },
    ]);

  async function api<T>(action: string, run: () => T): Promise<T> {
    if (opts.latencyMs && opts.latencyMs > 0) await new Promise((r) => setTimeout(r, opts.latencyMs));
    try {
      const result = run();
      const r = result as
        | { id?: unknown; status?: unknown; captureId?: unknown; refundId?: unknown; vaultId?: unknown; batchId?: unknown; itemId?: unknown }
        | undefined;
      const id = [r?.id, r?.captureId, r?.refundId, r?.vaultId, r?.itemId, r?.batchId].find((v) => typeof v === "string") as string | undefined;
      record({
        kind: "api",
        action,
        ...(id ? { id } : {}),
        ...(typeof r?.status === "string" ? { status: r.status } : {}),
      });
      return result;
    } catch (e) {
      if (e instanceof PayPalError) {
        record({ kind: "api", action, error: { status: e.status, name: e.name, ...(e.issue ? { issue: e.issue } : {}) } });
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ JSON renderers

  function payerJson(p: Party) {
    return { name: { given_name: p.givenName, surname: p.surname }, email_address: p.email, payer_id: p.payerId, address: { country_code: "US" } };
  }

  function captureJson(c: CaptureRec) {
    return {
      id: c.id,
      status: c.status,
      amount: money(c.amountMinor, c.currency),
      final_capture: c.finalCapture,
      seller_protection: sellerProtection(),
      seller_receivable_breakdown: {
        gross_amount: money(c.amountMinor, c.currency),
        paypal_fee: money(c.feeMinor, c.currency),
        net_amount: money(c.amountMinor - c.feeMinor, c.currency),
      },
      ...(c.invoiceId ? { invoice_id: c.invoiceId } : {}),
      ...(c.customId ? { custom_id: c.customId } : {}),
      supplementary_data: { related_ids: { order_id: c.orderId, ...(c.authorizationId ? { authorization_id: c.authorizationId } : {}) } },
      payee: { email_address: merchant.email, merchant_id: merchant.merchantId },
      create_time: c.createTime,
      update_time: c.updateTime,
      links: [
        link(`/v2/payments/captures/${c.id}`, "self"),
        link(`/v2/payments/captures/${c.id}/refund`, "refund", "POST"),
        c.authorizationId ? link(`/v2/payments/authorizations/${c.authorizationId}`, "up") : link(`/v2/checkout/orders/${c.orderId}`, "up"),
      ],
    };
  }

  function authorizationJson(a: AuthorizationRec) {
    const open = a.status === "CREATED" || a.status === "PARTIALLY_CAPTURED";
    return {
      id: a.id,
      status: a.status,
      amount: money(a.amountMinor, a.currency),
      ...(a.invoiceId ? { invoice_id: a.invoiceId } : {}),
      ...(a.customId ? { custom_id: a.customId } : {}),
      seller_protection: sellerProtection(),
      expiration_time: toPayPalDate(new Date(a.expiresAt)),
      create_time: a.createTime,
      update_time: a.updateTime,
      links: [
        link(`/v2/payments/authorizations/${a.id}`, "self"),
        ...(open
          ? [
              link(`/v2/payments/authorizations/${a.id}/capture`, "capture", "POST"),
              link(`/v2/payments/authorizations/${a.id}/void`, "void", "POST"),
              link(`/v2/payments/authorizations/${a.id}/reauthorize`, "reauthorize", "POST"),
            ]
          : []),
        link(`/v2/checkout/orders/${a.orderId}`, "up"),
      ],
    };
  }

  function refundJson(r: RefundRec) {
    const capture = captures.get(r.captureId);
    return {
      id: r.id,
      amount: money(r.amountMinor, r.currency),
      seller_payable_breakdown: {
        gross_amount: money(r.amountMinor, r.currency),
        paypal_fee: money(0, r.currency),
        net_amount: money(r.amountMinor, r.currency),
        total_refunded_amount: money(capture?.refundedMinor ?? r.amountMinor, r.currency),
      },
      ...(r.invoiceId ? { invoice_id: r.invoiceId } : {}),
      ...(r.customId ? { custom_id: r.customId } : {}),
      ...(r.note ? { note_to_payer: r.note } : {}),
      status: "COMPLETED",
      create_time: r.createTime,
      update_time: r.createTime,
      links: [link(`/v2/payments/refunds/${r.id}`, "self"), link(`/v2/payments/captures/${r.captureId}`, "up")],
    };
  }

  function orderJson(o: OrderRec) {
    const unit = o.request.purchase_units[0];
    const captureList = o.captureIds.flatMap((id) => {
      const c = captures.get(id);
      return c ? [captureJson(c)] : [];
    });
    const authList = o.authorizationIds.flatMap((id) => {
      const a = authorizations.get(id);
      return a ? [authorizationJson(a)] : [];
    });
    const refundList = o.captureIds.flatMap((id) => (captures.get(id)?.refundIds ?? []).flatMap((rid) => {
      const r = refunds.get(rid);
      return r ? [refundJson(r)] : [];
    }));
    const paypalSource = o.payer
      ? {
          email_address: o.payer.email,
          account_id: o.payer.payerId,
          account_status: "VERIFIED",
          name: { given_name: o.payer.givenName, surname: o.payer.surname },
          address: { country_code: "US" },
          ...(o.vaultId ? { attributes: { vault: { id: o.vaultId, status: "VAULTED" } } } : {}),
        }
      : {};
    const links = [link(`/v2/checkout/orders/${o.id}`, "self")];
    if (o.status === "PAYER_ACTION_REQUIRED") links.push({ href: `${webBase}/checkoutnow?token=${o.id}`, rel: "payer-action", method: "GET" });
    if (o.status === "CREATED") {
      links.push({ href: `${webBase}/checkoutnow?token=${o.id}`, rel: "approve", method: "GET" });
      links.push(link(`/v2/checkout/orders/${o.id}`, "edit", "PATCH"));
    }
    if (o.status === "CREATED" || o.status === "APPROVED") {
      links.push(o.intent === "CAPTURE" ? link(`/v2/checkout/orders/${o.id}/capture`, "capture", "POST") : link(`/v2/checkout/orders/${o.id}/authorize`, "authorize", "POST"));
    }
    return {
      id: o.id,
      intent: o.intent,
      status: o.status,
      ...(o.mode !== "plain" || o.payer ? { payment_source: { paypal: paypalSource } } : {}),
      purchase_units: [
        {
          reference_id: "default",
          ...deepClone(unit),
          payee: { email_address: merchant.email, merchant_id: merchant.merchantId },
          ...(captureList.length || authList.length || refundList.length
            ? {
                payments: {
                  ...(authList.length ? { authorizations: authList } : {}),
                  ...(captureList.length ? { captures: captureList } : {}),
                  ...(refundList.length ? { refunds: refundList } : {}),
                },
              }
            : {}),
        },
      ],
      ...(o.payer ? { payer: payerJson(o.payer) } : {}),
      create_time: o.createTime,
      update_time: o.updateTime,
      links,
    };
  }

  function setupTokenJson(t: SetupTokenRec) {
    const paypal = { ...deepClone(t.request.payment_source.paypal) } as Record<string, unknown>;
    delete paypal.experience_context;
    if (t.payer) Object.assign(paypal, { email_address: t.payer.email, payer_id: t.payer.payerId });
    return {
      id: t.id,
      customer: { id: t.customerId },
      status: t.status,
      payment_source: { paypal },
      links: [
        link(`/v3/vault/setup-tokens/${t.id}`, "self"),
        ...(t.status === "PAYER_ACTION_REQUIRED" ? [{ href: `${webBase}/agreements/approve?approval_session_id=${t.id}`, rel: "approve", method: "GET" }] : []),
        ...(t.status === "APPROVED" ? [link("/v3/vault/payment-tokens", "confirm", "POST")] : []),
      ],
    };
  }

  function paymentTokenJson(p: PaymentTokenRec) {
    const paypal = { ...deepClone(p.request.payment_source.paypal) } as Record<string, unknown>;
    delete paypal.experience_context;
    return {
      id: p.id,
      customer: { id: p.customerId },
      payment_source: {
        paypal: {
          ...paypal,
          name: { given_name: p.payer.givenName, surname: p.payer.surname, full_name: `${p.payer.givenName} ${p.payer.surname}` },
          email_address: p.payer.email,
          payer_id: p.payer.payerId,
        },
      },
      links: [link(`/v3/vault/payment-tokens/${p.id}`, "self"), link(`/v3/vault/payment-tokens/${p.id}`, "delete", "DELETE")],
    };
  }

  function disputeLinks(d: DisputeRec) {
    const base = `/v1/customer/disputes/${d.id}`;
    const links = [link(base, "self")];
    if (d.status === "WAITING_FOR_SELLER_RESPONSE") {
      if (d.stage === "INQUIRY") links.push(link(`${base}/send-message`, "send_message", "POST"), link(`${base}/escalate`, "escalate", "POST"));
      links.push(
        link(`${base}/accept-claim`, "accept_claim", "POST"),
        link(`${base}/make-offer`, "make_offer", "POST"),
        link(`${base}/provide-evidence`, "provide_evidence", "POST"),
      );
    }
    if (d.status === "UNDER_REVIEW") {
      links.push(link(`${base}/adjudicate`, "adjudicate", "POST"), link(`${base}/require-evidence`, "require_evidence", "POST"));
    }
    return links;
  }

  function disputeState(d: DisputeRec): string {
    return d.status === "WAITING_FOR_SELLER_RESPONSE" ? "REQUIRED_ACTION" : d.status === "UNDER_REVIEW" ? "UNDER_PAYPAL_REVIEW" : "RESOLVED";
  }

  function disputeJson(d: DisputeRec) {
    const capture = captures.get(d.captureId);
    const order = capture ? orders.get(capture.orderId) : undefined;
    const buyer = order?.payer ?? defaultBuyer;
    const items = order?.request.purchase_units[0]?.items;
    return {
      dispute_id: d.id,
      create_time: d.createTime,
      update_time: d.updateTime,
      disputed_transactions: [
        {
          buyer_transaction_id: d.buyerTransactionId,
          seller_transaction_id: d.captureId,
          create_time: capture?.createTime,
          transaction_status: d.status === "RESOLVED" ? "COMPLETED" : "HELD",
          gross_amount: capture ? money(capture.amountMinor, capture.currency) : money(d.amountMinor, d.currency),
          ...(capture?.invoiceId ? { invoice_number: capture.invoiceId } : {}),
          ...(capture?.customId ? { custom: capture.customId } : {}),
          buyer: { name: `${buyer.givenName} ${buyer.surname}` },
          seller: { email: merchant.email, merchant_id: merchant.merchantId, name: merchant.name },
          ...(items
            ? { items: items.map((it) => ({ item_name: it.name, item_quantity: it.quantity, reason: d.reason, item_type: "PRODUCT" })) }
            : {}),
          seller_protection_eligible: true,
        },
      ],
      reason: d.reason,
      status: d.status,
      dispute_amount: money(d.amountMinor, d.currency),
      dispute_state: disputeState(d),
      dispute_life_cycle_stage: d.stage,
      dispute_channel: d.channel,
      messages: [],
      evidences: deepClone(d.evidences),
      ...(d.sellerResponseDueDate && d.status === "WAITING_FOR_SELLER_RESPONSE" ? { seller_response_due_date: d.sellerResponseDueDate } : {}),
      offer: { buyer_requested_amount: money(d.amountMinor, d.currency) },
      refund_details: { allowed_refund_amount: money(d.amountMinor, d.currency) },
      ...(d.status === "WAITING_FOR_SELLER_RESPONSE"
        ? { allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] }, make_offer: { offer_types: ["REFUND"] } } }
        : {}),
      ...(d.outcome ? { dispute_outcome: { outcome_code: d.outcome, amount_refunded: money(d.outcome === "RESOLVED_BUYER_FAVOUR" ? d.amountMinor : 0, d.currency) } } : {}),
      links: disputeLinks(d),
    };
  }

  /** List items carry a summary only, like PayPal's (buyer-side transaction id, no seller id). */
  function disputeListItem(d: DisputeRec) {
    return {
      dispute_id: d.id,
      create_time: d.createTime,
      update_time: d.updateTime,
      disputed_transactions: [{ buyer_transaction_id: d.buyerTransactionId, seller: { merchant_id: merchant.merchantId } }],
      reason: d.reason,
      status: d.status,
      dispute_state: disputeState(d),
      dispute_amount: money(d.amountMinor, d.currency),
      dispute_life_cycle_stage: d.stage,
      dispute_channel: d.channel,
      ...(d.sellerResponseDueDate && d.status === "WAITING_FOR_SELLER_RESPONSE" ? { seller_response_due_date: d.sellerResponseDueDate } : {}),
      links: [link(`/v1/customer/disputes/${d.id}`, "self")],
    };
  }

  /** Transaction Search row; dates in PayPal's reporting format (+0000 offset). */
  function txnJson(t: TxnRec) {
    const date = toPayPalDate(new Date(t.time)).replace("Z", "+0000");
    return {
      paypal_account_id: defaultBuyer.payerId,
      transaction_id: t.id,
      ...(t.referenceId ? { paypal_reference_id: t.referenceId, paypal_reference_id_type: t.referenceType } : {}),
      transaction_event_code: t.eventCode,
      transaction_initiation_date: date,
      transaction_updated_date: date,
      transaction_amount: money(t.amountMinor, t.currency),
      fee_amount: money(-t.feeMinor, t.currency),
      transaction_status: t.status,
      ...(t.invoiceId ? { invoice_id: t.invoiceId } : {}),
      ...(t.customField ? { custom_field: t.customField } : {}),
      protection_eligibility: "01",
    };
  }

  // ------------------------------------------------------------------ helpers

  const feeFor = (minor: number, currency: string) => Math.round(minor * 0.0349) + (decimalsFor(currency) === 2 ? 49 : 0);
  const summaryAmount = (minor: number, currency: string) => `${currency === "USD" ? "$ " : ""}${Number(fromMinor(minor, currency).value)} ${currency}`;

  function replay(key: string): string | undefined {
    return idempotency.get(key);
  }

  // Payouts: the sandbox charged a flat 0.25 per item on 2026-10-24 (live pricing differs).
  const payoutFeeFor = (_minor: number, currency: string) => (decimalsFor(currency) === 2 ? 25 : 0);
  const UNREGISTERED_RECEIVER = /unregistered|unclaimed/i;

  function payoutItemJson(item: PayoutItemRec): Record<string, unknown> {
    return {
      payout_item_id: item.id,
      ...(item.transactionId ? { transaction_id: item.transactionId } : {}),
      transaction_status: item.status,
      payout_item_fee: { currency: item.currency, value: fromMinor(item.feeMinor, item.currency).value },
      payout_batch_id: item.batchId,
      payout_item: {
        recipient_type: item.recipientType,
        amount: { currency: item.currency, value: fromMinor(item.amountMinor, item.currency).value },
        ...(item.note ? { note: item.note } : {}),
        receiver: item.receiver,
        ...(item.senderItemId ? { sender_item_id: item.senderItemId } : {}),
      },
      ...(item.timeProcessed ? { time_processed: item.timeProcessed } : {}),
      ...(item.status === "UNCLAIMED" ? { errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" } } : {}),
      links: [link(`/v1/payments/payouts-item/${item.id}`, "item")],
    };
  }

  /** The create response carries the header only; batch details add totals and items. */
  function payoutBatchJson(batch: PayoutBatchRec, details: boolean): Record<string, unknown> {
    return {
      batch_header: {
        payout_batch_id: batch.id,
        batch_status: batch.status,
        time_created: batch.createTime,
        ...(batch.completedTime ? { time_completed: batch.completedTime } : {}),
        sender_batch_header: { sender_batch_id: batch.senderBatchId },
        ...(details
          ? {
              amount: { currency: batch.currency, value: fromMinor(batch.amountMinor, batch.currency).value },
              fees: { currency: batch.currency, value: fromMinor(batch.feeMinor, batch.currency).value },
            }
          : {}),
      },
      ...(details ? { items: batch.itemIds.map((id) => payoutItemJson(payoutItems.get(id) as PayoutItemRec)) } : {}),
      links: [link(`/v1/payments/payouts/${batch.id}`, "self")],
    };
  }

  /** PayPal processes a batch asynchronously; the mock does it on the first read after creation. */
  function processPayoutBatch(batch: PayoutBatchRec): void {
    if (batch.status !== "PENDING") return;
    const now = ts();
    for (const id of batch.itemIds) {
      const item = payoutItems.get(id);
      if (item?.status !== "PENDING") continue;
      item.status = item.recipientType === "EMAIL" && UNREGISTERED_RECEIVER.test(item.receiver) ? "UNCLAIMED" : "SUCCESS";
      item.transactionId = transactionId(rng);
      item.timeProcessed = now;
      if (item.status === "SUCCESS") {
        emit("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "payouts_item", "1.0", "A payout item has succeeded", payoutItemJson(item));
      } else {
        emit("PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "payouts_item", "1.0", "A payout item is unclaimed", payoutItemJson(item));
      }
    }
    batch.status = "SUCCESS";
    batch.completedTime = now;
    emit("PAYMENT.PAYOUTSBATCH.SUCCESS", "payouts", "1.0", "Payouts batch completed successfully.", payoutBatchJson(batch, false));
  }

  function addCapture(order: OrderRec, amountMinor: number, extra: { authorizationId?: string; finalCapture?: boolean; invoiceId?: string }): CaptureRec {
    const now = ts();
    const capture: CaptureRec = {
      id: transactionId(rng),
      orderId: order.id,
      ...(extra.authorizationId ? { authorizationId: extra.authorizationId } : {}),
      status: "COMPLETED",
      currency: order.currency,
      amountMinor,
      feeMinor: feeFor(amountMinor, order.currency),
      refundedMinor: 0,
      finalCapture: extra.finalCapture ?? true,
      ...(order.customId ? { customId: order.customId } : {}),
      ...((extra.invoiceId ?? order.invoiceId) ? { invoiceId: extra.invoiceId ?? order.invoiceId } : {}),
      refundIds: [],
      vault: order.mode === "vault",
      createTime: now,
      updateTime: now,
    };
    captures.set(capture.id, capture);
    order.captureIds.push(capture.id);
    transactions.push({
      id: capture.id,
      eventCode: capture.vault ? "T0003" : "T0006",
      currency: capture.currency,
      amountMinor,
      feeMinor: capture.feeMinor,
      status: "S",
      ...(capture.customId ? { customField: capture.customId } : {}),
      ...(capture.invoiceId ? { invoiceId: capture.invoiceId } : {}),
      referenceId: order.id,
      referenceType: "ODR",
      time: nowMs(),
    });
    emit("PAYMENT.CAPTURE.COMPLETED", "capture", "2.0", `Payment completed for ${summaryAmount(amountMinor, order.currency)}`, captureJson(capture));
    return capture;
  }

  function addAuthorization(order: OrderRec): AuthorizationRec {
    const now = ts();
    const auth: AuthorizationRec = {
      id: transactionId(rng),
      orderId: order.id,
      status: "CREATED",
      currency: order.currency,
      amountMinor: order.amountMinor,
      capturedMinor: 0,
      ...(order.customId ? { customId: order.customId } : {}),
      ...(order.invoiceId ? { invoiceId: order.invoiceId } : {}),
      captureIds: [],
      createTime: now,
      updateTime: now,
      expiresAt: nowMs() + 29 * DAY_MS,
    };
    authorizations.set(auth.id, auth);
    order.authorizationIds.push(auth.id);
    emit("PAYMENT.AUTHORIZATION.CREATED", "authorization", "2.0", "A payment authorization was created", authorizationJson(auth));
    return auth;
  }

  function orderPublic(o: OrderRec) {
    return orderResult(summarizeOrder(orderJson(o)));
  }

  /** Buyers keep a stable PayPal account id per email, like real accounts. */
  function partyFor(buyer?: { email?: string; givenName?: string; surname?: string }): Party {
    if (!buyer?.email && !buyer?.givenName && !buyer?.surname) return defaultBuyer;
    const email = buyer.email ?? defaultBuyer.email;
    let payerId = buyerIds.get(email);
    if (!payerId) {
      payerId = accountId(rng);
      buyerIds.set(email, payerId);
    }
    return {
      payerId,
      email,
      givenName: buyer.givenName ?? defaultBuyer.givenName,
      surname: buyer.surname ?? defaultBuyer.surname,
    };
  }

  // ------------------------------------------------------------------ the client

  const mock: MockPayPal = {
    mode: "mock",
    webhookId: webhookIdValue,

    createVaultSetupToken: (i) =>
      api("createVaultSetupToken", () => {
        const body = buildSetupTokenRequest(i, {});
        const key = i.requestId ? `setup:${assertRequestId(i.requestId)}` : undefined;
        const prior = key ? replay(key) : undefined;
        if (prior) return mapSetupToken(setupTokenJson(setupTokens.get(prior) as SetupTokenRec));
        const now = ts();
        const token: SetupTokenRec = {
          id: transactionId(rng),
          status: "PAYER_ACTION_REQUIRED",
          customerId: i.customerId ?? newCustomerId(rng),
          request: body,
          returnUrl: i.returnUrl,
          cancelUrl: i.cancelUrl,
          createTime: now,
          updateTime: now,
          expiresAt: nowMs() + 3 * DAY_MS,
        };
        setupTokens.set(token.id, token);
        if (key) idempotency.set(key, token.id);
        return mapSetupToken(setupTokenJson(token));
      }),

    createPaymentToken: (setupTokenId, popts) =>
      api("createPaymentToken", () => {
        const method = "POST";
        const path = "/v3/vault/payment-tokens";
        buildPaymentTokenRequest(setupTokenId); // same validation as the real client
        const key = popts?.requestId ? `pt:${assertRequestId(popts.requestId)}` : undefined;
        const prior = key ? replay(key) : undefined;
        if (prior) return mapPaymentToken(paymentTokenJson(paymentTokens.get(prior) as PaymentTokenRec));
        const token = setupTokens.get(setupTokenId);
        if (!token || nowMs() > token.expiresAt) {
          return fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", method, path, [
            { issue: "TOKEN_NOT_FOUND", description: "The specified token id does not exist." },
          ]);
        }
        if (token.status === "PAYER_ACTION_REQUIRED") {
          return unprocessable(method, path, "PAYER_ACTION_REQUIRED", "Please make sure setup up token is approved.");
        }
        if (token.status === "VAULTED") {
          return unprocessable(method, path, "SETUP_TOKEN_ALREADY_TOKENIZED", "The setup token has been used previously to generate a payment token.");
        }
        const payer = token.payer ?? defaultBuyer;
        const pt: PaymentTokenRec = {
          id: paymentTokenId(rng),
          customerId: token.customerId,
          setupTokenId: token.id,
          payer,
          request: token.request,
          createTime: ts(),
        };
        paymentTokens.set(pt.id, pt);
        token.status = "VAULTED";
        token.paymentTokenId = pt.id;
        token.updateTime = ts();
        if (key) idempotency.set(key, pt.id);
        emit("VAULT.PAYMENT-TOKEN.CREATED", "payment_token", "3.0", "A payment token has been created.", paymentTokenJson(pt));
        return mapPaymentToken(paymentTokenJson(pt));
      }),

    createOrder: (i) =>
      api("createOrder", () => {
        const method = "POST";
        const path = "/v2/checkout/orders";
        const built = buildOrderRequest(i, {});
        const key = `order:${built.requestId}`;
        const prior = replay(key);
        // PayPal returns the latest state of the resource created by an earlier call with this PayPal-Request-Id.
        if (prior) return orderPublic(orders.get(prior) as OrderRec);

        const unit = built.body.purchase_units[0];
        let payer: Party | undefined;
        if (built.mode === "vault") {
          const token = paymentTokens.get(i.vaultId as string);
          if (!token) return unprocessable(method, path, "TOKEN_ID_NOT_FOUND", "The specified payment token id does not exist.");
          if (opts.failVaultCharges) return unprocessable(method, path, "PAYMENT_DENIED", "PayPal has declined to process this transaction.");
          payer = token.payer;
        }
        const now = ts();
        const order: OrderRec = {
          id: transactionId(rng),
          intent: built.body.intent,
          status: built.mode === "vault" ? "COMPLETED" : built.mode === "redirect" ? "PAYER_ACTION_REQUIRED" : "CREATED",
          mode: built.mode,
          request: built.body,
          ...(i.vaultId ? { vaultId: i.vaultId } : {}),
          ...(payer ? { payer } : {}),
          currency: built.currency,
          amountMinor: built.amountMinor,
          ...(unit?.custom_id ? { customId: unit.custom_id } : {}),
          ...(unit?.invoice_id ? { invoiceId: unit.invoice_id } : {}),
          ...(i.returnUrl ? { returnUrl: i.returnUrl } : {}),
          ...(i.cancelUrl ? { cancelUrl: i.cancelUrl } : {}),
          captureIds: [],
          authorizationIds: [],
          createTime: now,
          updateTime: now,
        };
        if (order.invoiceId && [...orders.values()].some((o) => o.invoiceId === order.invoiceId && o.captureIds.length > 0)) {
          return unprocessable(method, path, "DUPLICATE_INVOICE_ID", "Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.");
        }
        orders.set(order.id, order);
        idempotency.set(key, order.id);
        if (built.mode === "vault") {
          if (order.intent === "CAPTURE") addCapture(order, order.amountMinor, {});
          else addAuthorization(order);
        }
        return orderPublic(order);
      }),

    getOrder: (id) =>
      api("getOrder", () => {
        const order = orders.get(assertResourceId(id, "orderId"));
        if (!order) return notFound("GET", `/v2/checkout/orders/${id}`);
        return summarizeOrder(orderJson(order));
      }),

    captureOrder: (orderId, requestId) =>
      api("captureOrder", () => {
        const method = "POST";
        const path = `/v2/checkout/orders/${assertResourceId(orderId, "orderId")}/capture`;
        const key = `capture-order:${assertRequestId(requestId)}`;
        const prior = replay(key);
        const order = orders.get(prior ?? orderId);
        if (!order) return notFound(method, path);
        if (!prior) {
          if (order.intent !== "CAPTURE") {
            return unprocessable(method, path, "ACTION_DOES_NOT_MATCH_INTENT", "The order was created with an intent of `AUTHORIZE`. To complete authorization, use `/v2/checkout/orders/{order_id}/authorize`.");
          }
          if (order.status === "COMPLETED") return unprocessable(method, path, "ORDER_ALREADY_CAPTURED", "Order already captured. If 'intent=CAPTURE' only one capture per order is allowed.");
          if (order.status !== "APPROVED") return unprocessable(method, path, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
          addCapture(order, order.amountMinor, {});
          order.status = "COMPLETED";
          order.updateTime = ts();
          idempotency.set(key, order.id);
        }
        const r = orderPublic(order);
        return { id: r.id, status: r.status, ...(r.captureId ? { captureId: r.captureId } : {}), ...(r.captureStatus ? { captureStatus: r.captureStatus } : {}) };
      }),

    authorizeOrder: (orderId, requestId) =>
      api("authorizeOrder", () => {
        const method = "POST";
        const path = `/v2/checkout/orders/${assertResourceId(orderId, "orderId")}/authorize`;
        const key = `authorize-order:${assertRequestId(requestId)}`;
        const prior = replay(key);
        const order = orders.get(prior ?? orderId);
        if (!order) return notFound(method, path);
        if (!prior) {
          if (order.intent !== "AUTHORIZE") {
            return unprocessable(method, path, "ACTION_DOES_NOT_MATCH_INTENT", "The order was created with an intent of `CAPTURE`. To complete the payment, use `/v2/checkout/orders/{order_id}/capture`.");
          }
          if (order.status === "COMPLETED") return unprocessable(method, path, "ORDER_ALREADY_AUTHORIZED", "Order already authorized. If 'intent=AUTHORIZE' only one authorization per order is allowed.");
          if (order.status !== "APPROVED") return unprocessable(method, path, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
          addAuthorization(order);
          order.status = "COMPLETED";
          order.updateTime = ts();
          idempotency.set(key, order.id);
        }
        const r = orderPublic(order);
        const auth = r.authorizationId ? authorizations.get(r.authorizationId) : undefined;
        return {
          id: r.id,
          status: r.status,
          ...(r.authorizationId ? { authorizationId: r.authorizationId } : {}),
          ...(r.authorizationStatus ? { authorizationStatus: r.authorizationStatus } : {}),
          ...(auth ? { expiresAt: toPayPalDate(new Date(auth.expiresAt)) } : {}),
        };
      }),

    captureAuthorization: (authorizationId, requestId, copts) =>
      api("captureAuthorization", () => {
        const method = "POST";
        const path = `/v2/payments/authorizations/${assertResourceId(authorizationId, "authorizationId")}/capture`;
        const body = buildCaptureAuthorizationRequest(copts);
        const key = `capture-auth:${assertRequestId(requestId)}`;
        const prior = replay(key);
        if (prior) {
          const c = captures.get(prior) as CaptureRec;
          return { captureId: c.id, status: c.status };
        }
        const auth = authorizations.get(authorizationId);
        if (!auth) return notFound(method, path);
        if (auth.status === "VOIDED") return unprocessable(method, path, "AUTHORIZATION_VOIDED", "A voided authorization cannot be captured or reauthorized.");
        if (auth.status === "CAPTURED") return unprocessable(method, path, "AUTHORIZATION_ALREADY_CAPTURED", "Authorization has already been captured.");
        if (nowMs() > auth.expiresAt) return unprocessable(method, path, "AUTHORIZATION_EXPIRED", "An expired authorization cannot be captured.");
        const remaining = auth.amountMinor - auth.capturedMinor;
        let amountMinor = remaining;
        if (body.amount) {
          if (body.amount.currency_code !== auth.currency) return unprocessable(method, path, "AUTH_CURRENCY_MISMATCH", "Currency of capture must be the same as currency of authorization.");
          amountMinor = toMinor({ currency: body.amount.currency_code, value: body.amount.value });
        }
        if (amountMinor > remaining) {
          return unprocessable(method, path, "MAX_CAPTURE_AMOUNT_EXCEEDED", "Capture amount specified exceeded allowable limit. You can only capture up to the original authorization amount.");
        }
        const order = orders.get(auth.orderId) as OrderRec;
        const finalCapture = body.final_capture ?? true;
        const capture = addCapture(order, amountMinor, { authorizationId: auth.id, finalCapture, ...(body.invoice_id ? { invoiceId: body.invoice_id } : {}) });
        auth.capturedMinor += amountMinor;
        auth.captureIds.push(capture.id);
        auth.status = finalCapture || auth.capturedMinor >= auth.amountMinor ? "CAPTURED" : "PARTIALLY_CAPTURED";
        auth.updateTime = ts();
        idempotency.set(key, capture.id);
        return { captureId: capture.id, status: capture.status };
      }),

    voidAuthorization: (authorizationId, vopts) =>
      api("voidAuthorization", () => {
        const method = "POST";
        const path = `/v2/payments/authorizations/${assertResourceId(authorizationId, "authorizationId")}/void`;
        const key = vopts?.requestId ? `void:${assertRequestId(vopts.requestId)}` : undefined;
        const prior = key ? replay(key) : undefined;
        if (prior) return { status: (authorizations.get(prior) as AuthorizationRec).status };
        const auth = authorizations.get(authorizationId);
        if (!auth) return notFound(method, path);
        if (auth.status === "CAPTURED") return unprocessable(method, path, "PREVIOUSLY_CAPTURED", "Authorization has been previously captured and cannot be voided.");
        if (auth.status === "VOIDED") return unprocessable(method, path, "PREVIOUSLY_VOIDED", "Authorization has been previously voided and hence cannot be voided again.");
        auth.status = "VOIDED";
        auth.updateTime = ts();
        if (key) idempotency.set(key, auth.id);
        emit("PAYMENT.AUTHORIZATION.VOIDED", "authorization", "2.0", "A payment authorization was voided", authorizationJson(auth));
        return { status: auth.status };
      }),

    refundCapture: (captureId, amount, requestId, ropts) =>
      api("refundCapture", () => {
        const method = "POST";
        const path = `/v2/payments/captures/${assertResourceId(captureId, "captureId")}/refund`;
        const body = buildRefundRequest(amount, ropts);
        const key = requestId ? `refund:${assertRequestId(requestId)}` : undefined;
        const prior = key ? replay(key) : undefined;
        if (prior) return { refundId: prior, status: "COMPLETED" };
        const capture = captures.get(captureId);
        if (!capture) return notFound(method, path);
        if (capture.status === "REFUNDED") return unprocessable(method, path, "CAPTURE_FULLY_REFUNDED", "The capture has already been fully refunded.");
        const remaining = capture.amountMinor - capture.refundedMinor;
        let amountMinor = remaining;
        if (body.amount) {
          if (body.amount.currency_code !== capture.currency) return unprocessable(method, path, "REFUND_CURRENCY_MISMATCH", "Refund currency must be the same as the capture currency.");
          amountMinor = toMinor({ currency: body.amount.currency_code, value: body.amount.value });
        }
        if (amountMinor > remaining) {
          return unprocessable(method, path, "REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
        }
        const dispute = capture.disputeId ? disputes.get(capture.disputeId) : undefined;
        if (dispute && dispute.status !== "RESOLVED" && amountMinor < remaining) {
          return unprocessable(method, path, "TRANSACTION_DISPUTED", "Partial refunds cannot be offered at this time because there is an open case on this transaction. Visit the PayPal Resolution Center to review this case.");
        }
        const refund: RefundRec = {
          id: transactionId(rng),
          captureId: capture.id,
          currency: capture.currency,
          amountMinor,
          ...(body.note_to_payer ? { note: body.note_to_payer } : {}),
          ...(body.custom_id ? { customId: body.custom_id } : {}),
          ...(body.invoice_id ? { invoiceId: body.invoice_id } : {}),
          createTime: ts(),
        };
        refunds.set(refund.id, refund);
        capture.refundIds.push(refund.id);
        capture.refundedMinor += amountMinor;
        capture.status = capture.refundedMinor >= capture.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
        capture.updateTime = ts();
        transactions.push({
          id: refund.id,
          eventCode: "T1107",
          currency: capture.currency,
          amountMinor: -amountMinor,
          feeMinor: 0,
          status: "S",
          ...((refund.customId ?? capture.customId) ? { customField: refund.customId ?? capture.customId } : {}),
          ...((refund.invoiceId ?? capture.invoiceId) ? { invoiceId: refund.invoiceId ?? capture.invoiceId } : {}),
          referenceId: capture.id,
          referenceType: "TXN",
          time: nowMs(),
        });
        if (key) idempotency.set(key, refund.id);
        emit("PAYMENT.CAPTURE.REFUNDED", "refund", "2.0", `A ${summaryAmount(amountMinor, capture.currency)} capture payment was refunded`, refundJson(refund));
        return { refundId: refund.id, status: "COMPLETED" };
      }),

    listDisputes: (filter) =>
      api("listDisputes", () => {
        let list = [...disputes.values()];
        if (filter?.transactionId) {
          const t = assertResourceId(filter.transactionId, "transactionId");
          list = list.filter((d) => d.captureId === t || d.buyerTransactionId === t);
        }
        if (filter?.states?.length) {
          const states = new Set(filter.states);
          list = list.filter((d) => states.has(disputeState(d)));
        }
        return list
          .sort((a, b) => (a.createTime < b.createTime ? 1 : a.createTime > b.createTime ? -1 : 0))
          .map((d): DisputeSummary => mapDisputeSummary(disputeListItem(d)));
      }),

    getDispute: (id) =>
      api("getDispute", () => {
        const dispute = disputes.get(assertResourceId(id, "disputeId"));
        if (!dispute) return notFound("GET", `/v1/customer/disputes/${id}`);
        return mapDisputeDetails(disputeJson(dispute));
      }),

    createSandboxDispute: (i) =>
      api("createSandboxDispute", () => {
        const v = parseSandboxDisputeInput(i);
        const strategy = v.strategy ?? "buyer-assertion";
        const method = "POST";
        const path = strategy === "chargeback" ? "/v2/customer-support/process-chargeback" : "/v1/customer/disputes";
        const capture = captures.get(v.captureId);
        if (!capture) return notFound(method, path);
        if (capture.disputeId) return unprocessable(method, path, "INVALID_PARAMETER_VALUE", "A dispute already exists for this transaction.");
        const amountMinor = toMinor(v.amount);
        if (v.amount.currency !== capture.currency || amountMinor > capture.amountMinor) {
          return unprocessable(method, path, "INVALID_PARAMETER_VALUE", "The dispute amount must be less than or equal to the transaction amount.");
        }
        const merchandise = v.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" || v.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
        const stage = strategy === "buyer-assertion" && merchandise ? "INQUIRY" : "CHARGEBACK";
        const now = ts();
        const dispute: DisputeRec = {
          id: newDisputeId(rng),
          captureId: capture.id,
          buyerTransactionId: transactionId(rng),
          reason: v.reason,
          status: "WAITING_FOR_SELLER_RESPONSE",
          stage,
          channel: strategy === "chargeback" ? "EXTERNAL" : "INTERNAL",
          currency: capture.currency,
          amountMinor,
          evidences: [
            { evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", date: now, dispute_life_cycle_stage: stage, notes: "Buyer opened a case" },
            {
              evidence_type: v.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" ? "PROOF_OF_FULFILLMENT" : "OTHER",
              source: "REQUESTED_FROM_SELLER",
              date: now,
              dispute_life_cycle_stage: stage,
            },
          ],
          createTime: now,
          updateTime: now,
          sellerResponseDueDate: toPayPalDate(new Date(nowMs() + 10 * DAY_MS)),
        };
        disputes.set(dispute.id, dispute);
        capture.disputeId = dispute.id;
        emit("CUSTOMER.DISPUTE.CREATED", "dispute", "1.1", `A new dispute opened with Case # ${dispute.id}`, disputeJson(dispute));
        return { id: dispute.id };
      }),

    provideEvidence: (disputeId, i) =>
      api("provideEvidence", () => {
        const id = assertResourceId(disputeId, "disputeId");
        const method = "POST";
        const path = `/v1/customer/disputes/${id}/provide-evidence`;
        const built = buildEvidence(i);
        const dispute = disputes.get(id);
        if (!dispute) return notFound(method, path);
        if (dispute.status !== "WAITING_FOR_SELLER_RESPONSE") {
          return unprocessable(method, path, "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE", "This action is not allowed for this dispute ID. For the allowed actions, see the HATEOAS link in show dispute details.");
        }
        const evidence = built.input.evidences[0];
        const now = ts();
        dispute.evidences.push({
          evidence_type: evidence?.evidence_type ?? "OTHER",
          source: "SUBMITTED_BY_SELLER",
          date: now,
          dispute_life_cycle_stage: dispute.stage,
          ...(evidence?.notes ? { notes: evidence.notes } : {}),
          ...(evidence?.evidence_info ? { evidence_info: evidence.evidence_info } : {}),
          ...(built.files.length ? { documents: built.files.map((f) => ({ name: f.filename })) } : {}),
        });
        dispute.status = "UNDER_REVIEW";
        dispute.updateTime = now;
        emit("CUSTOMER.DISPUTE.UPDATED", "dispute", "1.1", `A dispute was updated with Case # ${dispute.id}`, disputeJson(dispute));
        return { status: dispute.status };
      }),

    verifyWebhookSignature: (i) =>
      api("verifyWebhookSignature", () => {
        const h = lowerCaseHeaders(i.headers);
        const tid = h[WEBHOOK_HEADERS.transmissionId];
        const sent = tid ? delivered.find((d) => d.headers[WEBHOOK_HEADERS.transmissionId] === tid) : undefined;
        return (
          !!sent &&
          sent.body === i.body &&
          i.webhookId === webhookIdValue &&
          sent.headers[WEBHOOK_HEADERS.transmissionSig] === h[WEBHOOK_HEADERS.transmissionSig] &&
          sent.headers[WEBHOOK_HEADERS.certUrl] === h[WEBHOOK_HEADERS.certUrl]
        );
      }),

    searchTransactions: (i) =>
      api("searchTransactions", () => {
        const start = i.start instanceof Date ? i.start.getTime() : Number.NaN;
        const end = i.end instanceof Date ? i.end.getTime() : Number.NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
          throw new PayPalError({ status: 0, name: LOCAL_ERROR.validation, message: "searchTransactions: start must be a Date before end" });
        }
        return transactions
          .filter((t) => t.time >= start && t.time <= end && (!i.transactionId || t.id === i.transactionId))
          .map((t): TransactionRecord => mapTransaction(txnJson(t)));
      }),

    createPayout: (i) =>
      api("createPayout", () => {
        const body = buildPayoutRequest(i);
        const senderBatchId = body.sender_batch_header.sender_batch_id;
        const key = i.requestId ? `payout:${assertRequestId(i.requestId)}` : undefined;
        const prior = (key ? replay(key) : undefined) ?? payoutsBySender.get(senderBatchId);
        if (prior) {
          // Same as the real client: a reused sender_batch_id answers with the original batch, never a new one.
          return { ...mapPayoutBatch(payoutBatchJson(payoutBatches.get(prior) as PayoutBatchRec, false)), replayed: true };
        }
        const first = body.items[0] as (typeof body.items)[number];
        const batch: PayoutBatchRec = {
          id: accountId(rng),
          senderBatchId,
          status: "PENDING",
          currency: first.amount.currency,
          amountMinor: 0,
          feeMinor: 0,
          itemIds: [],
          createTime: ts(),
        };
        for (const it of body.items) {
          const amountMinor = toMinor({ currency: it.amount.currency, value: it.amount.value });
          const item: PayoutItemRec = {
            id: accountId(rng),
            batchId: batch.id,
            receiver: it.receiver,
            recipientType: it.recipient_type,
            currency: it.amount.currency,
            amountMinor,
            feeMinor: payoutFeeFor(amountMinor, it.amount.currency),
            status: "PENDING",
            ...(it.note ? { note: it.note } : {}),
            ...(it.sender_item_id ? { senderItemId: it.sender_item_id } : {}),
          };
          payoutItems.set(item.id, item);
          batch.itemIds.push(item.id);
          if (item.currency === batch.currency) {
            batch.amountMinor += amountMinor;
            batch.feeMinor += item.feeMinor;
          }
        }
        payoutBatches.set(batch.id, batch);
        payoutsBySender.set(senderBatchId, batch.id);
        if (key) idempotency.set(key, batch.id);
        emit("PAYMENT.PAYOUTSBATCH.PROCESSING", "payouts", "1.0", "Payouts batch is getting processed.", payoutBatchJson(batch, false));
        return mapPayoutBatch(payoutBatchJson(batch, false));
      }),

    getPayoutBatch: (batchId, popts) =>
      api("getPayoutBatch", () => {
        const id = assertResourceId(batchId, "payoutBatchId");
        const batch = payoutBatches.get(id);
        if (!batch) return notFound("GET", `/v1/payments/payouts/${id}`);
        processPayoutBatch(batch);
        const json = payoutBatchJson(batch, true);
        if (popts?.pageSize) {
          const page = Math.max(1, popts.page ?? 1);
          json.items = (json.items as unknown[]).slice((page - 1) * popts.pageSize, page * popts.pageSize);
        }
        return mapPayoutBatch(json);
      }),

    getPayoutItem: (itemId) =>
      api("getPayoutItem", () => {
        const id = assertResourceId(itemId, "payoutItemId");
        const item = payoutItems.get(id);
        if (!item) return notFound("GET", `/v1/payments/payouts-item/${id}`);
        const batch = payoutBatches.get(item.batchId);
        if (batch) processPayoutBatch(batch);
        return mapPayoutItem(payoutItemJson(item));
      }),

    // ---------------------------------------------------------------- simulation helpers

    simulateBuyerApproval(id, buyer) {
      const token = setupTokens.get(id);
      if (token) {
        if (token.status !== "PAYER_ACTION_REQUIRED") {
          throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `setup token ${id} is ${token.status}, not awaiting approval` });
        }
        token.payer = partyFor(buyer);
        token.status = "APPROVED";
        token.updateTime = ts();
        record({ kind: "buyer", action: "approve_setup_token", id, status: token.status, detail: { payer: token.payer.email } });
        return {
          kind: "setup_token",
          id,
          status: token.status,
          redirectUrl: withQuery(token.returnUrl, { approval_token_id: id, approval_session_id: id }),
        };
      }
      const order = orders.get(id);
      if (order) {
        if (order.status !== "PAYER_ACTION_REQUIRED" && order.status !== "CREATED") {
          throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `order ${id} is ${order.status}, not awaiting buyer approval` });
        }
        order.payer = partyFor(buyer);
        order.status = "APPROVED";
        order.updateTime = ts();
        record({ kind: "buyer", action: "approve_order", id, status: order.status, detail: { payer: order.payer.email } });
        emit("CHECKOUT.ORDER.APPROVED", "checkout-order", "2.0", "An order has been approved by buyer", orderJson(order));
        return {
          kind: "order",
          id,
          status: order.status,
          redirectUrl: order.returnUrl ? withQuery(order.returnUrl, { token: id, PayerID: order.payer.payerId }) : "",
        };
      }
      throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `no setup token or order ${id}` });
    },

    simulateBuyerCancel(id) {
      const token = setupTokens.get(id);
      const order = token ? undefined : orders.get(id);
      if (!token && !order) throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `no setup token or order ${id}` });
      record({ kind: "buyer", action: token ? "cancel_setup_token" : "cancel_order", id });
      const cancelUrl = token?.cancelUrl ?? order?.cancelUrl;
      return {
        kind: token ? "setup_token" : "order",
        id,
        status: token?.status ?? order?.status ?? "UNKNOWN",
        redirectUrl: cancelUrl ? withQuery(cancelUrl, token ? { approval_token_id: id } : { token: id }) : "",
      };
    },

    simulateDisputeDecision(disputeId, outcome) {
      const dispute = disputes.get(disputeId);
      if (!dispute) throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `no dispute ${disputeId}` });
      if (dispute.status !== "UNDER_REVIEW") {
        throw new PayPalError({
          status: 422,
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE", description: "Settle dispute needs status UNDER_REVIEW." }],
        });
      }
      dispute.status = "RESOLVED";
      dispute.outcome = outcome === "SELLER_FAVOR" ? "RESOLVED_SELLER_FAVOUR" : "RESOLVED_BUYER_FAVOUR";
      dispute.updateTime = ts();
      const capture = captures.get(dispute.captureId);
      if (outcome === "BUYER_FAVOR" && capture) {
        const reversalId = transactionId(rng);
        capture.refundedMinor = Math.min(capture.amountMinor, capture.refundedMinor + dispute.amountMinor);
        capture.status = capture.refundedMinor >= capture.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
        capture.updateTime = ts();
        transactions.push({
          id: reversalId,
          eventCode: "T1106",
          currency: dispute.currency,
          amountMinor: -dispute.amountMinor,
          feeMinor: 0,
          status: "S",
          ...(capture.customId ? { customField: capture.customId } : {}),
          referenceId: capture.id,
          referenceType: "TXN",
          time: nowMs(),
        });
        emit("PAYMENT.CAPTURE.REVERSED", "capture", "2.0", `A ${summaryAmount(dispute.amountMinor, dispute.currency)} capture payment was reversed`, captureJson(capture));
      }
      record({ kind: "simulation", action: "dispute_decision", id: disputeId, status: dispute.status, detail: { outcome: dispute.outcome } });
      emit("CUSTOMER.DISPUTE.RESOLVED", "dispute", "1.1", `A dispute was resolved with case # ${dispute.id}`, disputeJson(dispute));
      return { status: dispute.status, outcome: dispute.outcome };
    },

    simulateDisputeRequireEvidence(disputeId) {
      const dispute = disputes.get(disputeId);
      if (!dispute) throw new PayPalError({ status: 0, name: "MOCK_SIMULATION_ERROR", message: `no dispute ${disputeId}` });
      if (dispute.status !== "UNDER_REVIEW") {
        throw new PayPalError({
          status: 422,
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE", description: "Update dispute status needs status UNDER_REVIEW." }],
        });
      }
      const now = ts();
      dispute.status = "WAITING_FOR_SELLER_RESPONSE";
      dispute.updateTime = now;
      dispute.sellerResponseDueDate = toPayPalDate(new Date(nowMs() + 10 * DAY_MS));
      dispute.evidences.push({ evidence_type: "OTHER", source: "REQUESTED_FROM_SELLER", date: now, dispute_life_cycle_stage: dispute.stage });
      record({ kind: "simulation", action: "dispute_require_evidence", id: disputeId, status: dispute.status });
      emit("CUSTOMER.DISPUTE.UPDATED", "dispute", "1.1", `A dispute was updated with Case # ${dispute.id}`, disputeJson(dispute));
      return { status: dispute.status };
    },

    _state(): MockSnapshot {
      return deepClone({
        merchant,
        setupTokens: [...setupTokens.values()].map(setupTokenJson),
        paymentTokens: [...paymentTokens.values()].map(paymentTokenJson),
        orders: [...orders.values()].map(orderJson),
        authorizations: [...authorizations.values()].map(authorizationJson),
        captures: [...captures.values()].map(captureJson),
        refunds: [...refunds.values()].map(refundJson),
        disputes: [...disputes.values()].map(disputeJson),
        transactions: transactions.map(txnJson),
        eventCount: eventLog.length,
        webhookCount: delivered.length,
      });
    },

    events: () => deepClone(eventLog),
    webhooks: () => deepClone(delivered),

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    onWebhook(listener) {
      webhookListeners.add(listener);
      return () => {
        webhookListeners.delete(listener);
      };
    },

    async flushWebhooks() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };

  return mock;
}
