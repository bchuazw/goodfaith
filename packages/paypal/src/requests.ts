/**
 * Input validation and PayPal request-body builders, shared by the real client and the mock so
 * both validate identically and the mock stores exactly what PayPal would receive.
 * Shapes follow the official OpenAPI specs (github.com/paypal/paypal-rest-api-specifications)
 * and the developer.paypal.com guides cited in docs/PAYPAL_NOTES.md.
 */
import { z } from "zod";
import { validationError } from "./errors.js";
import { fromMinor, normalizeMoney, positiveMinor, toMinor, toPayPalMoney } from "./money.js";
import type {
  CaptureAuthorizationOptions,
  CreateOrderInput,
  CreatePayoutInput,
  CreateSandboxDisputeInput,
  CreateVaultSetupTokenInput,
  Money,
  ProvideEvidenceInput,
  RefundOptions,
  ShippingAddress,
} from "./types.js";

export type PayPalMoney = { currency_code: string; value: string };

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    issue: "INVALID_PARAMETER",
    field: issue.path.length ? `/${issue.path.join("/")}` : "/",
    description: issue.message,
  }));
  const first = details[0];
  throw validationError(`${label} is invalid${first ? `: ${first.field} ${first.description}` : ""}`, details);
}

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

const urlSchema = z.string().refine(isHttpUrl, "must be an absolute http(s) URL");
const moneySchema = z.object({ currency: z.string(), value: z.string() });
const requestIdSchema = z
  .string()
  .min(1)
  .max(108, "PayPal-Request-Id is limited to 108 characters")
  .regex(/^[\x21-\x7e]+$/, "PayPal-Request-Id must be printable ASCII without spaces");
const shippingSchema = z.object({
  name: z.string().min(1).max(300),
  line1: z.string().min(1).max(300),
  line2: z.string().max(300).optional(),
  city: z.string().min(1).max(120),
  state: z.string().max(300).optional(),
  postalCode: z.string().min(1).max(60),
  country: z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code"),
});

export function assertRequestId(requestId: unknown, label = "requestId"): string {
  return parseInput(requestIdSchema, requestId, label);
}

/** PayPal resource ids in paths: letters, digits, dash, underscore. Blocks path injection. */
export function assertResourceId(id: unknown, label: string): string {
  return parseInput(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, "must be a PayPal id"), id, label);
}

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

function shippingBlock(s: ShippingAddress) {
  return {
    type: "SHIPPING",
    name: { full_name: s.name },
    address: {
      address_line_1: s.line1,
      ...(s.line2 ? { address_line_2: s.line2 } : {}),
      admin_area_2: s.city,
      ...(s.state ? { admin_area_1: s.state } : {}),
      postal_code: s.postalCode,
      country_code: s.country,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Vault v3
// ---------------------------------------------------------------------------------------------

const setupTokenSchema = z.object({
  returnUrl: urlSchema,
  cancelUrl: urlSchema,
  customerId: z.string().regex(/^[0-9a-zA-Z_-]{1,22}$/, "must be a PayPal customer id").optional(),
  description: z.string().min(1).optional(),
  merchantCustomerId: z
    .string()
    .regex(/^[0-9a-zA-Z\-_.^*$@#]{1,64}$/, "allowed: letters, digits and -_.^*$@#, max 64")
    .optional(),
  brandName: z.string().min(1).max(127).optional(),
  requestId: requestIdSchema.optional(),
});

export const DEFAULT_VAULT_DESCRIPTION = "Pay for purchases your AI agent makes within the permission slips you sign";

export function buildSetupTokenRequest(input: CreateVaultSetupTokenInput, defaults: { brandName?: string }) {
  const i = parseInput(setupTokenSchema, input, "createVaultSetupToken input");
  const customer =
    i.customerId || i.merchantCustomerId
      ? {
          ...(i.customerId ? { id: i.customerId } : {}),
          ...(i.merchantCustomerId ? { merchant_customer_id: i.merchantCustomerId } : {}),
        }
      : undefined;
  const brandName = i.brandName ?? defaults.brandName;
  return {
    ...(customer ? { customer } : {}),
    payment_source: {
      paypal: {
        description: truncate(i.description ?? DEFAULT_VAULT_DESCRIPTION, 128),
        usage_pattern: "IMMEDIATE",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          ...(brandName ? { brand_name: brandName } : {}),
          return_url: i.returnUrl,
          cancel_url: i.cancelUrl,
        },
      },
    },
  };
}

export type SetupTokenRequestBody = ReturnType<typeof buildSetupTokenRequest>;

export function buildPaymentTokenRequest(setupTokenId: string) {
  return { payment_source: { token: { id: assertResourceId(setupTokenId, "setupTokenId"), type: "SETUP_TOKEN" } } };
}

// ---------------------------------------------------------------------------------------------
// Orders v2
// ---------------------------------------------------------------------------------------------

const itemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().max(127).optional(),
  unitAmount: moneySchema,
  quantity: z.number().int().min(1).max(9_999_999_999),
  category: z.enum(["PHYSICAL_GOODS", "DIGITAL_GOODS"]).optional(),
});

const createOrderSchema = z.object({
  intent: z.enum(["CAPTURE", "AUTHORIZE"]),
  amount: moneySchema,
  description: z.string().min(1).optional(),
  customId: z.string().min(1).max(255).optional(),
  invoiceId: z.string().min(1).max(127).optional(),
  vaultId: z.string().regex(/^[0-9a-zA-Z_-]{1,255}$/, "must be a PayPal payment token id").optional(),
  items: z.array(itemSchema).min(1).max(250).optional(),
  returnUrl: urlSchema.optional(),
  cancelUrl: urlSchema.optional(),
  requestId: requestIdSchema,
  breakdown: z
    .object({
      shipping: moneySchema.optional(),
      tax: moneySchema.optional(),
      handling: moneySchema.optional(),
      discount: moneySchema.optional(),
    })
    .optional(),
  shipTo: shippingSchema.optional(),
  brandName: z.string().min(1).max(127).optional(),
  softDescriptor: z.string().min(1).max(127).optional(),
});

export type OrderMode = "vault" | "redirect" | "plain";

export type BuiltOrder = {
  body: OrderRequestBody;
  requestId: string;
  mode: OrderMode;
  currency: string;
  amountMinor: number;
};

export type OrderRequestBody = {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<{
    amount: PayPalMoney & { breakdown?: Record<string, PayPalMoney> };
    description?: string;
    custom_id?: string;
    invoice_id?: string;
    soft_descriptor?: string;
    items?: Array<{ name: string; sku?: string; unit_amount: PayPalMoney; quantity: string; category?: string }>;
    shipping?: ReturnType<typeof shippingBlock>;
  }>;
  payment_source?: { paypal: Record<string, unknown> };
};

/**
 * Builds a POST /v2/checkout/orders body.
 * - vaultId => payment_source.paypal.vault_id: merchant-initiated, completes with no buyer present.
 * - returnUrl + cancelUrl => payment_source.paypal.experience_context: PAYER_ACTION_REQUIRED and a
 *   `payer-action` link for the buyer.
 * - neither => plain order (status CREATED, `approve` link), e.g. for the JS SDK.
 */
export function buildOrderRequest(
  input: CreateOrderInput,
  defaults: { brandName?: string; vaultStoredCredential?: boolean },
): BuiltOrder {
  const i = parseInput(createOrderSchema, input, "createOrder input");
  if ((i.returnUrl === undefined) !== (i.cancelUrl === undefined)) {
    throw validationError("createOrder input: returnUrl and cancelUrl must be given together");
  }
  const currency = i.amount.currency;
  const amountMinor = positiveMinor(i.amount, "amount");
  const sameCurrency = (m: Money, label: string): number => {
    const minor = toMinor(m, label);
    if (m.currency !== currency) throw validationError(`${label} currency ${m.currency} differs from amount currency ${currency}`);
    if (minor < 0) throw validationError(`${label} must not be negative`);
    return minor;
  };

  let items: NonNullable<OrderRequestBody["purchase_units"][number]["items"]> | undefined;
  let itemTotal: number | undefined;
  if (i.items) {
    itemTotal = 0;
    items = i.items.map((it, n) => {
      const unit = sameCurrency(it.unitAmount, `items[${n}].unitAmount`);
      itemTotal = (itemTotal ?? 0) + unit * it.quantity;
      return {
        name: truncate(it.name, 127),
        ...(it.sku ? { sku: it.sku } : {}),
        unit_amount: toPayPalMoney(fromMinor(unit, currency)),
        quantity: String(it.quantity),
        ...(it.category ? { category: it.category } : {}),
      };
    });
  }

  let breakdown: Record<string, PayPalMoney> | undefined;
  if (i.breakdown) {
    const b = i.breakdown;
    const shipping = b.shipping ? sameCurrency(b.shipping, "breakdown.shipping") : 0;
    const tax = b.tax ? sameCurrency(b.tax, "breakdown.tax") : 0;
    const handling = b.handling ? sameCurrency(b.handling, "breakdown.handling") : 0;
    const discount = b.discount ? sameCurrency(b.discount, "breakdown.discount") : 0;
    const itemsMinor = itemTotal ?? amountMinor - shipping - tax - handling + discount;
    if (itemsMinor < 0) throw validationError("breakdown exceeds the order amount");
    if (itemsMinor + shipping + tax + handling - discount !== amountMinor) {
      throw validationError(
        "amount must equal item total + shipping + tax + handling - discount (PayPal: AMOUNT_MISMATCH)",
        [{ issue: "AMOUNT_MISMATCH", field: "/amount/value" }],
      );
    }
    breakdown = {
      item_total: toPayPalMoney(fromMinor(itemsMinor, currency)),
      ...(b.shipping ? { shipping: toPayPalMoney(fromMinor(shipping, currency)) } : {}),
      ...(b.tax ? { tax_total: toPayPalMoney(fromMinor(tax, currency)) } : {}),
      ...(b.handling ? { handling: toPayPalMoney(fromMinor(handling, currency)) } : {}),
      ...(b.discount ? { discount: toPayPalMoney(fromMinor(discount, currency)) } : {}),
    };
  } else if (itemTotal !== undefined) {
    // PayPal requires amount.breakdown.item_total whenever items are sent, and the parts must add up.
    const remainder = amountMinor - itemTotal;
    breakdown = {
      item_total: toPayPalMoney(fromMinor(itemTotal, currency)),
      ...(remainder > 0 ? { handling: toPayPalMoney(fromMinor(remainder, currency)) } : {}),
      ...(remainder < 0 ? { discount: toPayPalMoney(fromMinor(-remainder, currency)) } : {}),
    };
  }

  const purchaseUnit: OrderRequestBody["purchase_units"][number] = {
    amount: { ...toPayPalMoney(fromMinor(amountMinor, currency)), ...(breakdown ? { breakdown } : {}) },
    ...(i.description ? { description: truncate(i.description, 127) } : {}),
    ...(i.customId ? { custom_id: i.customId } : {}),
    ...(i.invoiceId ? { invoice_id: i.invoiceId } : {}),
    ...(i.softDescriptor ? { soft_descriptor: truncate(i.softDescriptor, 22) } : {}),
    ...(items ? { items } : {}),
    ...(i.shipTo ? { shipping: shippingBlock(i.shipTo) } : {}),
  };

  const brandName = i.brandName ?? defaults.brandName;
  const allDigital = i.items?.every((it) => it.category === "DIGITAL_GOODS") ?? false;
  const experienceContext =
    i.returnUrl && i.cancelUrl
      ? {
          ...(brandName ? { brand_name: brandName } : {}),
          shipping_preference: i.shipTo ? "SET_PROVIDED_ADDRESS" : allDigital ? "NO_SHIPPING" : "GET_FROM_FILE",
          landing_page: "LOGIN",
          user_action: "PAY_NOW",
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          return_url: i.returnUrl,
          cancel_url: i.cancelUrl,
        }
      : undefined;

  let mode: OrderMode = "plain";
  let paymentSource: OrderRequestBody["payment_source"];
  if (i.vaultId) {
    mode = "vault";
    paymentSource = {
      paypal: {
        vault_id: i.vaultId,
        ...(defaults.vaultStoredCredential
          ? { stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" } }
          : {}),
        ...(experienceContext ? { experience_context: experienceContext } : {}),
      },
    };
  } else if (experienceContext) {
    mode = "redirect";
    paymentSource = { paypal: { experience_context: experienceContext } };
  }

  return {
    body: { intent: i.intent, purchase_units: [purchaseUnit], ...(paymentSource ? { payment_source: paymentSource } : {}) },
    requestId: i.requestId,
    mode,
    currency,
    amountMinor,
  };
}

// ---------------------------------------------------------------------------------------------
// Payments v2
// ---------------------------------------------------------------------------------------------

export function buildCaptureAuthorizationRequest(opts: CaptureAuthorizationOptions | undefined) {
  if (!opts) return {};
  const o = parseInput(
    z.object({
      amount: moneySchema.optional(),
      finalCapture: z.boolean().optional(),
      invoiceId: z.string().min(1).max(127).optional(),
      noteToPayer: z.string().min(1).max(255).optional(),
    }),
    opts,
    "captureAuthorization options",
  );
  if (o.amount) positiveMinor(o.amount, "amount");
  return {
    ...(o.amount ? { amount: toPayPalMoney(normalizeMoney(o.amount)) } : {}),
    ...(o.finalCapture !== undefined ? { final_capture: o.finalCapture } : {}),
    ...(o.invoiceId ? { invoice_id: o.invoiceId } : {}),
    ...(o.noteToPayer ? { note_to_payer: o.noteToPayer } : {}),
  };
}

export function buildRefundRequest(amount: Money | undefined, opts: RefundOptions | undefined) {
  if (amount) positiveMinor(amount, "refund amount");
  const o = parseInput(
    z.object({
      note: z.string().min(1).max(255).optional(),
      customId: z.string().min(1).max(127).optional(),
      invoiceId: z.string().min(1).max(127).optional(),
    }),
    opts ?? {},
    "refund options",
  );
  return {
    ...(amount ? { amount: toPayPalMoney(normalizeMoney(amount)) } : {}),
    ...(o.note ? { note_to_payer: o.note } : {}),
    ...(o.customId ? { custom_id: o.customId } : {}),
    ...(o.invoiceId ? { invoice_id: o.invoiceId } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Disputes v1
// ---------------------------------------------------------------------------------------------

export const DISPUTE_REASONS = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
] as const;

/** Supported evidence files: PayPal "Supported file types and sizes". */
export const EVIDENCE_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxNotes: 2000,
  types: {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
  } as Record<string, string>,
} as const;

/**
 * PayPal's document name pattern is ^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$, so "mandate chain (v2).pdf"
 * must become "mandate chain -v2-.pdf". The extension follows the content type.
 */
export function sanitizeEvidenceFilename(name: string, contentType: string): string {
  const ext = EVIDENCE_LIMITS.types[contentType.toLowerCase()] ?? "pdf";
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[^A-Za-z0-9\-_, ]/g, "-").replace(/-+/g, "-").trim();
  return `${stem.length ? stem.slice(0, 120) : "evidence"}.${ext}`;
}

const evidenceSchema = z.object({
  notes: z.string().min(1).max(EVIDENCE_LIMITS.maxNotes, `notes are limited to ${EVIDENCE_LIMITS.maxNotes} characters`),
  evidenceType: z.string().regex(/^[0-9A-Z_]{1,255}$/, "must be an evidence type such as OTHER").optional(),
  refundIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        contentType: z.string().min(1),
        data: z.instanceof(Uint8Array),
      }),
    )
    .optional(),
});

export type BuiltEvidence = {
  input: { evidences: Array<{ evidence_type: string; notes: string; evidence_info?: { refund_ids: string[] } }> };
  files: Array<{ filename: string; contentType: string; data: Uint8Array; size: number }>;
};

export function buildEvidence(i: ProvideEvidenceInput): BuiltEvidence {
  const v = parseInput(evidenceSchema, i, "provideEvidence input");
  const files = (v.files ?? []).map((f, n) => {
    const contentType = f.contentType.toLowerCase();
    if (!EVIDENCE_LIMITS.types[contentType]) {
      throw validationError(`files[${n}] type ${f.contentType} is not accepted by PayPal (PDF, PNG, JPG, GIF only)`, [
        { issue: "INVALID_EVIDENCE_FILE", field: `/files/${n}/contentType` },
      ]);
    }
    if (f.data.byteLength >= EVIDENCE_LIMITS.maxFileBytes) {
      throw validationError(`files[${n}] must be smaller than 10 MB`, [{ issue: "INVALID_EVIDENCE_FILE", field: `/files/${n}` }]);
    }
    return { filename: sanitizeEvidenceFilename(f.name, contentType), contentType, data: f.data, size: f.data.byteLength };
  });
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > EVIDENCE_LIMITS.maxTotalBytes) {
    throw validationError("evidence files exceed 50 MB in total", [{ issue: "INVALID_EVIDENCE_FILE", field: "/files" }]);
  }
  const evidenceType = v.evidenceType ?? (v.refundIds ? "PROOF_OF_REFUND" : "OTHER");
  return {
    input: {
      evidences: [
        {
          evidence_type: evidenceType,
          notes: v.notes,
          ...(v.refundIds ? { evidence_info: { refund_ids: v.refundIds } } : {}),
        },
      ],
    },
    files,
  };
}

const sandboxDisputeSchema = z.object({
  captureId: z.string().regex(/^[A-Za-z0-9]{1,64}$/, "must be a capture id"),
  reason: z.enum(DISPUTE_REASONS),
  amount: moneySchema,
  strategy: z.enum(["chargeback", "buyer-assertion"]).optional(),
  buyerEmail: z.email().optional(),
  buyerTransactionId: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(),
});

export function parseSandboxDisputeInput(i: CreateSandboxDisputeInput) {
  const v = parseInput(sandboxDisputeSchema, i, "createSandboxDispute input");
  positiveMinor(v.amount, "amount");
  return { ...v, amount: normalizeMoney(v.amount) };
}

/** Body for the sandbox-only POST /v1/customer/disputes (sent as the multipart "input" part). */
export function buildBuyerDisputeInput(v: ReturnType<typeof parseSandboxDisputeInput>) {
  const merchandise = v.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" || v.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
  return {
    disputed_transactions: [
      v.buyerTransactionId ? { buyer_transaction_id: v.buyerTransactionId } : { seller_transaction_id: v.captureId },
    ],
    reason: v.reason,
    dispute_amount: toPayPalMoney(v.amount),
    ...(merchandise
      ? {
          extensions: {
            merchant_contacted: true,
            merchant_contacted_outcome: "NO_RESPONSE",
            merchandize_dispute_properties: { issue_type: "PRODUCT" },
          },
        }
      : {}),
  };
}

/** Body for the sandbox-only POST /v2/customer-support/process-chargeback (PayPal "Test and go live"). */
export function buildChargebackRequest(input: {
  merchantId: string;
  captureId: string;
  captureAmount: Money;
  disputeAmount: Money;
  now: Date;
}) {
  const iso = (d: Date) => d.toISOString();
  const responseDate = new Date(input.now.getTime() + 10 * 24 * 3600 * 1000);
  // The documented sample uses numeric processor references (16-digit card txn id, 23-digit ARN).
  const digits = `${input.captureId.replace(/\D/g, "")}${input.now.getTime()}`;
  const numeric = (n: number) => digits.padEnd(n, "0").slice(0, n);
  return {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: input.merchantId,
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: input.captureId, amount: toPayPalMoney(input.captureAmount) },
    instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: numeric(16), external: false },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: iso(responseDate),
      status: "2",
      amount: toPayPalMoney(input.disputeAmount),
      receive_date: iso(input.now),
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: iso(input.now),
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: { reference_number: numeric(23), reason_code: "1330", notes: "Good Faith sandbox simulation" },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Payouts v1
// ---------------------------------------------------------------------------------------------

/** PayPal accepts at most 15,000 items per batch payout. */
export const PAYOUT_LIMITS = { maxItems: 15_000, senderBatchId: 256, senderItemId: 63, receiver: 127, note: 4000, emailSubject: 255, emailMessage: 1000 } as const;

const recipientTypeSchema = z.enum(["EMAIL", "PHONE", "PAYPAL_ID"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const payoutSchema = z.object({
  senderBatchId: z.string().trim().min(1, "is required (it makes the payout idempotent)").max(PAYOUT_LIMITS.senderBatchId),
  emailSubject: z.string().min(1).max(PAYOUT_LIMITS.emailSubject).optional(),
  emailMessage: z.string().min(1).max(PAYOUT_LIMITS.emailMessage).optional(),
  recipientType: recipientTypeSchema.optional(),
  requestId: requestIdSchema.optional(),
  items: z
    .array(
      z.object({
        receiver: z.string().trim().min(1).max(PAYOUT_LIMITS.receiver),
        amount: moneySchema,
        recipientType: recipientTypeSchema.optional(),
        note: z.string().min(1).max(PAYOUT_LIMITS.note).optional(),
        senderItemId: z.string().min(1).max(PAYOUT_LIMITS.senderItemId).optional(),
        recipientWallet: z.enum(["PAYPAL", "VENMO"]).optional(),
      }),
    )
    .min(1, "needs at least one item")
    .max(PAYOUT_LIMITS.maxItems, `allows at most ${PAYOUT_LIMITS.maxItems} items`),
});

export type PayoutRequestBody = {
  sender_batch_header: { sender_batch_id: string; recipient_type?: string; email_subject?: string; email_message?: string };
  items: Array<{
    recipient_type: string;
    amount: { value: string; currency: string };
    receiver: string;
    note?: string;
    sender_item_id?: string;
    recipient_wallet?: string;
  }>;
};

/** POST /v1/payments/payouts body. Note the Payouts money shape: { value, currency } (not currency_code). */
export function buildPayoutRequest(input: CreatePayoutInput): PayoutRequestBody {
  const i = parseInput(payoutSchema, input, "payout");
  const items = i.items.map((it, n) => {
    const recipientType = it.recipientType ?? i.recipientType ?? "EMAIL";
    if (recipientType === "EMAIL" && !EMAIL_RE.test(it.receiver)) {
      throw validationError(`payout is invalid: /items/${n}/receiver must be an email address for recipient type EMAIL`, [
        { issue: "INVALID_PARAMETER", field: `/items/${n}/receiver`, description: "must be an email address" },
      ]);
    }
    positiveMinor(it.amount, `items[${n}].amount`);
    const amount = normalizeMoney(it.amount, `items[${n}].amount`);
    return {
      recipient_type: recipientType,
      amount: { value: amount.value, currency: amount.currency },
      receiver: it.receiver,
      ...(it.note ? { note: it.note } : {}),
      ...(it.senderItemId ? { sender_item_id: it.senderItemId } : {}),
      ...(it.recipientWallet ? { recipient_wallet: it.recipientWallet } : {}),
    };
  });
  return {
    sender_batch_header: {
      sender_batch_id: i.senderBatchId,
      ...(i.recipientType ? { recipient_type: i.recipientType } : {}),
      ...(i.emailSubject ? { email_subject: i.emailSubject } : {}),
      ...(i.emailMessage ? { email_message: i.emailMessage } : {}),
    },
    items,
  };
}

/**
 * PayPal-Request-Id for a payout, derived from its sender_batch_id so a retried request is a replay. Ids that
 * are not plain printable ASCII (or are too long for the header) are hashed.
 */
export async function payoutRequestId(senderBatchId: string): Promise<string> {
  if (/^[!-~]{1,100}$/.test(senderBatchId)) return `payout-${senderBatchId}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(senderBatchId)));
  return `payout-${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64)}`;
}
