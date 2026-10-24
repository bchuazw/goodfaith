# PayPal integration notes (`@countersign/paypal`)

Researched 2026-10-02 from the developer.paypal.com guides (their `.md` versions) and the official OpenAPI specs in [paypal/paypal-rest-api-specifications](https://github.com/paypal/paypal-rest-api-specifications) (main, last commit 2026-04-07), cross-checked against the developer-site schemas (`https://developer.paypal.com/api/<api>/schema.json`). Sandbox credentials arrived 2026-10-23 (app "Alibi", US business merchant; Vault, cards, disputes and Transaction Search enabled). Anything still marked *verify* is open; §7 lists each question, the live test that answers it, and the answers so far.

One real call was made: the sandbox OAuth endpoint with deliberately fake credentials. It returned `401 {"error":"invalid_client","error_description":"Client Authentication failed"}` and a `paypal-debug-id` header, which our error mapping handles.

---

## 1. Using the package

```ts
import { paypalFromEnv, createPayPalClient, createMockPayPal, isMockPayPal, PayPalError } from "@countersign/paypal";

const paypal = paypalFromEnv(); // real sandbox client if PAYPAL_CLIENT_ID/SECRET are set, else the mock
```

| Env var | Effect |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Both set: real client. Either missing: mock. |
| `PAYPAL_ENV` | `sandbox` (default) or `live`. Live also needs `PAYPAL_ALLOW_LIVE=true` (safety latch). |
| `COUNTERSIGN_MODE=mock` or `PAYPAL_MODE=mock` | Forces the mock even when credentials exist. |
| `COUNTERSIGN_MODE=live` | Throws if the credentials are missing instead of silently using the mock (SCOPE "real vs mocked" gate). |
| `PAYPAL_SANDBOX_BUYER_EMAIL` | Sandbox personal account for buyer-side dispute creation (§2.10). |
| `PAYPAL_BRAND_NAME`, `PAYPAL_PARTNER_ATTRIBUTION_ID`, `PAYPAL_VAULT_STORED_CREDENTIAL=true` | Optional real-client settings. |
| `PAYPAL_MOCK_SEED`, `PAYPAL_MOCK_FAIL_VAULT=true`, `PAYPAL_MOCK_WEB_BASE_URL` | Mock settings: deterministic ids; declined vault charges; where approval links point. |

`paypalFromEnv` returns **one shared instance per configuration** (stored on `globalThis`). The mock keeps state in memory, so all route handlers must use the same instance. Pass `{ shared: false }` for a fresh one.

**For the web app in mock mode** (`isMockPayPal(paypal)`):
- SCOPE.md requires a `MOCK` label in the UI. Show it whenever `isMockPayPal(paypal)` is true, i.e. `paypal.mode === "mock"`. The real client has `mode === "paypal"`.
- Approval links look like PayPal's (`/agreements/approve?approval_session_id=…`, `/checkoutnow?token=…`). Set `PAYPAL_MOCK_WEB_BASE_URL=https://<app>/mock-paypal` to serve a fake approval sheet on those two paths. When the user clicks "Approve", call `paypal.simulateBuyerApproval(id, { email })`; it returns the `redirectUrl` PayPal would send the buyer to. `simulateBuyerCancel(id)` returns the cancel URL.
- Webhooks: `paypal.onWebhook(fn)` (or the `emitWebhook` option) receives `{ event, headers, body, webhookId }`, shaped like PayPal's. Delivery is async (after the API call returns), like real webhooks. To exercise your real webhook route, POST `body` with `headers` to it. Verify with `webhookId: paypal.webhookId`; `verifyWebhookSignature` returns true only for untampered deliveries the mock emitted.
- Disputes: `createSandboxDispute(...)`, then `provideEvidence(...)`, then `simulateDisputeDecision(id, "SELLER_FAVOR" | "BUYER_FAVOR")`, mirroring the sandbox `/adjudicate` call.
- Live activity: `events()` / `onEvent(fn)` give an ordered log of API calls (including failures), buyer actions and webhooks. `_state()` is a PayPal-shaped JSON snapshot.

**Extensions beyond docs/CONTRACTS.md.** All are optional and backwards compatible. The lead may want to record them in the contract.
- `createVaultSetupToken`: `description`, `merchantCustomerId`, `brandName`, `requestId`. The result adds `customerId`.
- `createPaymentToken(id, { requestId })`. The result adds `payerId`.
- `createOrder`: `breakdown`, `shipTo`, `brandName`, `softDescriptor`. The result adds `captureStatus`/`authorizationStatus`. An order can be COMPLETED while its capture is PENDING, so check `captureStatus`.
- `captureAuthorization(id, requestId, { amount, finalCapture, invoiceId, noteToPayer })` enables the partial-capture budget fallback. Also `voidAuthorization(id, { requestId })` and `refundCapture(id, amount, requestId, { note, customId, invoiceId })`.
- `listDisputes({ transactionId, states, maxPages })`. `getDispute` adds `transactionId`, `customId`, `stage`, `state`, `sellerResponseDueDate`, `allowedActions`, `requestedEvidence`, `outcome`.
- `provideEvidence(id, { notes, files, evidenceType = "OTHER", refundIds })`.
- `createSandboxDispute({ ..., strategy, buyerEmail, buyerTransactionId })`.
- `searchTransactions({ start, end, transactionId })`. Results add `invoiceId`, `eventCode`, `statusCode`, `fee`.
- Real client only: `tokenInfo()` returns the granted OAuth scopes, which shows the enabled features. `onLog` gets one secret-free line per HTTP attempt, useful for an on-screen "PayPal calls" trace.
- `createClientToken({ domains? })` (added 2026-10-24 for the web app's JS SDK v6 button): `POST /v1/oauth2/token` with `grant_type=client_credentials&response_type=client_token`, returning `{ clientToken, expiresIn }` for `paypal.createInstance({ clientToken, components: ["paypal-payments"] })`. It is minted per call and never touches the cached server token. **Verified live on 2026-10-24:** an 810-character JWT with `expires_in: 900`. `domains[]` takes bare hostnames only: `example.com` works, while `https://example.com`, `localhost` and `localhost:3000` get `401 invalid_domain`, so the client rejects those before calling. The mock returns a `MOCK-CLIENT-TOKEN.…` placeholder that the real SDK would refuse.

**Errors.** Every client-method failure is a `PayPalError`. `paypalFromEnv` configuration problems throw a plain `Error`, and the mock's `simulate*` helpers throw `MOCK_SIMULATION_ERROR`.
- Fields: `status`, `name`, `debugId` (alias `debug_id`), `details[]`, `issue` (the first detail), `informationLink`, `method`, `path`, `retryable`, `is(code)` and `toJSON()`.
- Messages are built only from PayPal's response fields, never from credentials or headers.
- Local problems use `status: 0`: `CLIENT_VALIDATION_ERROR` (bad input, caught before any call), `NETWORK_ERROR`, `UNEXPECTED_RESPONSE` and `SANDBOX_ONLY`.

---

## 2. Endpoints and the exact shapes we rely on

Base URLs: sandbox `https://api-m.sandbox.paypal.com`, live `https://api-m.paypal.com`. Approval pages are on `https://www.sandbox.paypal.com` and `https://www.paypal.com`.

| Capability | Call | Method in package |
|---|---|---|
| OAuth2 client credentials | `POST /v1/oauth2/token` | internal, cached |
| Vault: setup token | `POST /v3/vault/setup-tokens` | `createVaultSetupToken` |
| Vault: payment token | `POST /v3/vault/payment-tokens` | `createPaymentToken` |
| Orders: create | `POST /v2/checkout/orders` | `createOrder` |
| Orders: show / capture / authorize | `GET /v2/checkout/orders/{id}`, `POST …/capture`, `POST …/authorize` | `getOrder`, `captureOrder`, `authorizeOrder` |
| Payments: capture / void authorization | `POST /v2/payments/authorizations/{id}/capture`, `…/void` | `captureAuthorization`, `voidAuthorization` |
| Payments: refund | `POST /v2/payments/captures/{id}/refund` | `refundCapture` |
| Disputes | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST …/{id}/provide-evidence` | `listDisputes`, `getDispute`, `provideEvidence` |
| Sandbox dispute simulation | `POST /v2/customer-support/process-chargeback` or `POST /v1/customer/disputes` | `createSandboxDispute` |
| Webhook verification | `POST /v1/notifications/verify-webhook-signature` | `verifyWebhookSignature` |
| Transaction Search | `GET /v1/reporting/transactions` | `searchTransactions` |

### 2.1 OAuth2
`POST /v1/oauth2/token` with `Authorization: Basic base64(client_id:secret)`, `Content-Type: application/x-www-form-urlencoded` and body `grant_type=client_credentials`.

The response is `{ scope, access_token, token_type: "Bearer", app_id, expires_in (seconds, about 9h), nonce }`.

We cache the token until `expires_in` minus min(5 min, 10%) and share one in-flight request between concurrent callers. On an API 401 we drop the token and replay once. Identity errors use a different shape, `{ error, error_description }`, which we map to `PayPalError.name = error`. Source: [Authentication](https://developer.paypal.com/api/rest/authentication/).

### 2.2 Vault v3 setup token ("save PayPal without purchase")
Request, from [save-without-purchase/paypal](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal/):
```json
{ "customer": { "id": "<PayPal customer id, optional>", "merchant_customer_id": "<ours, optional>" },
  "payment_source": { "paypal": {
      "description": "<max 128, shown on the approval sheet>",
      "usage_pattern": "IMMEDIATE", "usage_type": "MERCHANT", "customer_type": "CONSUMER",
      "permit_multiple_payment_tokens": false,
      "experience_context": { "brand_name": "…", "return_url": "…", "cancel_url": "…" } } } }
```
- Response 201 (or 200 for an idempotent repeat): `{ id, customer: { id }, status: "PAYER_ACTION_REQUIRED", payment_source, links: [self, approve] }`.
- `approve` is `https://sandbox.paypal.com/agreements/approve?approval_session_id=<id>`.
- Statuses: `CREATED | PAYER_ACTION_REQUIRED | APPROVED | VAULTED | TOKENIZED`.
- The token expires after 3 days.
- `usage_pattern: IMMEDIATE` means "on-demand, variable amount, variable frequency", which fits an agent.
- The OAuth scope needed is `…/vault/payment-tokens/read`.

### 2.3 Vault v3 payment token
- Request: `{ "payment_source": { "token": { "id": "<setup token id>", "type": "SETUP_TOKEN" } } }`.
- Response: `{ id: "jwgvx42", customer: { id }, payment_source: { paypal: { email_address, payer_id, … } }, links }`.
- `id` is the **vault id**.
- Errors from the spec's catalogue:
  - `PAYER_ACTION_REQUIRED`: not approved yet.
  - `SETUP_TOKEN_ALREADY_TOKENIZED`.
  - `TOKEN_NOT_FOUND`.
  - `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`: Vault is not enabled on the app.
  - `PAYPAL_REQUEST_ID_PREVIOUSLY_USED`.
- Scope: `…/vault/payment-tokens/readwrite`.

### 2.4 Orders v2 create (`POST /v2/checkout/orders`)
We always send `PayPal-Request-Id` and `Prefer: return=representation`. Three modes:

1. **Merchant-initiated (buyer not present), the guard's ALLOW path:**
   ```json
   { "intent": "CAPTURE",
     "purchase_units": [{ "amount": { "currency_code": "USD", "value": "38.50",
                                      "breakdown": { "item_total": {…}, "handling": {…} } },
                          "description": "…", "custom_id": "<closed-mandate hash>", "invoice_id": "…",
                          "items": [{ "name": "…", "sku": "…", "unit_amount": {…}, "quantity": "1", "category": "PHYSICAL_GOODS" }],
                          "shipping": { "type": "SHIPPING", "name": { "full_name": "…" }, "address": {…} } }],
     "payment_source": { "paypal": { "vault_id": "jwgvx42" } } }
   ```
   - Documented response: `status: "COMPLETED"` with `purchase_units[0].payments.captures[0]` (`id`, `status`, `seller_receivable_breakdown`, `links`).
   - `intent: "AUTHORIZE"` returns `payments.authorizations[0]` with `status: "CREATED"`. The spec example has no top-level `status`, so we infer `COMPLETED` when payments exist.
   - `PayPal-Request-Id` is **mandatory** for these single-step orders. The orders spec says keys are stored 6 hours (72 hours via an account manager).
   - Optional, behind `vaultStoredCredential`: `stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" }` (spec `paypal_wallet_stored_credential`).
2. **Buyer approval (STEP_UP):** `payment_source.paypal.experience_context` with `return_url`, `cancel_url`, `user_action: "PAY_NOW"`, `landing_page: "LOGIN"`, `payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED"` (no eChecks), and `shipping_preference`:
   - `SET_PROVIDED_ADDRESS` with `shipTo`;
   - `NO_SHIPPING` when all items are digital;
   - else `GET_FROM_FILE`.

   The response has the link rel **`payer-action`**, not `approve`. The documented example omits `status`; we report `PAYER_ACTION_REQUIRED`. After approval PayPal redirects to `return_url?token=<order id>&PayerID=<payer id>`. Then call `captureOrder` or `authorizeOrder`.
3. **Plain (JS SDK v6 popup):** no `payment_source`. Response `status: "CREATED"` with an `approve` link.

Local validation mirrors PayPal's rules:
- amounts with 2 decimals (0 for JPY, HUF and TWD);
- `item_total` is required when items are sent, and the parts must add up (`AMOUNT_MISMATCH`);
- `custom_id` ≤ 255;
- `invoice_id` ≤ 127, and must be unique per account by default (`DUPLICATE_INVOICE_ID`);
- `description` is truncated at 127 by PayPal (we pre-truncate);
- `soft_descriptor` keeps 22 characters;
- quantity is sent as a string.

Sources: `checkout_orders_v2.json` examples (`00_orders_create`, `orders_create_simple`, `orders_create_authorize_single_step_paypal_with_vault_id_and_stored_credentials_usage_pattern`) and [Orders troubleshooting](https://developer.paypal.com/api/rest/integration/orders-api/troubleshooting/).

### 2.5 Capture or authorize an approved order
Call `POST /v2/checkout/orders/{id}/capture` (or `/authorize`) with body `{}`, `Content-Type: application/json`, `PayPal-Request-Id` and `Prefer`. The response is the full order with `payments.captures[0]` or `payments.authorizations[0]` (`id`, `status`, `expiration_time`).

Errors:
- `ORDER_NOT_APPROVED`
- `ORDER_ALREADY_CAPTURED`
- `ORDER_ALREADY_AUTHORIZED`
- `ACTION_DOES_NOT_MATCH_INTENT`
- `PAYER_ACTION_REQUIRED` (with a `payer-action` link)
- `PAYMENT_DENIED`

### 2.6 Authorizations (the HOLD path)
- **Capture:** `POST /v2/payments/authorizations/{id}/capture`. Send `{}` for the full amount, or `{ amount, final_capture: false, invoice_id, note_to_payer }` for partial captures. The capture request has no `custom_id`; it inherits the authorization's. Response: a capture `{ id, status, … }`.
  - Errors: `AUTHORIZATION_VOIDED`, `AUTHORIZATION_ALREADY_CAPTURED`, `AUTHORIZATION_EXPIRED`, `MAX_CAPTURE_AMOUNT_EXCEEDED`, and 409 `PREVIOUS_REQUEST_IN_PROGRESS`.
- **Void:** `POST /v2/payments/authorizations/{id}/void` with **no body**. Returns 204, or 200 with the authorization when `Prefer: return=representation`.
  - Errors: `PREVIOUSLY_CAPTURED`, `PREVIOUSLY_VOIDED`.
- **Lifetime:** PayPal honours authorizations for 3 days and keeps them for 29 days ([auth-honor](https://developer.paypal.com/payment-methods/auth-honor/)).
- **Scope:** `…/payments/payment/authcapture`.

### 2.7 Refunds
`POST /v2/payments/captures/{id}/refund` with `{}` for a full refund, or `{ amount, note_to_payer, custom_id, invoice_id }`. Response: `{ id, status: "COMPLETED", seller_payable_breakdown, … }`.

Errors: `REFUND_AMOUNT_EXCEEDED`, `CAPTURE_FULLY_REFUNDED`, and `TRANSACTION_DISPUTED` (no partial refunds while a case is open). Per the REST requests guide, a refund's request id is honoured for 45 days.

### 2.8 Disputes: list and show
- **List:** `GET /v1/customer/disputes?page_size=50&page=N[&disputed_transaction_id=][&dispute_state=]`. The response is `{ items: [dispute_info], links }`. Each list item carries only `buyer_transaction_id` and `seller.merchant_id`, so use `getDispute` or the `disputed_transaction_id` filter (our capture id) to link a case to a payment.
- **Show:** `GET /v1/customer/disputes/{id}`. It returns:
  - `disputed_transactions[]` (`buyer_transaction_id`, **`seller_transaction_id`** = capture id, `custom`, `invoice_number`, `seller.merchant_id`, items);
  - `reason`, `status`;
  - `dispute_state` (`REQUIRED_ACTION` …);
  - `dispute_life_cycle_stage` (`INQUIRY | CHARGEBACK | PRE_ARBITRATION | ARBITRATION`);
  - `evidences[]` (`source: REQUESTED_FROM_SELLER` lists what to provide);
  - `seller_response_due_date`, `allowed_response_options`, `dispute_outcome`;
  - HATEOAS `links`. A `provide_evidence` rel means you may submit.
- **Statuses:** `OPEN | WAITING_FOR_BUYER_RESPONSE | WAITING_FOR_SELLER_RESPONSE | UNDER_REVIEW | RESOLVED | OTHER`.
- **Reasons:** `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, `…_NOT_AS_DESCRIBED`, `UNAUTHORISED`, `CREDIT_NOT_PROCESSED`, `DUPLICATE_TRANSACTION`, `INCORRECT_AMOUNT`, `PAYMENT_BY_OTHER_MEANS`, `CANCELED_RECURRING_BILLING`, `PROBLEM_WITH_REMITTANCE`, `OTHER`.

Source: [Use Disputes API](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/) and `customer_disputes_v1.json`.

### 2.9 Provide evidence (multipart)
`POST /v1/customer/disputes/{id}/provide-evidence` with `Content-Type: multipart/form-data`:
- part **`input`** with `Content-Type: application/json`: `{ "evidences": [{ "evidence_type": "OTHER", "notes": "…", "evidence_info": { "refund_ids": [...] } }] }`;
- file parts. The spec names them **`evidence-file`**; the guide's curl uses `file1`. We send `evidence-file` (*verify*).

Constraints:
- Response: 200 `{ links }`, so we GET the dispute afterwards to report its new status.
- Notes are limited to 2000 characters.
- Files must be **JPG, JPEG, GIF, PNG or PDF only**, each < 10 MB, ≤ 50 MB per call ([supported files](https://developer.paypal.com/disputes/supported-file-sizes-types/)).
- Document names must match `^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$`, so we sanitise them.
- **Consequence:** the Evidence Pack must be rendered as a PDF or PNG (JSON is rejected), plus a ≤2000-character summary in `notes`.

PayPal's sandbox guide says to use `evidence_type: "OTHER"` when testing internal disputes. The merchant may only submit while the status is `WAITING_FOR_SELLER_RESPONSE`. Scope: `…/disputes/update-seller`.

### 2.10 Creating disputes in the sandbox (risk #2)
Three documented routes ([Test and go live](https://developer.paypal.com/disputes/test-go-live/), [Set up](https://developer.paypal.com/disputes/set-up/)):
1. **Buyer-side API create:** `POST /v1/customer/disputes`, multipart `input` = `{ disputed_transactions: [{ buyer_transaction_id }], reason, dispute_amount, extensions }`, with the header `PayPal-Auth-Assertion: <unsigned JWT {"alg":"none","typ":"JWT"}.{"iss":"<client id>","email":"<sandbox buyer email>"}.>`. Our encoder reproduces PayPal's documented JWT byte for byte. The response is 201 `{ links: [{ rel: "self", href: …/disputes/PP-D-27803 }] }`.
   - **Catch:** the app needs the `DISPUTE_CREATE` scope (`…/disputes/create`), added *by a PayPal account manager*, plus buyer consent via a "Log in with PayPal" flow. Expect `403` without them.
   - The docs only show `buyer_transaction_id`, which is the id the buyer sees, *not* our capture id. We send `seller_transaction_id: <capture id>` unless `buyerTransactionId` is given (*verify*).
2. **Chargeback simulator:** `POST /v2/customer-support/process-chargeback` with `{ adjacency: "PAYPAL", file_layout: "ATCK_CB", merchant_id, financial_institution: { processor: "FDMS" }, transaction: { id_enc: <seller txn id = capture id>, amount }, instrument: { instrument_type: "CARD", … }, dispute: { stage: "CHARGEBACK", event_code: "CHARGEBACK_INITIATED", … } }`. It returns 201 `{ dispute_id }`.
   - No buyer consent is mentioned. The guide says it suits **card-funded** transactions, so the live suite pays with a sandbox test card.
   - We read `merchant_id` from `GET /v2/payments/captures/{id}` → `payee.merchant_id`. This is our default strategy.
3. **Manual fallback:** log in as the sandbox personal account and open a case in the Resolution Center (5 minutes, human).

Sandbox-only helpers, needing status `UNDER_REVIEW`:
- `POST …/{id}/adjudicate { adjudication_outcome: "BUYER_FAVOR" | "SELLER_FAVOR" }` settles a case;
- `POST …/{id}/require-evidence { action: "SELLER_EVIDENCE" }` re-opens it for evidence.

Negative test values: `GET /v1/customer/disputes/ERRDIS015` → `FORBIDDEN`; `POST …/ERRDIS043/provide-evidence` → `UNPROCESSABLE_ENTITY` ([test values](https://developer.paypal.com/platforms/disputes/reference/dispute-api-test-values/)). After creating a dispute, "wait a few minutes" before its actions appear.

### 2.11 Webhook verification
`POST /v1/notifications/verify-webhook-signature` with `{ auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id, webhook_event }`. The values come from the headers `PAYPAL-AUTH-ALGO`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-SIG` and `PAYPAL-TRANSMISSION-TIME`. The response is `{ verification_status: "SUCCESS" | "FAILURE" }`.

PayPal warns that `webhook_event` must be posted back **exactly as received**, because re-serialised JSON can fail verification. So we splice the raw body string into the request instead of using `JSON.stringify` on a parsed object ([Integrate webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)).

| Outcome | Return |
|---|---|
| `SUCCESS` | `true` |
| `FAILURE` | `false` |
| Missing headers | `false` |
| Non-JSON body | `false` |
| PayPal 4xx | `false` |
| PayPal 5xx or network failure | throws, so your endpoint answers non-2xx and PayPal redelivers (up to 25 times over 3 days) |

Simulator ("mock") events cannot be verified by postback. Their webhook id is the literal `WEBHOOK_ID`. Up to 10 webhook URLs per app.

Events we use:
- `VAULT.PAYMENT-TOKEN.CREATED`
- `CHECKOUT.ORDER.APPROVED`
- `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`
- `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`
- `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`

### 2.12 Transaction Search
`GET /v1/reporting/transactions?start_date=…&end_date=…&fields=transaction_info&page_size=500&page=N`. Dates are RFC 3339 with seconds; we send `YYYY-MM-DDTHH:MM:SSZ`.

Limits and behaviour:
- At most **31 days** per call, so we split longer ranges into windows that do not overlap.
- Data appears **up to 3 hours late**.
- The scope `…/reporting/search/read` needs the app's "Transaction search" feature.

Each row's `transaction_info` holds:
- `transaction_id`
- `transaction_event_code`: `T0006` checkout payment, `T0003` pre-approved/vault payment, `T1107` refund, `T1106` reversal
- `transaction_initiation_date`, in the format `2026-09-30T04:03:52+0000` (**no colon in the offset**; we normalise it)
- `transaction_amount`, `fee_amount`
- `transaction_status`: `S` → COMPLETED, `P` → PENDING, `V` → REVERSED, `D` → DENIED
- `custom_field`: our `custom_id`. Its documented pattern `[a-zA-Z0-9_'\-., ":;\!?]*` accepts base64url hashes.
- `invoice_id`

The event codes give the console an "agentic (vault, T0003) vs human (T0006)" split for free (*verify*).

### 2.13 Payouts v1 (`createPayout`, `getPayoutBatch`, `getPayoutItem`)
- **Create:** `POST /v1/payments/payouts`. The body has `sender_batch_header` plus `items[]`, and Payouts money is `{ value, currency }`, not `currency_code`. PayPal answers 201 with the batch header only: `batch_status: PENDING`, no items. It processes the batch asynchronously.
- **Read:** `GET /v1/payments/payouts/{batch_id}` (paged with `page`, `page_size`) gives totals, fees and items. `GET /v1/payments/payouts-item/{item_id}` gives one item.
- **Idempotency:** PayPal pays a `sender_batch_id` at most once in 30 days. The client derives PayPal-Request-Id from it (`payout-<id>`, hashed when it is not printable ASCII), so a retried request is a replay. A reused `sender_batch_id` under a different request id is refused with a link to the original batch. `createPayout` then answers with that batch and `replayed: true`, so a retry never looks like a new payout.
- **Verified live on 2026-10-24:**
  - A 2-item batch went PENDING → SUCCESS in about 30 s.
  - The sandbox buyer's item was SUCCESS.
  - An email with no PayPal account was **UNCLAIMED** with `RECEIVER_UNREGISTERED`; the receiver has 30 days to claim it, after which it is returned.
  - The fee was a flat **$0.25 per item** in the sandbox.
  - Resending the same `sender_batch_id` with a new request id returned the same batch (`replayed: true`) and paid nothing twice.
- **Mock:** batches start PENDING and are processed on first read. Emails containing "unregistered" or "unclaimed" stay UNCLAIMED, the fee is 0.25 per item, and it emits `PAYMENT.PAYOUTSBATCH.PROCESSING`/`.SUCCESS` and `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`/`.UNCLAIMED`.
- **Errors:** v1 errors send `information_link` as a top-level string, while v2 puts it in `links`. Both are parsed, as are links on a detail.

---

## 3. Headers and idempotency
- **`PayPal-Request-Id`** goes on every mutating call:
  - `createOrder`, `captureOrder`, `authorizeOrder` and `captureAuthorization` use the caller's id. The guard should derive it from the closed-mandate hash, so a double submit cannot charge twice.
  - Setup token, payment token, void, refund, evidence and dispute calls get a random UUID unless one is passed.
  - PayPal returns "the latest status of the previous request" for a repeated id. Keys are kept 6 h for orders, 3 h for vault and 45 days for refunds. Max 108 characters. Two simultaneous requests with the same id can fail the second one.
- **Retries:** a GET, or any call with a request id, is retried up to 2 times on network errors, 5xx, 429 and `409 PREVIOUS_REQUEST_IN_PROGRESS`, honouring `Retry-After`. PayPal's own advice is to repeat a timed-out `/capture` with the same id. Evidence upload and dispute creation are **not** retried, because a retry could duplicate them.
- **`Prefer: return=representation`** goes on order, capture, authorize, void and refund calls. The default is `return=minimal`.
- **`PayPal-Partner-Attribution-Id`** is optional (a partner BN code). We send it only if configured.
- **`PayPal-Auth-Assertion`** is used only for buyer-side sandbox disputes.
- **`PayPal-Client-Metadata-Id`** (FraudNet) is needed for *customer-initiated* vault payments (PayPal's RDA warning). Our vault charges are merchant-initiated, so we do not send it (*verify*).
- **`PayPal-Mock-Response: {"mock_application_codes":"<ISSUE>"}`** forces sandbox errors on Orders and Payments ([negative testing](https://developer.paypal.com/negative-testing/request-headers/)). It is not wired into the client; use it from Postman if needed.

---

## 4. Sandbox setup checklist and quirks
1. **Accounts.** Create a **US Business** and a **US Personal** sandbox account. Default accounts may be in the developer's country.
   - A merchant whose primary currency is not the payment currency can see captures stuck in `PENDING` with `status_details.reason = RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`. This is why `captureStatus` is surfaced.
   - Venmo vaulting is US-only.
   - Vault for PayPal wallets is listed for the US, Singapore, the UK, the EU and others.
2. **App features:** Apps & Credentials → app → Features:
   - **Accept payments → Advanced options → Vault**;
   - **Transaction search**;
   - **Customer disputes** (on by default);
   - **card processing** (needed for the card-funded live tests and the chargeback simulator).
3. **Live only:** saving PayPal and reference transactions need eligibility and approval (Account Settings → Payment Preferences → Save PayPal and Venmo payment methods; "contact your account manager" for reference transactions). The sandbox may or may not enforce this; it is the main risk (§7).
4. **Pay Later and other funding choices** belong to the buyer-present approval sheet. `payment_method_preference: IMMEDIATE_PAYMENT_REQUIRED` keeps eCheck (pending) funding out of step-up orders. Vault charges use the wallet's default funding.
5. **Test card for no-human tests:** Visa `4012888888881881`, any future expiry, any CVV ([card testing](https://developer.paypal.com/sandbox-testing/card-testing/)).
6. **Webhooks need a public HTTPS URL on port 443.** Use a tunnel in development. A webhook only receives events from its own REST app.

---

## 5. Errors that matter to the guard and console

| Where | `PayPalError` | Meaning, and what to do |
|---|---|---|
| vault charge | 422 `PAYMENT_DENIED` | Declined. Record a rejection receipt, or step up to buyer approval. |
| vault charge | 422 `TOKEN_ID_NOT_FOUND` / `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` | Bad vault id, or Vault is off for the app. |
| any order | 422 `PAYER_ACTION_REQUIRED` | Send the buyer to the `payer-action` link (step-up). |
| create | 422 `DUPLICATE_INVOICE_ID` | Use a unique `invoiceId` per purchase. |
| capture/authorize | 422 `ORDER_NOT_APPROVED` / `ORDER_ALREADY_CAPTURED` | State machine misuse. A replay with the same request id returns the stored result instead. |
| HOLD | 422 `AUTHORIZATION_EXPIRED` / `PREVIOUSLY_CAPTURED` / `PREVIOUSLY_VOIDED` | Authorization lifecycle. |
| refund | 422 `TRANSACTION_DISPUTED` | Partial refunds are blocked while a case is open. |
| disputes | 422 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` / `INVALID_EVIDENCE_FILE` | Check `allowedActions`; send PDF or PNG only. |
| any | 0 `CLIENT_VALIDATION_ERROR` | Caught locally; nothing was sent. |

---

## 6. Mock fidelity
- **What it shares with the real client:** the same request builders and validation, the same response mappers, PayPal-shaped JSON (orders, captures with fees, authorizations, refunds, disputes, transaction rows with `+0000` dates, webhook events with PayPal headers), PayPal's documented error names and issues, and PayPal-style ids. Order, capture, authorization, refund and setup-token ids have 17 characters, e.g. `4TH21426N05692944`. Other formats: vault id `jwgvx42`, payer id `AJM9JTWQJCFTA`, dispute `PP-R-ABC-10123456`, event `WH-…-…`.
- **Idempotency:** a repeated `PayPal-Request-Id` returns the *current* state of the resource it created.
- **State machines:**
  - setup token: PAYER_ACTION_REQUIRED → APPROVED → VAULTED (3-day expiry);
  - order: PAYER_ACTION_REQUIRED or CREATED → APPROVED → COMPLETED; vault orders complete immediately;
  - authorization: CREATED → PARTIALLY_CAPTURED → CAPTURED, or VOIDED (29-day expiry);
  - capture: COMPLETED → PARTIALLY_REFUNDED → REFUNDED;
  - dispute: WAITING_FOR_SELLER_RESPONSE → UNDER_REVIEW → RESOLVED.
- **Disputes by reason:**
  - UNAUTHORISED and most other reasons open in `CHARGEBACK` and request `OTHER` evidence;
  - item-not-received opens in `INQUIRY` and requests `PROOF_OF_FULFILLMENT`;
  - the `chargeback` strategy uses channel `EXTERNAL`;
  - a buyer-favour decision reverses the capture (T1106 plus `PAYMENT.CAPTURE.REVERSED`).
- **Simplifications:**
  - fees are a flat 3.49% + 0.49;
  - no 3-hour Transaction Search lag;
  - disputes are actionable immediately;
  - the mock does not require the DISPUTE_CREATE scope or a buyer email;
  - `DUPLICATE_INVOICE_ID` is checked at order creation;
  - the setup-token return URL gets `approval_token_id` and `approval_session_id`, and the order return URL gets `token` and `PayerID`. These are the names PayPal's own iOS SDK parses (`paypal/paypal-ios`, `Sources/PayPalPayments/PayPalClient.swift`). Verified for the web redirect on the sandbox (2026-10-23, see §7 #9).
  - Webhook delivery uses `setTimeout`, so `flushWebhooks()` needs real timers.

---

## 7. Unknowns to verify once credentials arrive (ranked)

| # | Unknown | Why it matters | Live test that answers it |
|---|---|---|---|
| 1 | Does a `vault_id` CAPTURE order complete with no buyer in **our** sandbox app (no billing-agreement or reference-transaction gate, no `stored_credential` needed)? | The core "human not present" primitive (IDEATION risk #1). | `MIT: a CAPTURE order with vault_id completes…` (needs `PAYPAL_SANDBOX_VAULT_ID`). **Answered 2026-10-23: yes.** Order `5U205312NJ237521U` completed with no buyer present (capture COMPLETED) and no `stored_credential`. |
| 2 | Can we create a sandbox dispute by API? Does `process-chargeback` work without special scopes? Does buyer-assertion need DISPUTE_CREATE, and does it accept `seller_transaction_id`? | Act 4 of the demo (risk #2). | `OAuth … scopes` reports `disputesCreate`. The chargeback and buyer-assertion tests run with `PAYPAL_LIVE_DISPUTES=1`. The fallback is the Resolution Center (human). |
| 3 | Does provide-evidence accept our multipart (`input` + `evidence-file` parts, sanitised names)? | Evidence submission is the merchant payoff. | `provide-evidence accepts our multipart (ERRDIS043)` probes routing, scope and parsing. The chargeback test submits real evidence. |
| 4 | Partial captures (`final_capture: false`) on a vaulted authorization, then voiding the remainder. | Fallback A for risk #1 (authorise the budget, capture per purchase). | `HOLD: AUTHORIZE with vault_id, partial capture, then void`. **Answered 2026-10-23: works** (authorize, partial capture, void). |
| 5 | Is card processing enabled for the app (needed for the no-human authorize/void/refund test and the chargeback simulator)? | Lets CI-style live runs work without a human. | `card-funded AUTHORIZE -> void…` skips with a reason when cards are unavailable. |
| 6 | Is Transaction Search enabled? Does `custom_field` echo our `custom_id`? Is the vault event code T0003? | Console reconciliation and agentic-vs-human analytics. | `Transaction Search: lists the last 3 days` reports the count, rows with `customId` and a sample. Run it 3 hours after the payment tests. |
| 7 | Does `disputed_transactions[0].custom` carry our `custom_id` (mandate hash)? | Lets the Evidence Analyst map a dispute to its mandate without our DB. | The chargeback test prints `customId`. |
| 8 | Verify-webhook postback for our raw-body request: FAILURE vs 400 for a forged event; SUCCESS for a real one. | Webhook intake. | `verify-webhook-signature postback returns false…`. Real deliveries need a tunnel and `PAYPAL_WEBHOOK_ID`. |
| 9 | Setup-token return URL query parameters; whether the approval link host is `sandbox.paypal.com` or `www.sandbox.paypal.com`. | Wallet "Link PayPal" return handler. | Manual: approve the link printed by `Vault: creates a PayPal setup token…` and look at the redirect. **Answered 2026-10-23:** PayPal redirects to `<return_url>?approval_token_id=<setup token id>&approval_session_id=<the same id>`, so the handler reads `approval_token_id` (the setup token to exchange with `createPaymentToken`). On the consent page the buyer picks the funding source (PayPal balance/bank or a card); the demo wallet uses the sandbox Visa. The approval page shows `brand_name`, so set `PAYPAL_BRAND_NAME` (default "Alibi"). |
| 10 | Idempotent replay of a create-order. | Double-submit safety. | `Idempotency: the same PayPal-Request-Id returns the same order` |

---

## 8. Running the live sandbox suite
1. Put the sandbox app credentials in `countersign/.env.local` or `paypal-ai/.env.local`. The `test:live` script loads both without printing values:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
2. Run `pnpm --filter @countersign/paypal test:live`. The no-human checks run at once: scopes, idempotency, error mapping, step-up order, setup token, card authorize/void/refund, dispute listing, evidence probe, transaction search and webhook postback. Each prints a `[paypal-live]` line with what PayPal said, including `debug_id`.
3. **Vault (one human step):** open the approve URL printed by the setup-token test, log in as the **sandbox personal** account and approve. Then:
   ```
   PAYPAL_SANDBOX_SETUP_TOKEN=<id printed>     # rerun: creates the payment token and prints the vault id
   PAYPAL_SANDBOX_VAULT_ID=<vault id printed>  # rerun: MIT capture (+ refund cleanup) and HOLD authorize/partial/void
   ```
4. **Disputes (slow, leaves sandbox cases):** set `PAYPAL_LIVE_DISPUTES=1`. Add `PAYPAL_SANDBOX_BUYER_EMAIL=<sandbox personal email>` to also try the buyer-assertion route.
5. On PowerShell without an env file, set the variables inline: `$env:PAYPAL_CLIENT_ID="…"; $env:PAYPAL_CLIENT_SECRET="…"; pnpm --filter @countersign/paypal test:live`.

Plain `pnpm test` also runs the live suite **only if** the credentials are already in the shell environment. It never reads env files.

---

## 9. Sources
- Vault: https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal/ · https://developer.paypal.com/sdk/save-without-purchase/paypal/ · `openapi/vault_payment_tokens_v3.json`
- Orders and Payments: `openapi/checkout_orders_v2.json`, `openapi/payments_payment_v2.json` (examples and error catalogues) · https://developer.paypal.com/api/rest/integration/orders-api/troubleshooting/ · https://developer.paypal.com/checkout/delay-capture/ · https://developer.paypal.com/payment-methods/auth-honor/
- Requests, idempotency and errors: https://developer.paypal.com/api/rest/requests/ · https://developer.paypal.com/reference/guidelines/idempotency/ · https://developer.paypal.com/api/rest/responses/ · https://developer.paypal.com/negative-testing/request-headers/
- Disputes: https://developer.paypal.com/disputes/test-go-live/ · https://developer.paypal.com/disputes/set-up/ · https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/ · https://developer.paypal.com/platforms/disputes/reference/dispute-api-test-values/ · https://developer.paypal.com/disputes/supported-file-sizes-types/ · `openapi/customer_disputes_v1.json`
- Webhooks: https://developer.paypal.com/api/rest/webhooks/rest/ · https://developer.paypal.com/api/webhooks/overview/ · https://developer.paypal.com/api/rest/webhooks/event-names/ · `openapi/notifications_webhooks_v1.json`
- Transaction Search: `openapi/reporting_transactions_v1.json`
- Sandbox: https://developer.paypal.com/sandbox-testing/accounts/ · https://developer.paypal.com/sandbox-testing/card-testing/ · https://developer.paypal.com/api/rest/authentication/
