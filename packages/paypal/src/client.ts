/**
 * Real PayPal REST client on plain fetch (no SDK lock-in, and injectable fetch for tests).
 * Endpoint shapes and sources are documented in docs/PAYPAL_NOTES.md.
 */
import { z } from "zod";
import { LOCAL_ERROR, PayPalError, validationError } from "./errors.js";
import { type HttpLogEntry, PayPalHttp, type TokenInfo, authAssertion } from "./http.js";
import { newRequestId } from "./ids.js";
import {
  authorizationExpiry,
  duplicatePayoutBatchId,
  idFromHref,
  lowerCaseHeaders,
  mapCapturedPayment,
  mapDisputeDetails,
  mapDisputeSummary,
  mapIdStatus,
  mapPaymentToken,
  mapPayoutBatch,
  mapPayoutItem,
  mapSetupToken,
  mapTransaction,
  orderResult,
  parseDisputeList,
  parseSearchResponse,
  summarizeOrder,
  toPayPalDate,
  verifyResponseSchema,
  WEBHOOK_HEADERS,
} from "./mappers.js";
import { fromPayPalMoney } from "./money.js";
import { encodeMultipart } from "./multipart.js";
import {
  assertRequestId,
  assertResourceId,
  buildBuyerDisputeInput,
  buildCaptureAuthorizationRequest,
  buildChargebackRequest,
  buildEvidence,
  buildOrderRequest,
  buildPaymentTokenRequest,
  buildPayoutRequest,
  buildRefundRequest,
  buildSetupTokenRequest,
  parseSandboxDisputeInput,
  payoutRequestId,
} from "./requests.js";
import type {
  CreatePayoutInput,
  CreateSandboxDisputeInput,
  DisputeSummary,
  ListDisputesFilter,
  PayPalClient,
  PayPalEnv,
  PayoutBatch,
  PayoutItem,
  ProvideEvidenceInput,
  SearchTransactionsInput,
  TransactionRecord,
  VerifyWebhookInput,
} from "./types.js";

export type PayPalClientConfig = {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  fetch?: typeof fetch;
  // Extensions:
  /** Override the API base URL (e.g. a recording proxy). */
  baseUrl?: string;
  /** PayPal partner BN code, sent as PayPal-Partner-Attribution-Id. */
  partnerAttributionId?: string;
  /** Default brand name on PayPal approval pages. */
  brandName?: string;
  /** Sandbox personal account email used by createSandboxDispute's buyer-assertion strategy. */
  sandboxBuyerEmail?: string;
  /** Adds payment_source.paypal.stored_credential (payment_initiator MERCHANT) to vault_id orders. */
  vaultStoredCredential?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  timeoutMs?: number;
  /** Called once per HTTP attempt with method, path, status, timing and PayPal debug id. No secrets. */
  onLog?: (entry: HttpLogEntry) => void;
};

/** The real client: the contract plus diagnostics. */
export type RealPayPalClient = PayPalClient & {
  readonly mode: "paypal";
  readonly env: PayPalEnv;
  createSandboxDispute(i: CreateSandboxDisputeInput): Promise<{ id: string }>;
  /** OAuth scopes granted to the app; shows which features (vault, disputes, reporting) are enabled. */
  tokenInfo(): Promise<TokenInfo>;
  createPayout(i: CreatePayoutInput): Promise<PayoutBatch>;
  getPayoutBatch(batchId: string, opts?: { page?: number; pageSize?: number }): Promise<PayoutBatch>;
  getPayoutItem(itemId: string): Promise<PayoutItem>;
};

const configSchema = z.object({
  clientId: z.string().trim().min(1, "clientId is required"),
  clientSecret: z.string().trim().min(1, "clientSecret is required"),
  env: z.enum(["sandbox", "live"]),
});

const PREFER_FULL = "return=representation" as const;
const TRANSACTION_WINDOW_MS = 31 * 24 * 3600 * 1000 - 1000; // Transaction Search: max 31 days per call
const DISPUTE_PAGE_SIZE = 50;

export function createPayPalClient(cfg: PayPalClientConfig): RealPayPalClient {
  const checked = configSchema.safeParse(cfg);
  if (!checked.success) {
    // Only field names and rule messages; never echo the provided values.
    throw validationError(`createPayPalClient: ${checked.error.issues.map((i) => i.message).join("; ")}`);
  }
  const { clientId, env } = checked.data;
  const http = new PayPalHttp({
    clientId,
    clientSecret: checked.data.clientSecret,
    env,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.partnerAttributionId ? { partnerAttributionId: cfg.partnerAttributionId } : {}),
    ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
    ...(cfg.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: cfg.retryBaseDelayMs } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(cfg.onLog ? { onLog: cfg.onLog } : {}),
  });
  const defaults = {
    ...(cfg.brandName ? { brandName: cfg.brandName } : {}),
    vaultStoredCredential: cfg.vaultStoredCredential ?? false,
  };

  const client: RealPayPalClient = {
    mode: "paypal",
    env,

    tokenInfo: () => http.tokenInfo(),

    async createVaultSetupToken(i) {
      const body = buildSetupTokenRequest(i, defaults);
      const res = await http.request({
        method: "POST",
        path: "/v3/vault/setup-tokens",
        json: body,
        requestId: i.requestId ?? newRequestId(),
      });
      return mapSetupToken(res.data);
    },

    async createPaymentToken(setupTokenId, opts) {
      const body = buildPaymentTokenRequest(setupTokenId);
      const res = await http.request({
        method: "POST",
        path: "/v3/vault/payment-tokens",
        json: body,
        requestId: opts?.requestId ? assertRequestId(opts.requestId) : newRequestId(),
      });
      return mapPaymentToken(res.data);
    },

    async createOrder(i) {
      const built = buildOrderRequest(i, defaults);
      const res = await http.request({
        method: "POST",
        path: "/v2/checkout/orders",
        json: built.body,
        requestId: built.requestId,
        prefer: PREFER_FULL,
      });
      return orderResult(summarizeOrder(res.data));
    },

    async getOrder(id) {
      const res = await http.request({ method: "GET", path: `/v2/checkout/orders/${assertResourceId(id, "orderId")}` });
      return summarizeOrder(res.data);
    },

    async captureOrder(orderId, requestId) {
      const res = await http.request({
        method: "POST",
        path: `/v2/checkout/orders/${assertResourceId(orderId, "orderId")}/capture`,
        json: {},
        requestId: assertRequestId(requestId),
        prefer: PREFER_FULL,
      });
      const d = summarizeOrder(res.data);
      return {
        id: d.id,
        status: d.status,
        ...(d.captureId ? { captureId: d.captureId } : {}),
        ...(d.captureStatus ? { captureStatus: d.captureStatus } : {}),
      };
    },

    async authorizeOrder(orderId, requestId) {
      const res = await http.request({
        method: "POST",
        path: `/v2/checkout/orders/${assertResourceId(orderId, "orderId")}/authorize`,
        json: {},
        requestId: assertRequestId(requestId),
        prefer: PREFER_FULL,
      });
      const d = summarizeOrder(res.data);
      const expiresAt = authorizationExpiry(res.data);
      return {
        id: d.id,
        status: d.status,
        ...(d.authorizationId ? { authorizationId: d.authorizationId } : {}),
        ...(d.authorizationStatus ? { authorizationStatus: d.authorizationStatus } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
    },

    async captureAuthorization(authorizationId, requestId, opts) {
      const res = await http.request({
        method: "POST",
        path: `/v2/payments/authorizations/${assertResourceId(authorizationId, "authorizationId")}/capture`,
        json: buildCaptureAuthorizationRequest(opts),
        requestId: assertRequestId(requestId),
        prefer: PREFER_FULL,
      });
      const r = mapIdStatus(res.data, "capture");
      return { captureId: r.id, status: r.status };
    },

    async voidAuthorization(authorizationId, opts) {
      const res = await http.request({
        method: "POST",
        path: `/v2/payments/authorizations/${assertResourceId(authorizationId, "authorizationId")}/void`,
        requestId: opts?.requestId ? assertRequestId(opts.requestId) : newRequestId(),
        prefer: PREFER_FULL,
      });
      // 204 No Content (minimal) carries no body; 200 returns the voided authorization.
      if (res.data === undefined) return { status: "VOIDED" };
      return { status: mapIdStatus(res.data, "void").status };
    },

    async refundCapture(captureId, amount, requestId, opts) {
      const res = await http.request({
        method: "POST",
        path: `/v2/payments/captures/${assertResourceId(captureId, "captureId")}/refund`,
        json: buildRefundRequest(amount, opts),
        requestId: requestId ? assertRequestId(requestId) : newRequestId(),
        prefer: PREFER_FULL,
      });
      const r = mapIdStatus(res.data, "refund");
      return { refundId: r.id, status: r.status };
    },

    async listDisputes(filter?: ListDisputesFilter) {
      const maxPages = Math.max(1, Math.min(filter?.maxPages ?? 4, 50));
      const out: DisputeSummary[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const res = await http.request({
          method: "GET",
          path: "/v1/customer/disputes",
          query: {
            page_size: DISPUTE_PAGE_SIZE,
            page,
            ...(filter?.transactionId ? { disputed_transaction_id: assertResourceId(filter.transactionId, "transactionId") } : {}),
            ...(filter?.states?.length ? { dispute_state: filter.states.join(",") } : {}),
          },
        });
        const list = parseDisputeList(res.data);
        const items = list.items ?? [];
        out.push(...items.map(mapDisputeSummary));
        if (items.length < DISPUTE_PAGE_SIZE) break;
      }
      return out;
    },

    async getDispute(id) {
      const res = await http.request({ method: "GET", path: `/v1/customer/disputes/${assertResourceId(id, "disputeId")}` });
      return mapDisputeDetails(res.data);
    },

    async createSandboxDispute(i) {
      if (env !== "sandbox") {
        throw new PayPalError({ status: 0, name: LOCAL_ERROR.sandboxOnly, message: "createSandboxDispute only exists in the PayPal sandbox" });
      }
      const v = parseSandboxDisputeInput(i);
      const buyerEmail = v.buyerEmail ?? cfg.sandboxBuyerEmail;
      const strategy = v.strategy ?? (buyerEmail ? "buyer-assertion" : "chargeback");

      if (strategy === "buyer-assertion") {
        if (!buyerEmail) throw validationError("buyer-assertion strategy needs buyerEmail or cfg.sandboxBuyerEmail");
        const multipart = encodeMultipart([
          { name: "input", contentType: "application/json", data: JSON.stringify(buildBuyerDisputeInput(v)) },
        ]);
        const res = await http.request<{ links?: { href: string; rel: string }[]; dispute_id?: string }>({
          method: "POST",
          path: "/v1/customer/disputes",
          multipart,
          requestId: newRequestId(),
          authAssertion: authAssertion(clientId, { email: buyerEmail }),
          retry: false,
        });
        const id = res.data?.dispute_id ?? idFromHref(res.data?.links?.find((l) => l.rel === "self")?.href);
        if (!id) throw new PayPalError({ status: res.status, name: LOCAL_ERROR.unexpectedResponse, message: "dispute created but no id returned" });
        return { id };
      }

      // Chargeback simulation: needs the merchant id and the captured amount from the capture itself.
      const capRes = await http.request({ method: "GET", path: `/v2/payments/captures/${v.captureId}` });
      const capture = mapCapturedPayment(capRes.data);
      const merchantId = capture.payee?.merchant_id;
      if (!merchantId || !capture.amount) {
        throw new PayPalError({ status: capRes.status, name: LOCAL_ERROR.unexpectedResponse, message: "capture response lacks payee.merchant_id or amount" });
      }
      const res = await http.request<{ dispute_id?: string }>({
        method: "POST",
        path: "/v2/customer-support/process-chargeback",
        json: buildChargebackRequest({
          merchantId,
          captureId: v.captureId,
          captureAmount: fromPayPalMoney(capture.amount),
          disputeAmount: v.amount,
          now: new Date(),
        }),
        requestId: newRequestId(),
        retry: false,
      });
      const id = res.data?.dispute_id;
      if (!id) throw new PayPalError({ status: res.status, name: LOCAL_ERROR.unexpectedResponse, message: "chargeback created but no dispute_id returned" });
      return { id };
    },

    async provideEvidence(disputeId, i: ProvideEvidenceInput) {
      const id = assertResourceId(disputeId, "disputeId");
      const built = buildEvidence(i);
      const multipart = encodeMultipart([
        { name: "input", contentType: "application/json", data: JSON.stringify(built.input) },
        ...built.files.map((f) => ({ name: "evidence-file", filename: f.filename, contentType: f.contentType, data: f.data })),
      ]);
      await http.request({
        method: "POST",
        path: `/v1/customer/disputes/${id}/provide-evidence`,
        multipart,
        requestId: newRequestId(),
        // Re-sending evidence could duplicate it, so no automatic retries on 5xx.
        retry: false,
      });
      // The response only carries HATEOAS links; read the dispute back for its new status.
      try {
        return { status: (await client.getDispute(id)).status };
      } catch {
        return { status: "EVIDENCE_SUBMITTED" };
      }
    },

    async verifyWebhookSignature(i: VerifyWebhookInput) {
      const h = lowerCaseHeaders(i.headers);
      const values = [
        h[WEBHOOK_HEADERS.authAlgo],
        h[WEBHOOK_HEADERS.certUrl],
        h[WEBHOOK_HEADERS.transmissionId],
        h[WEBHOOK_HEADERS.transmissionSig],
        h[WEBHOOK_HEADERS.transmissionTime],
      ];
      if (values.some((v) => !v) || !i.webhookId) return false;
      try {
        const parsed: unknown = JSON.parse(i.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      } catch {
        return false;
      }
      // PayPal: "the webhook_event data must be posted back exactly as it was received". Re-serialising
      // parsed JSON can change number formatting or escaping and fail verification, so we splice the raw
      // body into the request instead of JSON.stringify-ing an object.
      const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = values as string[];
      const rawJson =
        `{"auth_algo":${JSON.stringify(authAlgo)},"cert_url":${JSON.stringify(certUrl)},` +
        `"transmission_id":${JSON.stringify(transmissionId)},"transmission_sig":${JSON.stringify(transmissionSig)},` +
        `"transmission_time":${JSON.stringify(transmissionTime)},"webhook_id":${JSON.stringify(i.webhookId)},` +
        `"webhook_event":${i.body}}`;
      try {
        const res = await http.request({ method: "POST", path: "/v1/notifications/verify-webhook-signature", rawJson, retry: true });
        const parsed = verifyResponseSchema.safeParse(res.data);
        return parsed.success && parsed.data.verification_status === "SUCCESS";
      } catch (e) {
        // A 4xx means PayPal rejected the inputs (bad cert url, malformed headers): not verified.
        // 5xx and network failures are rethrown so the webhook endpoint answers non-2xx and PayPal retries.
        if (e instanceof PayPalError && e.status >= 400 && e.status < 500) return false;
        throw e;
      }
    },

    async searchTransactions(i: SearchTransactionsInput) {
      const start = i.start instanceof Date ? i.start.getTime() : Number.NaN;
      const end = i.end instanceof Date ? Math.min(i.end.getTime(), Date.now()) : Number.NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw validationError("searchTransactions: start and end must be valid Dates");
      if (start >= end) throw validationError("searchTransactions: start must be before end (and in the past)");
      const out: TransactionRecord[] = [];
      let from = start;
      while (from < end) {
        const to = Math.min(from + TRANSACTION_WINDOW_MS, end);
        for (let page = 1; page <= 100; page++) {
          const res = await http.request({
            method: "GET",
            path: "/v1/reporting/transactions",
            query: {
              start_date: toPayPalDate(new Date(from)),
              end_date: toPayPalDate(new Date(to)),
              fields: "transaction_info",
              page_size: 500,
              page,
              ...(i.transactionId ? { transaction_id: assertResourceId(i.transactionId, "transactionId") } : {}),
            },
          });
          const parsed = parseSearchResponse(res.data);
          for (const detail of parsed.transaction_details ?? []) {
            if (detail.transaction_info) out.push(mapTransaction(detail.transaction_info));
          }
          if (!parsed.total_pages || page >= parsed.total_pages) break;
        }
        // Bounds are inclusive with second precision, so the next window starts one second later.
        from = to + 1000;
      }
      return out;
    },

    async createPayout(i) {
      const body = buildPayoutRequest(i);
      const requestId = i.requestId ? assertRequestId(i.requestId) : await payoutRequestId(body.sender_batch_header.sender_batch_id);
      try {
        const res = await http.request({ method: "POST", path: "/v1/payments/payouts", json: body, requestId });
        return mapPayoutBatch(res.data);
      } catch (e) {
        // A sender_batch_id is paid at most once: PayPal refuses a reused one and links the original batch.
        // Answer with that batch so a retry (timeout, crash, double click) never looks like a new payout.
        const original = e instanceof PayPalError ? duplicatePayoutBatchId(e) : undefined;
        if (!original) throw e;
        return { ...(await client.getPayoutBatch(original)), replayed: true };
      }
    },

    async getPayoutBatch(batchId, opts) {
      const res = await http.request({
        method: "GET",
        path: `/v1/payments/payouts/${assertResourceId(batchId, "payoutBatchId")}`,
        query: {
          ...(opts?.page ? { page: opts.page } : {}),
          ...(opts?.pageSize ? { page_size: opts.pageSize } : {}),
        },
      });
      return mapPayoutBatch(res.data);
    },

    async getPayoutItem(itemId) {
      const res = await http.request({ method: "GET", path: `/v1/payments/payouts-item/${assertResourceId(itemId, "payoutItemId")}` });
      return mapPayoutItem(res.data);
    },
  };
  return client;
}
