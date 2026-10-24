/**
 * Public types for @goodfaith/paypal.
 *
 * The `PayPalClient` interface is the binding contract from docs/CONTRACTS.md. Everything marked
 * "Extension" is optional and backwards compatible with that contract: callers that only use the
 * contract shape keep working, and the real client and the mock both honour the extensions.
 */

/** Money is always a decimal string, exactly as PayPal sends it: `{ currency: "USD", value: "38.50" }`. */
export type Money = { currency: string; value: string };

export type PayPalEnv = "sandbox" | "live";

export type ItemCategory = "PHYSICAL_GOODS" | "DIGITAL_GOODS";

export type OrderItem = {
  name: string;
  sku?: string;
  unitAmount: Money;
  quantity: number;
  category?: ItemCategory;
};

/** Extension: a shipping address that maps to `purchase_units[].shipping`. */
export type ShippingAddress = {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  /** State / province code (PayPal `admin_area_1`), e.g. "CA". */
  state?: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string;
};

// ---------------------------------------------------------------------------------------------
// Vault v3
// ---------------------------------------------------------------------------------------------

export type CreateVaultSetupTokenInput = {
  returnUrl: string;
  cancelUrl: string;
  /** PayPal-generated customer id from an earlier vault, to attach another token to the same payer. */
  customerId?: string;
  /** Extension: text shown to the payer on the PayPal approval sheet (max 128 chars). */
  description?: string;
  /** Extension: your own customer id; PayPal stores it as `merchant_customer_id`. */
  merchantCustomerId?: string;
  /** Extension: overrides the business name shown on the approval sheet. */
  brandName?: string;
  /** Extension: PayPal-Request-Id; a random UUID is used when omitted. */
  requestId?: string;
};

export type VaultSetupToken = {
  id: string;
  /** Where to send the payer to approve saving their PayPal wallet. */
  approveUrl: string;
  /** PAYER_ACTION_REQUIRED until the payer approves, then APPROVED, then VAULTED. */
  status: string;
  /** Extension: PayPal customer id (present when PayPal returns it). */
  customerId?: string;
};

export type PaymentToken = {
  /** The payment token id. Pass it as `vaultId` to `createOrder` for merchant-initiated charges. */
  vaultId: string;
  customerId: string;
  payerEmail?: string;
  /** Extension: the payer's PayPal account id. */
  payerId?: string;
};

export type CreatePaymentTokenOptions = {
  /** Extension: PayPal-Request-Id; a random UUID is used when omitted. */
  requestId?: string;
};

// ---------------------------------------------------------------------------------------------
// Orders v2 / Payments v2
// ---------------------------------------------------------------------------------------------

export type CreateOrderInput = {
  intent: "CAPTURE" | "AUTHORIZE";
  amount: Money;
  /** Shown to the payer; PayPal truncates anything beyond 127 characters. */
  description?: string;
  /** Not shown to the payer; appears in reports, webhooks and disputes. Apps can put a reference hash here. */
  customId?: string;
  /** Shown to the payer; must be unique per merchant account by default (DUPLICATE_INVOICE_ID otherwise). */
  invoiceId?: string;
  /** Present => merchant-initiated charge against a vaulted PayPal wallet, buyer not present. */
  vaultId?: string;
  items?: OrderItem[];
  /** Both URLs present => buyer-approval (redirect) flow with `payment_source.paypal.experience_context`. */
  returnUrl?: string;
  cancelUrl?: string;
  /** PayPal-Request-Id (idempotency key). Mandatory for single-step (vault) orders. Max 108 chars. */
  requestId: string;
  /** Extension: amount breakdown. When items are given without a breakdown, any remainder goes to `handling` (or `discount` if negative). */
  breakdown?: { shipping?: Money; tax?: Money; handling?: Money; discount?: Money };
  /** Extension: ship-to address. For buyer-approval orders it also sets shipping_preference SET_PROVIDED_ADDRESS. */
  shipTo?: ShippingAddress;
  /** Extension: overrides the business name on the approval page. */
  brandName?: string;
  /** Extension: statement descriptor (PayPal keeps 22 characters). */
  softDescriptor?: string;
};

export type CreateOrderResult = {
  id: string;
  status: string;
  approveUrl?: string;
  captureId?: string;
  authorizationId?: string;
  /** Extension: status of the capture. An order can be COMPLETED while its capture is PENDING or DECLINED. */
  captureStatus?: string;
  /** Extension: status of the authorization (CREATED, CAPTURED, VOIDED, ...). */
  authorizationStatus?: string;
};

export type OrderDetails = {
  id: string;
  status: string;
  raw: unknown;
  // Extensions (normalised from `raw`):
  intent?: string;
  amount?: Money;
  customId?: string;
  invoiceId?: string;
  captureId?: string;
  captureStatus?: string;
  authorizationId?: string;
  authorizationStatus?: string;
  payerEmail?: string;
  approveUrl?: string;
};

export type CaptureOrderResult = { id: string; status: string; captureId?: string; captureStatus?: string };

export type AuthorizeOrderResult = {
  id: string;
  status: string;
  authorizationId?: string;
  authorizationStatus?: string;
  /** Extension: when the authorization expires (PayPal honours it for 3 days, keeps it for 29). */
  expiresAt?: string;
};

/** Extension: partial captures support the "authorise the budget, capture per purchase" fallback. */
export type CaptureAuthorizationOptions = {
  amount?: Money;
  /** Default true. Set false to keep the authorization open for further captures. */
  finalCapture?: boolean;
  invoiceId?: string;
  noteToPayer?: string;
};

export type CaptureAuthorizationResult = { captureId: string; status: string };

export type VoidAuthorizationOptions = { requestId?: string };

export type RefundOptions = { note?: string; customId?: string; invoiceId?: string };

export type RefundResult = { refundId: string; status: string };

// ---------------------------------------------------------------------------------------------
// Disputes v1
// ---------------------------------------------------------------------------------------------

export type DisputeSummary = {
  id: string;
  status: string;
  reason: string;
  amount: Money;
  /** Seller-side transaction id (the capture id) when PayPal provides it, else the buyer-side id. */
  transactionId?: string;
  // Extensions:
  stage?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type DisputeDetails = {
  id: string;
  status: string;
  reason: string;
  amount: Money;
  raw: unknown;
  // Extensions:
  transactionId?: string;
  /** `disputed_transactions[0].custom`: the custom_id sent with the order, i.e. our closed-mandate hash. */
  customId?: string;
  stage?: string;
  state?: string;
  sellerResponseDueDate?: string;
  /** HATEOAS rels other than `self`, e.g. ["provide_evidence", "accept_claim"]. */
  allowedActions: string[];
  /** Evidence types PayPal requested from the seller (source REQUESTED_FROM_SELLER). */
  requestedEvidence: string[];
  outcome?: string;
};

export type ListDisputesFilter = {
  /** Only disputes for this transaction (capture) id. */
  transactionId?: string;
  /** dispute_state values, e.g. ["REQUIRED_ACTION"]. */
  states?: string[];
  /** Pages of 50 to fetch at most (default 4). */
  maxPages?: number;
};

export type DisputeReason =
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "CREDIT_NOT_PROCESSED"
  | "DUPLICATE_TRANSACTION"
  | "INCORRECT_AMOUNT"
  | "PAYMENT_BY_OTHER_MEANS"
  | "CANCELED_RECURRING_BILLING"
  | "PROBLEM_WITH_REMITTANCE"
  | "OTHER";

export type CreateSandboxDisputeInput = {
  captureId: string;
  /** A Disputes v1 reason, e.g. "UNAUTHORISED" or "MERCHANDISE_OR_SERVICE_NOT_RECEIVED". */
  reason: string;
  amount: Money;
  /**
   * Extension. "chargeback": POST /v2/customer-support/process-chargeback (no buyer consent needed).
   * "buyer-assertion": POST /v1/customer/disputes as the buyer via PayPal-Auth-Assertion (needs the
   * DISPUTE_CREATE scope on the app and the buyer's consent). Default: "buyer-assertion" when a buyer
   * email is configured, else "chargeback".
   */
  strategy?: "chargeback" | "buyer-assertion";
  /** Extension: sandbox personal account email for the buyer-assertion strategy. */
  buyerEmail?: string;
  /** Extension: the buyer-side transaction id, if known (buyer-assertion strategy). */
  buyerTransactionId?: string;
};

export type EvidenceFile = { name: string; contentType: string; data: Uint8Array };

export type ProvideEvidenceInput = {
  /** Max 2000 characters. */
  notes: string;
  /** JPG, JPEG, GIF, PNG or PDF; each under 10 MB, at most 50 MB per call. */
  files?: EvidenceFile[];
  /** Extension: evidence_type, default "OTHER" (what PayPal's sandbox guide uses). */
  evidenceType?: string;
  /** Extension: refund ids for PROOF_OF_REFUND evidence. */
  refundIds?: string[];
};

// ---------------------------------------------------------------------------------------------
// Payouts v1 (batch payouts to PayPal / Venmo recipients)
// ---------------------------------------------------------------------------------------------

export type PayoutRecipientType = "EMAIL" | "PHONE" | "PAYPAL_ID";

export type PayoutItemInput = {
  /** Email, phone number or PayPal payer id, matching recipientType. */
  receiver: string;
  amount: Money;
  /** Default: the batch's recipientType, else EMAIL. */
  recipientType?: PayoutRecipientType;
  /** Shown to the recipient (max 4000 characters). */
  note?: string;
  /** Your id for this item (max 63 characters), echoed back in item details. */
  senderItemId?: string;
  /** Default PAYPAL. */
  recipientWallet?: "PAYPAL" | "VENMO";
};

export type CreatePayoutInput = {
  /**
   * Your id for the batch (max 256 characters). PayPal pays a sender_batch_id at most once in 30 days:
   * resending it (after a timeout, a crash, a double click) returns the original batch instead of paying again.
   */
  senderBatchId: string;
  items: PayoutItemInput[];
  emailSubject?: string;
  emailMessage?: string;
  recipientType?: PayoutRecipientType;
  /** Extension: PayPal-Request-Id; default derived from senderBatchId. */
  requestId?: string;
};

/** PayPal's batch status: PENDING and PROCESSING move on to SUCCESS (or DENIED / CANCELED). */
export type PayoutBatchStatus = "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";

/** PayPal's item status. UNCLAIMED: the receiver has no PayPal account yet (they have 30 days to claim). */
export type PayoutItemStatus = "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED";

export type PayoutItem = {
  itemId: string;
  batchId: string;
  /** `transaction_status`; PENDING until PayPal processes the item. */
  status: PayoutItemStatus | (string & {});
  receiver: string;
  amount: Money;
  recipientType?: string;
  senderItemId?: string;
  note?: string;
  transactionId?: string;
  fee?: Money;
  processedAt?: string;
  /** Why an item is UNCLAIMED, FAILED, ... (e.g. RECEIVER_UNREGISTERED). */
  error?: { name: string; message?: string };
};

export type PayoutBatch = {
  batchId: string;
  status: PayoutBatchStatus | (string & {});
  senderBatchId?: string;
  createdAt?: string;
  completedAt?: string;
  /** Total requested (batch details only). */
  amount?: Money;
  /** Estimated or final fees (batch details only). */
  fees?: Money;
  /** Item details; empty in the create response (PayPal processes the batch asynchronously). */
  items: PayoutItem[];
  /** Extension: true when PayPal answered with the batch first created for this sender_batch_id (nothing was paid twice). */
  replayed?: boolean;
  raw?: unknown;
};

// ---------------------------------------------------------------------------------------------
// Webhooks and reporting
// ---------------------------------------------------------------------------------------------

export type VerifyWebhookInput = {
  /** The incoming request headers (any casing). */
  headers: Record<string, string>;
  /** The raw request body, byte for byte as received. Do not re-serialise parsed JSON. */
  body: string;
  /** The webhook id from the PayPal app settings (or MockPayPal.webhookId in mock mode). */
  webhookId: string;
};

export type SearchTransactionsInput = {
  start: Date;
  end: Date;
  /** Extension: filter by a PayPal transaction id. */
  transactionId?: string;
};

export type TransactionRecord = {
  id: string;
  amount: Money;
  /** COMPLETED (S), PENDING (P), REVERSED (V) or DENIED (D); unknown codes pass through. */
  status: string;
  customId?: string;
  /** ISO 8601 (UTC). */
  time: string;
  // Extensions:
  invoiceId?: string;
  /** PayPal transaction event code, e.g. T0006 (checkout payment), T0003 (pre-approved/vault), T1107 (refund). */
  eventCode?: string;
  statusCode?: string;
  fee?: Money;
};

/** A PayPal webhook event body (Webhooks v1 "event" schema). */
export type PayPalWebhookEvent<R = Record<string, unknown>> = {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version?: string;
  event_type: string;
  summary: string;
  resource: R;
  links: { href: string; rel: string; method: string }[];
};

/** A webhook as it would arrive over HTTP: headers plus the exact body string. */
export type WebhookDelivery = {
  event: PayPalWebhookEvent;
  headers: Record<string, string>;
  body: string;
  webhookId: string;
};

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

export interface PayPalClient {
  createVaultSetupToken(i: CreateVaultSetupTokenInput): Promise<VaultSetupToken>;
  createPaymentToken(setupTokenId: string, opts?: CreatePaymentTokenOptions): Promise<PaymentToken>;
  createOrder(i: CreateOrderInput): Promise<CreateOrderResult>;
  getOrder(id: string): Promise<OrderDetails>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureOrderResult>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizeOrderResult>;
  captureAuthorization(
    authorizationId: string,
    requestId: string,
    opts?: CaptureAuthorizationOptions,
  ): Promise<CaptureAuthorizationResult>;
  voidAuthorization(authorizationId: string, opts?: VoidAuthorizationOptions): Promise<{ status: string }>;
  refundCapture(captureId: string, amount?: Money, requestId?: string, opts?: RefundOptions): Promise<RefundResult>;
  listDisputes(filter?: ListDisputesFilter): Promise<DisputeSummary[]>;
  getDispute(id: string): Promise<DisputeDetails>;
  /** Sandbox simulation if available. */
  createSandboxDispute?(i: CreateSandboxDisputeInput): Promise<{ id: string }>;
  provideEvidence(disputeId: string, i: ProvideEvidenceInput): Promise<{ status: string }>;
  verifyWebhookSignature(i: VerifyWebhookInput): Promise<boolean>;
  searchTransactions(i: SearchTransactionsInput): Promise<TransactionRecord[]>;
  /** Extension: Payouts v1 batch payout (POST /v1/payments/payouts). Idempotent on senderBatchId. */
  createPayout?(i: CreatePayoutInput): Promise<PayoutBatch>;
  /** Extension: batch status and item details (GET /v1/payments/payouts/{id}). */
  getPayoutBatch?(batchId: string, opts?: { page?: number; pageSize?: number }): Promise<PayoutBatch>;
  /** Extension: one item's status (GET /v1/payments/payouts-item/{id}). */
  getPayoutItem?(itemId: string): Promise<PayoutItem>;
}
