/**
 * PayPal-shaped response fixtures, copied from PayPal's documented examples. Sources:
 * - OAuth:   https://developer.paypal.com/api/rest/authentication/ (sample response)
 * - Vault:   https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal/ (steps 2-4)
 * - Orders:  openapi/checkout_orders_v2.json examples in github.com/paypal/paypal-rest-api-specifications
 * - Payments: openapi/payments_payment_v2.json examples (same repo)
 * - Disputes: https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/ and
 *             https://developer.paypal.com/disputes/test-go-live/
 * - Webhooks: openapi/notifications_webhooks_v1.json and https://developer.paypal.com/api/rest/webhooks/rest/
 * - Transaction Search: openapi/reporting_transactions_v1.json (field names; the spec ships no example,
 *   so the row below is assembled from the schema, including the documented +0000 date format)
 */

export const oauthToken = {
  scope:
    "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/disputes/read-buyer https://uri.paypal.com/services/payments/realtimepayment https://uri.paypal.com/services/disputes/update-seller https://uri.paypal.com/services/payments/payment/authcapture openid https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/payments/refund https://api-m.paypal.com/v1/vault/credit-card https://api-m.paypal.com/v1/payments/.* https://uri.paypal.com/payments/payouts https://api-m.paypal.com/v1/vault/credit-card/.* https://uri.paypal.com/services/subscriptions https://uri.paypal.com/services/applications/webhooks",
  access_token: "A21AAFEpH4PsADK7qSS7pSRsgzfENtu-Q1ysgEDVDESseMHBYXVJYE8ovjj68elIDy8nF26AwPhfXTIeWAZHSLIsQkSYz9ifg",
  token_type: "Bearer",
  app_id: "APP-80W284485P519543T",
  expires_in: 31668,
  nonce: "2020-04-03T15:35:36ZaYZlGvEkV4yVSz8g6bAKFoGSEzuy3CQcz3ljhibkOHg",
};

export const setupTokenCreated = {
  id: "4G4976650J0948357",
  customer: { id: "customer_4029352051" },
  status: "PAYER_ACTION_REQUIRED",
  payment_source: {
    paypal: {
      description: "Description for PayPal to be shown to PayPal payer",
      usage_pattern: "IMMEDIATE",
      shipping: {
        name: { full_name: "Firstname Lastname" },
        address: {
          address_line_1: "2211 N First Street",
          address_line_2: "Building 17",
          admin_area_2: "San Jose",
          admin_area_1: "CA",
          postal_code: "95131",
          country_code: "US",
        },
      },
      permit_multiple_payment_tokens: false,
      usage_type: "MERCHANT",
      customer_type: "CONSUMER",
    },
  },
  links: [
    { href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/4G4976650J0948357", rel: "self", method: "GET", encType: "application/json" },
    { href: "https://sandbox.paypal.com/agreements/approve?approval_session_id=4G4976650J0948357", rel: "approve", method: "GET", encType: "application/json" },
  ],
};

export const paymentTokenCreated = {
  id: "jwgvx42",
  customer: { id: "customer_4029352051" },
  payment_source: {
    paypal: {
      description: "Description for PayPal to be shown to PayPal payer",
      usage_pattern: "IMMEDIATE",
      permit_multiple_payment_tokens: false,
      usage_type: "MERCHANT",
      customer_type: "CONSUMER",
      email_address: "email@example.com",
      payer_id: "AJM9JTWQJCFTA",
    },
  },
  links: [
    { rel: "self", href: "https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/jwgvx42", method: "GET", encType: "application/json" },
    { rel: "delete", href: "https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/jwgvx42", method: "DELETE", encType: "application/json" },
  ],
};

/** POST /v2/checkout/orders with payment_source.paypal.vault_id (save-without-purchase guide, step 4). */
export const vaultOrderCompleted = {
  id: "4TH21426N05692944",
  status: "COMPLETED",
  payment_source: {
    paypal: {
      email_address: "email@example.com",
      account_id: "AJM9JTWQJCFTA",
      name: { given_name: "Firstname", surname: "Lastname" },
      address: { country_code: "US" },
    },
  },
  purchase_units: [
    {
      reference_id: "default",
      payments: {
        captures: [
          {
            id: "3B017991HX624902V",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "100.00" },
            final_capture: true,
            seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
            seller_receivable_breakdown: {
              gross_amount: { currency_code: "USD", value: "100.00" },
              paypal_fee: { currency_code: "USD", value: "3.98" },
              net_amount: { currency_code: "USD", value: "96.02" },
            },
            links: [
              { href: "https://api-m.sandbox.paypal.com/v2/payments/captures/3B017991HX624902V", rel: "self", method: "GET" },
              { href: "https://api-m.sandbox.paypal.com/v2/payments/captures/3B017991HX624902V/refund", rel: "refund", method: "POST" },
              { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/4TH21426N05692944", rel: "up", method: "GET" },
            ],
            create_time: "2022-08-08T23:13:35Z",
            update_time: "2022-08-08T23:13:35Z",
          },
        ],
      },
    },
  ],
  payer: {
    name: { given_name: "Firstname", surname: "Lastname" },
    email_address: "email@example.com",
    payer_id: "AJM9JTWQJCFTA",
    address: { country_code: "US" },
  },
  links: [{ href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/4TH21426N05692944", rel: "self", method: "GET" }],
};

/** Spec example orders_create_authorize_single_step_paypal_with_vault_id_and_stored_credentials_usage_pattern. */
export const vaultOrderAuthorized = {
  id: "8K832279M55989614",
  payment_source: {
    paypal: {
      email_address: "buyer@paypal.com",
      account_id: "XQHSN372NGSP2",
      account_status: "UNVERIFIED",
      name: { given_name: "Tom", surname: "Business" },
      phone_number: { national_number: "8127081430" },
      address: { country_code: "US" },
    },
  },
  purchase_units: [
    {
      reference_id: "default",
      amount: { currency_code: "USD", value: "100.00" },
      payee: { email_address: "seller@paypal.com", merchant_id: "Q7C9N6S4YRQXG" },
      payments: {
        authorizations: [
          {
            status: "CREATED",
            id: "7X550106NA4440028",
            amount: { currency_code: "USD", value: "100.00" },
            seller_protection: { status: "ELIGIBLE", dispute_categories: ["UNAUTHORIZED_TRANSACTION"] },
            expiration_time: "2024-06-05T18:46:54Z",
            links: [
              { href: "https://api-m.paypal.com/v2/payments/authorizations/7X550106NA4440028", rel: "self", method: "GET" },
              { href: "https://api-m.paypal.com/v2/payments/authorizations/7X550106NA4440028/capture", rel: "capture", method: "POST" },
              { href: "https://api-m.paypal.com/v2/payments/authorizations/7X550106NA4440028/void", rel: "void", method: "POST" },
              { href: "https://api-m.paypal.com/v2/checkout/orders/8K832279M55989614", rel: "up", method: "GET" },
            ],
            create_time: "2024-05-07T18:46:54Z",
            update_time: "2024-05-07T18:46:54Z",
          },
        ],
      },
    },
  ],
  create_time: "2024-05-07T18:46:15Z",
  update_time: "2024-05-07T18:46:54Z",
  links: [{ href: "https://api-m.paypal.com/v2/checkout/orders/8K832279M55989614", rel: "self", method: "GET" }],
};

/** Spec example 00_orders_create (experience_context request): note there is no `status` field. */
export const orderPayerAction = {
  id: "5O190127TN364715T",
  payment_source: { paypal: {} },
  links: [
    { href: "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" },
    { href: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "payer-action", method: "GET" },
  ],
};

/** Spec example 00_orders_capture. */
export const orderCaptured = {
  id: "5O190127TN364715T",
  status: "COMPLETED",
  payment_source: { paypal: { name: { given_name: "John", surname: "Doe" }, email_address: "customer@example.com", account_id: "QYR5Z8XDVJNXQ" } },
  purchase_units: [
    {
      reference_id: "d9f80740-38f0-11e8-b467-0ed5f89f718b",
      payments: {
        captures: [
          {
            id: "3C679366HH908993F",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "100.00" },
            seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
            final_capture: true,
            create_time: "2018-04-01T21:20:49Z",
            update_time: "2018-04-01T21:20:49Z",
          },
        ],
      },
    },
  ],
  payer: { name: { given_name: "John", surname: "Doe" }, email_address: "customer@example.com", payer_id: "QYR5Z8XDVJNXQ" },
  links: [{ href: "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" }],
};

/** Spec example 00_orders_authorize. */
export const orderAuthorized = {
  id: "5O190127TN364715T",
  status: "COMPLETED",
  purchase_units: [
    {
      reference_id: "d9f80740-38f0-11e8-b467-0ed5f89f718b",
      payments: {
        authorizations: [
          {
            id: "0AW2184448108334S",
            status: "CREATED",
            amount: { currency_code: "USD", value: "100.00" },
            expiration_time: "2021-10-08T23:37:39Z",
          },
        ],
      },
    },
  ],
  links: [{ href: "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" }],
};

/** Spec example authorizations_capture_with_prefer_header. */
export const authorizationCaptured = {
  id: "2GG279541U471931P",
  status: "COMPLETED",
  status_details: {},
  amount: { value: "10.99", currency_code: "USD" },
  final_capture: true,
  invoice_id: "INV-123",
  create_time: "2017-09-11T23:24:01Z",
  update_time: "2017-09-11T23:24:01Z",
  links: [
    { rel: "self", method: "GET", href: "https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P" },
    { rel: "refund", method: "POST", href: "https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P/refund" },
    { rel: "up", method: "GET", href: "https://api-m.paypal.com/v2/payments/authorizations/0VF52814937998046" },
  ],
};

/** Spec example authorizations_void_200_idempotent_response. */
export const authorizationVoided = {
  id: "5C908745JK343851U",
  status: "VOIDED",
  amount: { currency_code: "USD", value: "100.00" },
  expiration_time: "2024-11-08T09:06:03-08:00",
  links: [{ href: "https://api.paypal.com/v2/payments/authorizations/5C908745JK343851U", rel: "self", method: "GET" }],
};

/** Spec example captures_refund_with_prefer_header. */
export const refundCompleted = {
  id: "1JU08902781691411",
  amount: { value: "10.99", currency_code: "USD" },
  status: "COMPLETED",
  note: "Defective product",
  links: [
    { rel: "self", method: "GET", href: "https://api-m.paypal.com/v2/payments/refunds/1JU08902781691411" },
    { rel: "up", method: "GET", href: "https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P" },
  ],
};

/** Spec example capture_get_with_paypal_fee_receivable_currency (GET /v2/payments/captures/{id}). */
export const captureDetails = {
  id: "74L756601X447022Y",
  amount: { currency_code: "USD", value: "100.00" },
  final_capture: true,
  status: "COMPLETED",
  supplementary_data: { related_ids: { order_id: "25M43554V9523650M", authorization_id: "0T620041CK889853A" } },
  payee: { email_address: "merchant@example.com", merchant_id: "YXZY75W2GKDQE" },
  create_time: "2024-10-23T20:55:19Z",
  update_time: "2024-10-23T20:55:19Z",
};

/** "List disputes" sample response (use-disputes-api guide). */
export const disputeList = {
  items: [
    {
      dispute_id: "PP-R-ORC-10135512",
      create_time: "2025-09-23T09:25:28.000Z",
      update_time: "2025-09-23T09:47:03.000Z",
      disputed_transactions: [{ buyer_transaction_id: "1XC473123G8516345", seller: { merchant_id: "HAAP3SNYZZ9NG" } }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      status: "RESOLVED",
      dispute_state: "RESOLVED",
      dispute_amount: { currency_code: "USD", value: "10.00" },
      dispute_life_cycle_stage: "INQUIRY",
      dispute_channel: "INTERNAL",
      outcome: "LOST",
      links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-ORC-10135512", rel: "self", method: "GET" }],
    },
    {
      dispute_id: "PP-R-AYP-10135034",
      create_time: "2025-09-18T09:46:54.000Z",
      update_time: "2025-09-23T09:57:13.000Z",
      disputed_transactions: [{ buyer_transaction_id: "7XB07472F52871902", seller: { merchant_id: "HAAP3SNYZZ9NG" } }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      dispute_amount: { currency_code: "USD", value: "2.00" },
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_channel: "INTERNAL",
      seller_response_due_date: "2025-10-04T06:59:59.000Z",
      links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034", rel: "self", method: "GET" }],
    },
  ],
  links: [
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes", rel: "self", method: "GET" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes", rel: "first", method: "GET" },
  ],
};

/** "Show dispute details" sample response (use-disputes-api guide). */
export const disputeDetails = {
  dispute_id: "PP-R-AYP-10135034",
  create_time: "2025-09-18T09:46:54.926Z",
  update_time: "2025-09-18T09:49:53.336Z",
  disputed_transactions: [
    {
      buyer_transaction_id: "7XB07472F52871902",
      seller_transaction_id: "8AW70038VH226914P",
      create_time: "2025-09-18T09:42:33.000Z",
      transaction_status: "HELD",
      gross_amount: { currency_code: "USD", value: "2.00" },
      buyer: { name: "John Doe" },
      seller: { email: "sb-ekqdo43289257@business.example.com", merchant_id: "HAAP3SNYZZ9NG", name: "The Happy Store" },
      items: [{ item_name: "Check Ngo", item_description: "Check Ngo", item_quantity: "1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", item_type: "PRODUCT" }],
      seller_protection_eligible: true,
      seller_protection_type: "EXPANDED_SELLER_PROTECTION",
    },
  ],
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "2.00" },
  dispute_state: "REQUIRED_ACTION",
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  messages: [{ posted_by: "BUYER", time_posted: "2025-09-18T09:46:54.926Z", content: "Test support case" }],
  extensions: { merchant_contacted: false, buyer_contacted_time: "2025-09-18T09:46:53.836Z" },
  evidences: [
    { evidence_type: "CREATE", notes: "Test support case", source: "SUBMITTED_BY_BUYER", date: "2025-09-18T09:46:54.926Z", dispute_life_cycle_stage: "INQUIRY" },
    { evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER", date: "2025-09-18T09:49:53.336Z" },
  ],
  seller_response_due_date: "2025-10-08T09:46:54.926Z",
  offer: { buyer_requested_amount: { currency_code: "USD", value: "2.00" } },
  refund_details: { allowed_refund_amount: { currency_code: "USD", value: "2.00" } },
  allowed_response_options: { accept_claim: { accept_claim_types: ["PARTIAL_REFUND", "REFUND"] }, make_offer: { offer_types: ["REFUND"] } },
  links: [
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034", rel: "self", method: "GET" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/send-message", rel: "send_message", method: "POST" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/escalate", rel: "escalate", method: "POST" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/accept-claim", rel: "accept_claim", method: "POST" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/make-offer", rel: "make_offer", method: "POST" },
    { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/provide-evidence", rel: "provide_evidence", method: "POST" },
  ],
};

/** "Provide evidence" sample response. */
export const evidenceAccepted = {
  links: [{ rel: "self", method: "GET", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803" }],
};

/** Sandbox-only "Create dispute" sample response (test-go-live guide). */
export const disputeCreated = {
  links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803", rel: "self", method: "GET" }],
};

/** Sandbox-only "Create chargeback" sample response (test-go-live guide). */
export const chargebackCreated = { dispute_id: "PP-D-1234" };

/** Webhook event from the postback example in the webhooks integration guide. */
export const webhookEventBody =
  '{"id":"WH-3F562076HD293871E-75F399086E414290U","event_version":"1.0","create_time":"2024-05-16T05:19:19.355Z","resource_type":"capture","resource_version":"2.0","event_type":"PAYMENT.CAPTURE.COMPLETED","summary":"Payment completed for $ 500.0 USD","resource":{"payee":{"email_address":"receivingbusiness@example.com","merchant_id":"QDGTZ7B92B9QT"},"amount":{"value":"500.00","currency_code":"USD"},"supplementary_data":{"related_ids":{"order_id":"9P99943869582473S"}},"update_time":"2024-05-16T05:19:15Z","create_time":"2024-05-16T05:19:15Z","final_capture":true,"id":"3Y662965014333303","status":"COMPLETED"}}';

export const webhookHeaders = {
  "PAYPAL-TRANSMISSION-ID": "db49fb10-1343-11ef-ac58-e32457403f67",
  "PAYPAL-TRANSMISSION-TIME": "2024-05-16T05:19:23Z",
  "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d",
  "PAYPAL-AUTH-ALGO": "SHA256withRSA",
  "PAYPAL-TRANSMISSION-SIG":
    "ab2tJk1VCFm4EqdSuKqezr38rTdY3JeRQlw94V1xYAIQVgLScAFn2XLRAhtyo/1jp8RZPO80hLpWfbdvvwyxK1u6L6NX/bnr0vA1wpfkwbqDT/Z01YP2VvJiYQdhpf/yXosoIKwP+37pYdAhwCsIu2D5fJAaDXpM8A06SpZJkR4f5+k566PDVPP7RCED9Xny4Yo0WyVaFORkiDJkBLGhUUIoO7Jv5JP5RQmFqVxhwSAaf4YYy/2r21r5HMQgAIgtS7oHYRea43Ze03Zz0EWqJu/hvKBzKHqhcvUPF64hVg8Nk2yqjnW7ZHgBWoHil2SJ1xQzaq2vDCXv5gWDn5+TZA==",
};

export const webhookId = "0NH55953DH663215D";

export const transactionSearchPage = (page: number, totalPages: number) => ({
  transaction_details: [
    {
      transaction_info: {
        paypal_account_id: "6STWC2LSUYYYE",
        transaction_id: page === 1 ? "5TY05013RG002845M" : "9XG02315BV174352L",
        paypal_reference_id: "4TH21426N05692944",
        paypal_reference_id_type: "ODR",
        transaction_event_code: page === 1 ? "T0003" : "T1107",
        transaction_initiation_date: "2026-09-30T04:03:52+0000",
        transaction_updated_date: "2026-09-30T04:03:52+0000",
        transaction_amount: { currency_code: "USD", value: page === 1 ? "38.50" : "-38.50" },
        fee_amount: { currency_code: "USD", value: "-1.83" },
        transaction_status: page === 1 ? "S" : "V",
        custom_field: "q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f-T_bcM5JjLk",
        invoice_id: "CS-RCPT-0001",
        protection_eligibility: "01",
      },
    },
  ],
  account_number: "XZXSPECPDZHZU",
  last_refreshed_datetime: "2026-10-02T06:59:59+0000",
  page,
  total_items: totalPages,
  total_pages: totalPages,
  links: [],
});

export const errors = {
  paymentDenied: {
    name: "UNPROCESSABLE_ENTITY",
    details: [{ issue: "PAYMENT_DENIED", description: "PayPal has declined to process this transaction." }],
    message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
    debug_id: "eb476257836d9",
    links: [{ href: "https://developer.paypal.com/docs/api/orders/v2/#error-PAYMENT_DENIED", rel: "information_link", method: "GET" }],
  },
  invalidClient: { error: "invalid_client", error_description: "Client Authentication failed" },
  internal: { name: "INTERNAL_SERVER_ERROR", debug_id: "b1d1f06c7246c", message: "An internal server error has occurred." },
  conflict: {
    name: "RESOURCE_CONFLICT",
    debug_id: "b1d1f06c7246c",
    message: "The server has detected a conflict while processing this request.",
    details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS", description: "A previous request on this resource is currently in progress." }],
  },
  authFailure: { name: "AUTHENTICATION_FAILURE", debug_id: "b1d1f06c7246c", message: "Authentication failed due to missing Authorization header, or invalid authentication credentials." },
  forbiddenDispute: { name: "FORBIDDEN", message: "No permission for the requested operation", debug_id: "e90ec082e0e4d" },
};
