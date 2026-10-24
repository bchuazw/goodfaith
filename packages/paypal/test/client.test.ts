import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayPalClient, isPayPalError, PayPalError, type HttpLogEntry } from "../src/index.js";
import { decodeJwtPart, fetchStub, parseMultipart } from "./fetch-stub.js";
import * as fx from "./fixtures.js";

const CLIENT_ID = "AZgbuZOSPtbrHZsk4VGxP19QodU3VOuGTyPHaE6I6BUVoMu2oJzHdLFyW7FjowYZlgUhI8ydsqxzFP-I";
const CLIENT_SECRET = "EBWKjlELKMYqRNQ6sYvFo64FtaRLRR5BdHEESmha49TM-super-secret";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function client(stub: ReturnType<typeof fetchStub>, extra: Partial<Parameters<typeof createPayPalClient>[0]> = {}) {
  return createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    env: "sandbox",
    fetch: stub.fetch,
    retryBaseDelayMs: 0,
    ...extra,
  });
}

function jsonBody(call: { text: string }): Record<string, unknown> {
  return JSON.parse(call.text) as Record<string, unknown>;
}

async function catchError(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PayPalError) return e;
    throw e;
  }
  throw new Error("expected a PayPalError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OAuth2 client credentials", () => {
  it("sends Basic auth and grant_type, then caches the token across calls", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    const pp = client(stub);
    await pp.getOrder("5O190127TN364715T");
    await pp.getOrder("5O190127TN364715T");
    await pp.getOrder("5O190127TN364715T");

    const tokenCalls = stub.to("POST", "/v1/oauth2/token");
    expect(tokenCalls).toHaveLength(1);
    const t = tokenCalls[0]!;
    expect(t.url.origin).toBe("https://api-m.sandbox.paypal.com");
    expect(t.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(t.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(t.text).toBe("grant_type=client_credentials");
    for (const c of stub.apiCalls()) expect(c.headers.Authorization).toBe(`Bearer ${fx.oauthToken.access_token}`);
  });

  it("shares one in-flight token request between concurrent calls", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    const pp = client(stub);
    await Promise.all([pp.getOrder("A1"), pp.getOrder("A2"), pp.getOrder("A3")]);
    expect(stub.to("POST", "/v1/oauth2/token")).toHaveLength(1);
  });

  it("refreshes the token shortly before expires_in elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const stub = fetchStub([
      ["POST", "/v1/oauth2/token", { json: { ...fx.oauthToken, expires_in: 3600 } }],
      ["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }],
    ]);
    const pp = client(stub);
    await pp.getOrder("A1");
    vi.setSystemTime(new Date("2026-10-02T00:50:00Z")); // 50 min: still inside the 54-minute window
    await pp.getOrder("A1");
    expect(stub.to("POST", "/v1/oauth2/token")).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-02T00:55:00Z")); // past lifetime minus 10% skew
    await pp.getOrder("A1");
    expect(stub.to("POST", "/v1/oauth2/token")).toHaveLength(2);
  });

  it("drops the cached token and replays once when PayPal answers 401", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { status: 401, json: fx.errors.authFailure }, { json: fx.orderCaptured }]]);
    const pp = client(stub);
    const order = await pp.getOrder("5O190127TN364715T");
    expect(order.status).toBe("COMPLETED");
    expect(stub.to("POST", "/v1/oauth2/token")).toHaveLength(2);
  });

  it("maps OAuth errors without leaking the secret", async () => {
    const stub = fetchStub([["POST", "/v1/oauth2/token", { status: 401, json: fx.errors.invalidClient }]]);
    const logs: HttpLogEntry[] = [];
    const pp = client(stub, { onLog: (e) => logs.push(e) });
    const err = await catchError(pp.getOrder("A1"));
    expect(err.status).toBe(401);
    expect(err.name).toBe("invalid_client");
    expect(err.message).toContain("Client Authentication failed");
    const serialized = JSON.stringify({ message: err.message, json: err.toJSON(), stack: err.stack, logs });
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"));
    expect(stub.apiCalls()).toHaveLength(0);
  });

  it("exposes granted scopes for diagnostics", async () => {
    const stub = fetchStub([]);
    const info = await client(stub).tokenInfo();
    expect(info.appId).toBe("APP-80W284485P519543T");
    expect(info.scopes).toContain("https://uri.paypal.com/services/disputes/read-seller");
  });

  it("uses the live base URL for env live and validates config without echoing values", () => {
    const stub = fetchStub([]);
    expect(() => createPayPalClient({ clientId: "", clientSecret: CLIENT_SECRET, env: "sandbox", fetch: stub.fetch })).toThrow(/clientId is required/);
    try {
      createPayPalClient({ clientId: "id", clientSecret: CLIENT_SECRET, env: "staging" as "live", fetch: stub.fetch });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(CLIENT_SECRET);
    }
  });

  it("calls api-m.paypal.com in live", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    await client(stub, { env: "live" }).getOrder("A1");
    expect(stub.calls.every((c) => c.url.origin === "https://api-m.paypal.com")).toBe(true);
  });
});

describe("idempotency and retries", () => {
  it("sends the caller's PayPal-Request-Id and Prefer on createOrder, reusing it on retry", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { status: 500, json: fx.errors.internal }, { json: fx.vaultOrderCompleted }]]);
    const pp = client(stub);
    const res = await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "100.00" },
      vaultId: "jwgvx42",
      requestId: "cs-order-q3RlIZ0rL0vXyYHk2E6kCw",
    });
    expect(res).toMatchObject({ id: "4TH21426N05692944", status: "COMPLETED", captureId: "3B017991HX624902V", captureStatus: "COMPLETED" });
    const posts = stub.to("POST", "/v2/checkout/orders");
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.headers["PayPal-Request-Id"]).toBe("cs-order-q3RlIZ0rL0vXyYHk2E6kCw");
      expect(p.headers.Prefer).toBe("return=representation");
      expect(p.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("generates a UUID PayPal-Request-Id for every mutating call that has no caller id", async () => {
    const stub = fetchStub([
      ["POST", "/v3/vault/setup-tokens", { json: fx.setupTokenCreated }],
      ["POST", "/v3/vault/payment-tokens", { json: fx.paymentTokenCreated }],
      ["POST", /\/void$/, { json: fx.authorizationVoided }],
      ["POST", /\/refund$/, { json: fx.refundCompleted }],
    ]);
    const pp = client(stub);
    await pp.createVaultSetupToken({ returnUrl: "https://cs.example/r", cancelUrl: "https://cs.example/c" });
    await pp.createPaymentToken("4G4976650J0948357");
    await pp.voidAuthorization("5C908745JK343851U");
    await pp.refundCapture("2GG279541U471931P");
    const ids = stub.apiCalls().map((c) => c.headers["PayPal-Request-Id"]);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(new Set(ids).size).toBe(4);
  });

  it("sends PayPal-Request-Id on capture, authorize and authorization capture", async () => {
    const stub = fetchStub([
      ["POST", /\/orders\/[^/]+\/capture$/, { json: fx.orderCaptured }],
      ["POST", /\/orders\/[^/]+\/authorize$/, { json: fx.orderAuthorized }],
      ["POST", /\/authorizations\/[^/]+\/capture$/, { json: fx.authorizationCaptured }],
    ]);
    const pp = client(stub);
    expect(await pp.captureOrder("5O190127TN364715T", "cap-1")).toEqual({
      id: "5O190127TN364715T",
      status: "COMPLETED",
      captureId: "3C679366HH908993F",
      captureStatus: "COMPLETED",
    });
    expect(await pp.authorizeOrder("5O190127TN364715T", "auth-1")).toEqual({
      id: "5O190127TN364715T",
      status: "COMPLETED",
      authorizationId: "0AW2184448108334S",
      authorizationStatus: "CREATED",
      expiresAt: "2021-10-08T23:37:39Z",
    });
    expect(await pp.captureAuthorization("0AW2184448108334S", "authcap-1")).toEqual({ captureId: "2GG279541U471931P", status: "COMPLETED" });
    expect(stub.apiCalls().map((c) => c.headers["PayPal-Request-Id"])).toEqual(["cap-1", "auth-1", "authcap-1"]);
    expect(stub.apiCalls().map((c) => c.text)).toEqual(["{}", "{}", "{}"]);
  });

  it("retries GETs on 503 and 409 PREVIOUS_REQUEST_IN_PROGRESS, then gives up with the PayPal error", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { status: 503, text: "<html>busy</html>" }, { status: 409, json: fx.errors.conflict }, { json: fx.orderCaptured }]]);
    expect((await client(stub).getOrder("A1")).status).toBe("COMPLETED");
    expect(stub.apiCalls()).toHaveLength(3);

    const failing = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { status: 500, json: fx.errors.internal }]]);
    const err = await catchError(client(failing, { maxRetries: 1 }).getOrder("A1"));
    expect(err).toMatchObject({ status: 500, name: "INTERNAL_SERVER_ERROR", debugId: "b1d1f06c7246c" });
    expect(failing.apiCalls()).toHaveLength(2);
  });

  it("turns network failures into NETWORK_ERROR after retrying", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, new TypeError("fetch failed")]]);
    const err = await catchError(client(stub).getOrder("A1"));
    expect(err).toMatchObject({ status: 0, name: "NETWORK_ERROR", retryable: true });
    expect(stub.apiCalls()).toHaveLength(3);
  });

  it("does not retry 4xx business errors", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { status: 422, json: fx.errors.paymentDenied }]]);
    const err = await catchError(
      client(stub).createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: "jwgvx42", requestId: "r-1" }),
    );
    expect(stub.apiCalls()).toHaveLength(1);
    expect(err.retryable).toBe(false);
  });
});

describe("error mapping", () => {
  it("maps PayPal REST errors to PayPalError with status, name, debug_id and details", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { status: 422, json: fx.errors.paymentDenied }]]);
    const err = await catchError(
      client(stub).createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: "jwgvx42", requestId: "r-1" }),
    );
    expect(isPayPalError(err)).toBe(true);
    expect(err.status).toBe(422);
    expect(err.name).toBe("UNPROCESSABLE_ENTITY");
    expect(err.debugId).toBe("eb476257836d9");
    expect(err.debug_id).toBe("eb476257836d9");
    expect(err.issue).toBe("PAYMENT_DENIED");
    expect(err.is("PAYMENT_DENIED")).toBe(true);
    expect(err.details[0]).toEqual({ issue: "PAYMENT_DENIED", description: "PayPal has declined to process this transaction." });
    expect(err.informationLink).toBe("https://developer.paypal.com/docs/api/orders/v2/#error-PAYMENT_DENIED");
    expect(err.message).toContain("PAYMENT_DENIED");
    expect(err.message).toContain("POST /v2/checkout/orders");
    expect(err.toJSON()).toMatchObject({ name: "UNPROCESSABLE_ENTITY", status: 422, debug_id: "eb476257836d9" });
  });

  it("summarises non-JSON error bodies and falls back to the paypal-debug-id header", async () => {
    const stub = fetchStub([["GET", /^\/v1\/customer\/disputes\//, { status: 502, text: "<html>Bad gateway</html>", headers: { "paypal-debug-id": "abc123def4567" } }]]);
    const err = await catchError(client(stub, { maxRetries: 0 }).getDispute("PP-D-27803"));
    expect(err.name).toBe("HTTP_502");
    expect(err.debugId).toBe("abc123def4567");
    expect(err.message).not.toContain("<html>");
  });

  it("maps the documented sandbox dispute test value ERRDIS015 (FORBIDDEN)", async () => {
    const stub = fetchStub([["GET", "/v1/customer/disputes/ERRDIS015", { status: 403, json: fx.errors.forbiddenDispute }]]);
    const err = await catchError(client(stub).getDispute("ERRDIS015"));
    expect(err).toMatchObject({ status: 403, name: "FORBIDDEN", debugId: "e90ec082e0e4d" });
  });

  it("rejects ids that could alter the request path before calling PayPal", async () => {
    const stub = fetchStub([]);
    const err = await catchError(client(stub).getOrder("../v1/oauth2/token"));
    expect(err.name).toBe("CLIENT_VALIDATION_ERROR");
    expect(stub.calls).toHaveLength(0);
  });

  it("never passes secrets, tokens or headers to the log hook", async () => {
    const logs: HttpLogEntry[] = [];
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    await client(stub, { onLog: (e) => logs.push(e) }).getOrder("A1");
    expect(logs.map((l) => `${l.method} ${l.path} ${l.status}`)).toEqual(["POST /v1/oauth2/token 200", "GET /v2/checkout/orders/A1 200"]);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(fx.oauthToken.access_token);
  });
});

describe("Vault v3", () => {
  it("creates a PayPal setup token for vault-without-purchase", async () => {
    const stub = fetchStub([["POST", "/v3/vault/setup-tokens", { json: fx.setupTokenCreated }]]);
    const token = await client(stub, { brandName: "Good Faith" }).createVaultSetupToken({
      returnUrl: "https://cs.example/wallet/linked",
      cancelUrl: "https://cs.example/wallet",
      customerId: "customer_4029352051",
      merchantCustomerId: "maya-001",
    });
    expect(token).toEqual({
      id: "4G4976650J0948357",
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://sandbox.paypal.com/agreements/approve?approval_session_id=4G4976650J0948357",
      customerId: "customer_4029352051",
    });
    expect(jsonBody(stub.to("POST", "/v3/vault/setup-tokens")[0]!)).toEqual({
      customer: { id: "customer_4029352051", merchant_customer_id: "maya-001" },
      payment_source: {
        paypal: {
          description: "Pay for purchases your AI agent makes within the permission slips you sign",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: "Good Faith",
            return_url: "https://cs.example/wallet/linked",
            cancel_url: "https://cs.example/wallet",
          },
        },
      },
    });
  });

  it("exchanges an approved setup token for a payment token", async () => {
    const stub = fetchStub([["POST", "/v3/vault/payment-tokens", { json: fx.paymentTokenCreated }]]);
    const pt = await client(stub).createPaymentToken("4G4976650J0948357", { requestId: "pt-req-1" });
    expect(pt).toEqual({ vaultId: "jwgvx42", customerId: "customer_4029352051", payerEmail: "email@example.com", payerId: "AJM9JTWQJCFTA" });
    const call = stub.to("POST", "/v3/vault/payment-tokens")[0]!;
    expect(jsonBody(call)).toEqual({ payment_source: { token: { id: "4G4976650J0948357", type: "SETUP_TOKEN" } } });
    expect(call.headers["PayPal-Request-Id"]).toBe("pt-req-1");
  });

  it("validates setup token input locally", async () => {
    const stub = fetchStub([]);
    const err = await catchError(client(stub).createVaultSetupToken({ returnUrl: "javascript:alert(1)", cancelUrl: "https://cs.example/c" }));
    expect(err.name).toBe("CLIENT_VALIDATION_ERROR");
    expect(err.details[0]?.field).toBe("/returnUrl");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("Orders v2", () => {
  it("builds a merchant-initiated vault order: vault_id, custom_id, items with an item_total breakdown", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { json: fx.vaultOrderCompleted }]]);
    const res = await client(stub).createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "38.50" },
      description: "Northwind Pets: Salmon kibble 4kg",
      customId: "q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f-T_bcM5JjLk",
      invoiceId: "CS-RCPT-0001",
      vaultId: "jwgvx42",
      items: [
        { name: "Salmon kibble 4kg", sku: "NW-KIB-4", unitAmount: { currency: "USD", value: "32.5" }, quantity: 1, category: "PHYSICAL_GOODS" },
        { name: "Treats", unitAmount: { currency: "USD", value: "1.00" }, quantity: 2 },
      ],
      shipTo: { name: "Maya Lee", line1: "1 Main St", city: "San Jose", state: "CA", postalCode: "95131", country: "US" },
      requestId: "cs-order-1",
    });
    expect(res.status).toBe("COMPLETED");
    expect(res.captureId).toBe("3B017991HX624902V");
    expect(res.approveUrl).toBeUndefined();

    expect(jsonBody(stub.to("POST", "/v2/checkout/orders")[0]!)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: "38.50",
            breakdown: { item_total: { currency_code: "USD", value: "34.50" }, handling: { currency_code: "USD", value: "4.00" } },
          },
          description: "Northwind Pets: Salmon kibble 4kg",
          custom_id: "q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f-T_bcM5JjLk",
          invoice_id: "CS-RCPT-0001",
          items: [
            { name: "Salmon kibble 4kg", sku: "NW-KIB-4", unit_amount: { currency_code: "USD", value: "32.50" }, quantity: "1", category: "PHYSICAL_GOODS" },
            { name: "Treats", unit_amount: { currency_code: "USD", value: "1.00" }, quantity: "2" },
          ],
          shipping: {
            type: "SHIPPING",
            name: { full_name: "Maya Lee" },
            address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
          },
        },
      ],
      payment_source: { paypal: { vault_id: "jwgvx42" } },
    });
  });

  it("adds stored_credential for vault orders when configured", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { json: fx.vaultOrderAuthorized }]]);
    const res = await client(stub, { vaultStoredCredential: true }).createOrder({
      intent: "AUTHORIZE",
      amount: { currency: "USD", value: "100.00" },
      vaultId: "2w915838hr181240m",
      requestId: "cs-hold-1",
    });
    // The documented example has no `status`; an order carrying an authorization is COMPLETED.
    expect(res).toEqual({ id: "8K832279M55989614", status: "COMPLETED", authorizationId: "7X550106NA4440028", authorizationStatus: "CREATED" });
    const body = jsonBody(stub.to("POST", "/v2/checkout/orders")[0]!);
    expect(body.payment_source).toEqual({
      paypal: { vault_id: "2w915838hr181240m", stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" } },
    });
  });

  it("builds a buyer-approval order with experience_context and returns the payer-action link", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { json: fx.orderPayerAction }]]);
    const res = await client(stub).createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "52.00" },
      items: [{ name: "Digital gift card", unitAmount: { currency: "USD", value: "52.00" }, quantity: 1, category: "DIGITAL_GOODS" }],
      returnUrl: "https://cs.example/step-up/return",
      cancelUrl: "https://cs.example/step-up/cancel",
      requestId: "cs-stepup-1",
    });
    expect(res).toEqual({
      id: "5O190127TN364715T",
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T",
    });
    const body = jsonBody(stub.to("POST", "/v2/checkout/orders")[0]!);
    expect(body.payment_source).toEqual({
      paypal: {
        experience_context: {
          shipping_preference: "NO_SHIPPING",
          landing_page: "LOGIN",
          user_action: "PAY_NOW",
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          return_url: "https://cs.example/step-up/return",
          cancel_url: "https://cs.example/step-up/cancel",
        },
      },
    });
  });

  it("creates a plain order (no payment_source) for the JS SDK and returns the approve link", async () => {
    const stub = fetchStub([
      [
        "POST",
        "/v2/checkout/orders",
        {
          json: {
            id: "5O190127TN364715T",
            status: "CREATED",
            links: [
              { href: "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" },
              { href: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve", method: "GET" },
            ],
          },
        },
      ],
    ]);
    const res = await client(stub).createOrder({ intent: "AUTHORIZE", amount: { currency: "USD", value: "10" }, requestId: "r-plain" });
    expect(res).toEqual({ id: "5O190127TN364715T", status: "CREATED", approveUrl: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T" });
    const body = jsonBody(stub.to("POST", "/v2/checkout/orders")[0]!);
    expect(body).toEqual({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] });
  });

  it("validates orders locally (precision, URL pairs, breakdown sums, request id length)", async () => {
    const stub = fetchStub([]);
    const pp = client(stub);
    const base = { intent: "CAPTURE" as const, amount: { currency: "USD", value: "10.00" }, requestId: "r" };
    expect((await catchError(pp.createOrder({ ...base, amount: { currency: "USD", value: "10.999" } }))).name).toBe("CLIENT_VALIDATION_ERROR");
    expect((await catchError(pp.createOrder({ ...base, amount: { currency: "JPY", value: "100.5" } }))).message).toMatch(/decimal/);
    expect((await catchError(pp.createOrder({ ...base, amount: { currency: "USD", value: "0" } }))).message).toMatch(/greater than zero/);
    expect((await catchError(pp.createOrder({ ...base, returnUrl: "https://a.example" }))).message).toMatch(/together/);
    expect((await catchError(pp.createOrder({ ...base, requestId: "x".repeat(109) }))).message).toMatch(/108/);
    const mismatch = await catchError(
      pp.createOrder({
        ...base,
        items: [{ name: "a", unitAmount: { currency: "USD", value: "8.00" }, quantity: 1 }],
        breakdown: { shipping: { currency: "USD", value: "1.00" } },
      }),
    );
    expect(mismatch.issue).toBe("AMOUNT_MISMATCH");
    expect(
      (await catchError(pp.createOrder({ ...base, items: [{ name: "a", unitAmount: { currency: "EUR", value: "10.00" }, quantity: 1 }] }))).message,
    ).toMatch(/currency/);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends explicit breakdowns and discounts", async () => {
    const stub = fetchStub([["POST", "/v2/checkout/orders", { json: fx.vaultOrderCompleted }]]);
    const pp = client(stub);
    await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "38.50" },
      items: [{ name: "Kibble", unitAmount: { currency: "USD", value: "35.00" }, quantity: 1 }],
      breakdown: { shipping: { currency: "USD", value: "4.99" }, tax: { currency: "USD", value: "2.51" }, discount: { currency: "USD", value: "4.00" } },
      vaultId: "jwgvx42",
      requestId: "r-bd",
    });
    await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "30.00" },
      items: [{ name: "Kibble", unitAmount: { currency: "USD", value: "35.00" }, quantity: 1 }],
      vaultId: "jwgvx42",
      requestId: "r-disc",
    });
    const [explicit, discounted] = stub.to("POST", "/v2/checkout/orders").map((c) => jsonBody(c));
    expect((explicit as { purchase_units: Array<{ amount: unknown }> }).purchase_units[0]!.amount).toEqual({
      currency_code: "USD",
      value: "38.50",
      breakdown: {
        item_total: { currency_code: "USD", value: "35.00" },
        shipping: { currency_code: "USD", value: "4.99" },
        tax_total: { currency_code: "USD", value: "2.51" },
        discount: { currency_code: "USD", value: "4.00" },
      },
    });
    expect((discounted as { purchase_units: Array<{ amount: { breakdown: unknown } }> }).purchase_units[0]!.amount.breakdown).toEqual({
      item_total: { currency_code: "USD", value: "35.00" },
      discount: { currency_code: "USD", value: "5.00" },
    });
  });

  it("reads orders back with normalised fields and the raw body", async () => {
    const stub = fetchStub([["GET", "/v2/checkout/orders/4TH21426N05692944", { json: fx.vaultOrderCompleted }]]);
    const order = await client(stub).getOrder("4TH21426N05692944");
    expect(order).toMatchObject({ id: "4TH21426N05692944", status: "COMPLETED", captureId: "3B017991HX624902V", payerEmail: "email@example.com" });
    expect(order.raw).toEqual(fx.vaultOrderCompleted);
  });
});

describe("Payments v2", () => {
  it("captures part of an authorization with an amount and final_capture=false", async () => {
    const stub = fetchStub([["POST", /\/authorizations\/[^/]+\/capture$/, { json: fx.authorizationCaptured }]]);
    await client(stub).captureAuthorization("0VF52814937998046", "cap-part-1", {
      amount: { currency: "USD", value: "10.99" },
      finalCapture: false,
      invoiceId: "CS-RCPT-0002",
    });
    expect(jsonBody(stub.apiCalls()[0]!)).toEqual({ amount: { currency_code: "USD", value: "10.99" }, final_capture: false, invoice_id: "CS-RCPT-0002" });
  });

  it("voids with no request body, handling both 200 and 204", async () => {
    const stub = fetchStub([["POST", /\/void$/, { json: fx.authorizationVoided }, { status: 204 }]]);
    const pp = client(stub);
    expect(await pp.voidAuthorization("5C908745JK343851U")).toEqual({ status: "VOIDED" });
    expect(await pp.voidAuthorization("5C908745JK343851U", { requestId: "void-1" })).toEqual({ status: "VOIDED" });
    const calls = stub.apiCalls();
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(calls[1]!.headers["PayPal-Request-Id"]).toBe("void-1");
  });

  it("refunds fully (empty body) or partially with a note", async () => {
    const stub = fetchStub([["POST", /\/refund$/, { json: fx.refundCompleted }]]);
    const pp = client(stub);
    expect(await pp.refundCapture("2GG279541U471931P")).toEqual({ refundId: "1JU08902781691411", status: "COMPLETED" });
    await pp.refundCapture("2GG279541U471931P", { currency: "USD", value: "10.99" }, "refund-1", { note: "Defective product", customId: "receipt-hash" });
    const [full, partial] = stub.apiCalls();
    expect(full!.text).toBe("{}");
    expect(jsonBody(partial!)).toEqual({ amount: { currency_code: "USD", value: "10.99" }, note_to_payer: "Defective product", custom_id: "receipt-hash" });
    expect(partial!.headers["PayPal-Request-Id"]).toBe("refund-1");
  });
});

describe("Disputes v1", () => {
  it("lists disputes with pagination parameters and filters", async () => {
    const stub = fetchStub([["GET", "/v1/customer/disputes", { json: fx.disputeList }]]);
    const list = await client(stub).listDisputes({ transactionId: "3B017991HX624902V", states: ["REQUIRED_ACTION"] });
    expect(list).toEqual([
      {
        id: "PP-R-ORC-10135512",
        status: "RESOLVED",
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        amount: { currency: "USD", value: "10.00" },
        transactionId: "1XC473123G8516345",
        stage: "INQUIRY",
        state: "RESOLVED",
        createdAt: "2025-09-23T09:25:28.000Z",
        updatedAt: "2025-09-23T09:47:03.000Z",
      },
      {
        id: "PP-R-AYP-10135034",
        status: "WAITING_FOR_SELLER_RESPONSE",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        amount: { currency: "USD", value: "2.00" },
        transactionId: "7XB07472F52871902",
        stage: "CHARGEBACK",
        state: "REQUIRED_ACTION",
        createdAt: "2025-09-18T09:46:54.000Z",
        updatedAt: "2025-09-23T09:57:13.000Z",
      },
    ]);
    const q = stub.apiCalls()[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      page_size: "50",
      page: "1",
      disputed_transaction_id: "3B017991HX624902V",
      dispute_state: "REQUIRED_ACTION",
    });
  });

  it("follows pages while full pages come back", async () => {
    const full = { items: Array.from({ length: 50 }, (_, n) => ({ ...fx.disputeList.items[1], dispute_id: `PP-R-AAA-1000${String(n).padStart(4, "0")}` })) };
    const stub = fetchStub([["GET", "/v1/customer/disputes", { json: full }, { json: fx.disputeList }]]);
    const list = await client(stub).listDisputes();
    expect(list).toHaveLength(52);
    expect(stub.apiCalls().map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("gets dispute details: seller transaction id, requested evidence and allowed actions", async () => {
    const stub = fetchStub([["GET", "/v1/customer/disputes/PP-R-AYP-10135034", { json: fx.disputeDetails }]]);
    const d = await client(stub).getDispute("PP-R-AYP-10135034");
    expect(d).toMatchObject({
      id: "PP-R-AYP-10135034",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amount: { currency: "USD", value: "2.00" },
      transactionId: "8AW70038VH226914P",
      stage: "INQUIRY",
      state: "REQUIRED_ACTION",
      sellerResponseDueDate: "2025-10-08T09:46:54.926Z",
      requestedEvidence: ["PROOF_OF_FULFILLMENT"],
      allowedActions: ["send_message", "escalate", "accept_claim", "make_offer", "provide_evidence"],
    });
    expect(d.raw).toEqual(fx.disputeDetails);
  });

  it("encodes provide-evidence as multipart: a JSON 'input' part plus evidence-file parts", async () => {
    const stub = fetchStub([
      ["POST", "/v1/customer/disputes/PP-D-27803/provide-evidence", { status: 200, json: fx.evidenceAccepted }],
      ["GET", "/v1/customer/disputes/PP-D-27803", { json: { ...fx.disputeDetails, dispute_id: "PP-D-27803", status: "UNDER_REVIEW" } }],
    ]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0x80, 0x0d, 0x0a]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const notes = 'Buyer signed AP2 permission slip PS-7 ("cat food ≤ $45"); chain verified.';
    const res = await client(stub).provideEvidence("PP-D-27803", {
      notes,
      files: [
        { name: "mandate chain (v2).pdf", contentType: "application/pdf", data: pdf },
        { name: "trace.png", contentType: "image/png", data: png },
      ],
    });
    expect(res).toEqual({ status: "UNDER_REVIEW" });

    const call = stub.to("POST", "/v1/customer/disputes/PP-D-27803/provide-evidence")[0]!;
    expect(call.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=----GoodFaithBoundary[0-9a-f]{24}$/);
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(call.body).toBeInstanceOf(Uint8Array);
    const parts = parseMultipart(call.body as Uint8Array, call.headers["Content-Type"]!);
    expect(parts.map((p) => [p.name, p.filename, p.contentType])).toEqual([
      ["input", undefined, "application/json"],
      ["evidence-file", "mandate chain -v2-.pdf", "application/pdf"],
      ["evidence-file", "trace.png", "image/png"],
    ]);
    expect(parts[0]!.headers[0]).toBe('Content-Disposition: form-data; name="input"');
    expect(JSON.parse(parts[0]!.text)).toEqual({ evidences: [{ evidence_type: "OTHER", notes }] });
    expect(Array.from(parts[1]!.data)).toEqual(Array.from(pdf));
    expect(Array.from(parts[2]!.data)).toEqual(Array.from(png));
  });

  it("does not retry evidence submission on 5xx (it could duplicate evidence)", async () => {
    const stub = fetchStub([["POST", /provide-evidence$/, { status: 500, json: fx.errors.internal }]]);
    const err = await catchError(client(stub).provideEvidence("PP-D-27803", { notes: "x" }));
    expect(err.status).toBe(500);
    expect(stub.apiCalls()).toHaveLength(1);
  });

  it("validates evidence files against PayPal's limits before uploading", async () => {
    const stub = fetchStub([]);
    const pp = client(stub);
    const json = await catchError(
      pp.provideEvidence("PP-D-27803", { notes: "x", files: [{ name: "pack.json", contentType: "application/json", data: new Uint8Array(2) }] }),
    );
    expect(json.issue).toBe("INVALID_EVIDENCE_FILE");
    const big = await catchError(
      pp.provideEvidence("PP-D-27803", { notes: "x", files: [{ name: "a.pdf", contentType: "application/pdf", data: new Uint8Array(10 * 1024 * 1024) }] }),
    );
    expect(big.issue).toBe("INVALID_EVIDENCE_FILE");
    expect((await catchError(pp.provideEvidence("PP-D-27803", { notes: "n".repeat(2001) }))).message).toMatch(/2000/);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends PROOF_OF_REFUND evidence with refund ids", async () => {
    const stub = fetchStub([
      ["POST", /provide-evidence$/, { status: 200, json: fx.evidenceAccepted }],
      ["GET", /^\/v1\/customer\/disputes\//, { json: fx.disputeDetails }],
    ]);
    await client(stub).provideEvidence("PP-D-27803", { notes: "Refunded in full", refundIds: ["1JU08902781691411"] });
    const call = stub.to("POST", /provide-evidence$/)[0]!;
    const [input] = parseMultipart(call.body as Uint8Array, call.headers["Content-Type"]!);
    expect(JSON.parse(input!.text)).toEqual({
      evidences: [{ evidence_type: "PROOF_OF_REFUND", notes: "Refunded in full", evidence_info: { refund_ids: ["1JU08902781691411"] } }],
    });
  });

  it("creates a sandbox chargeback from a capture (no buyer consent needed)", async () => {
    const stub = fetchStub([
      ["GET", "/v2/payments/captures/74L756601X447022Y", { json: fx.captureDetails }],
      ["POST", "/v2/customer-support/process-chargeback", { json: fx.chargebackCreated }],
    ]);
    const res = await client(stub).createSandboxDispute({ captureId: "74L756601X447022Y", reason: "UNAUTHORISED", amount: { currency: "USD", value: "100" } });
    expect(res).toEqual({ id: "PP-D-1234" });
    const body = jsonBody(stub.to("POST", "/v2/customer-support/process-chargeback")[0]!) as Record<string, any>;
    expect(body).toMatchObject({
      adjacency: "PAYPAL",
      file_layout: "ATCK_CB",
      merchant_id: "YXZY75W2GKDQE",
      financial_institution: { processor: "FDMS" },
      transaction: { id_enc: "74L756601X447022Y", amount: { currency_code: "USD", value: "100.00" } },
      instrument: { instrument_type: "CARD", card_brand: "VISA", external: false },
      dispute: { stage: "CHARGEBACK", event_code: "CHARGEBACK_INITIATED", amount: { currency_code: "USD", value: "100.00" } },
    });
    expect(body.instrument.credit_card_transaction_id).toMatch(/^\d{16}$/);
    expect(body.dispute.processor_info.reference_number).toMatch(/^\d{23}$/);
  });

  it("creates a buyer dispute with an unsigned PayPal-Auth-Assertion for the sandbox buyer", async () => {
    const stub = fetchStub([["POST", "/v1/customer/disputes", { json: fx.disputeCreated }]]);
    const res = await client(stub, { sandboxBuyerEmail: "sb-rk-buyer@personal.example.com" }).createSandboxDispute({
      captureId: "3B017991HX624902V",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amount: { currency: "USD", value: "20" },
    });
    expect(res).toEqual({ id: "PP-D-27803" });
    const call = stub.to("POST", "/v1/customer/disputes")[0]!;
    const [header, payload, signature] = call.headers["PayPal-Auth-Assertion"]!.split(".");
    expect(decodeJwtPart(header!)).toEqual({ alg: "none", typ: "JWT" });
    expect(decodeJwtPart(payload!)).toEqual({ iss: CLIENT_ID, email: "sb-rk-buyer@personal.example.com" });
    expect(signature).toBe("");
    const [input] = parseMultipart(call.body as Uint8Array, call.headers["Content-Type"]!);
    expect(input!.name).toBe("input");
    expect(JSON.parse(input!.text)).toEqual({
      disputed_transactions: [{ seller_transaction_id: "3B017991HX624902V" }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dispute_amount: { currency_code: "USD", value: "20.00" },
      extensions: { merchant_contacted: true, merchant_contacted_outcome: "NO_RESPONSE", merchandize_dispute_properties: { issue_type: "PRODUCT" } },
    });
  });

  it("refuses sandbox dispute simulation in live", async () => {
    const stub = fetchStub([]);
    const err = await catchError(
      client(stub, { env: "live" }).createSandboxDispute({ captureId: "3B017991HX624902V", reason: "UNAUTHORISED", amount: { currency: "USD", value: "1" } }),
    );
    expect(err.name).toBe("SANDBOX_ONLY");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("webhook signature verification (postback)", () => {
  it("posts the raw event body back byte for byte and returns true on SUCCESS", async () => {
    const stub = fetchStub([["POST", "/v1/notifications/verify-webhook-signature", { status: 200, json: { verification_status: "SUCCESS" } }]]);
    // Formatting that JSON.parse + JSON.stringify would change: spaces, 500.0, escaped slash.
    const body = fx.webhookEventBody.replace('"event_version":"1.0"', '"event_version" : "1.0"').replace('"value":"500.00"', '"value":"500.00","x":500.0,"url":"a\\/b"');
    const ok = await client(stub).verifyWebhookSignature({ headers: fx.webhookHeaders, body, webhookId: fx.webhookId });
    expect(ok).toBe(true);
    const call = stub.apiCalls()[0]!;
    expect(call.text.endsWith(`"webhook_event":${body}}`)).toBe(true);
    const sent = JSON.parse(call.text) as Record<string, unknown>;
    expect(sent).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: fx.webhookHeaders["PAYPAL-CERT-URL"],
      transmission_id: fx.webhookHeaders["PAYPAL-TRANSMISSION-ID"],
      transmission_sig: fx.webhookHeaders["PAYPAL-TRANSMISSION-SIG"],
      transmission_time: fx.webhookHeaders["PAYPAL-TRANSMISSION-TIME"],
      webhook_id: fx.webhookId,
    });
    expect(call.headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("returns false on FAILURE, on missing headers, on malformed bodies and on 4xx", async () => {
    const stub = fetchStub([
      ["POST", "/v1/notifications/verify-webhook-signature", { status: 200, json: { verification_status: "FAILURE" } }, { status: 400, json: { name: "VALIDATION_ERROR", message: "Invalid data provided", debug_id: "x" } }],
    ]);
    const pp = client(stub);
    expect(await pp.verifyWebhookSignature({ headers: fx.webhookHeaders, body: fx.webhookEventBody, webhookId: fx.webhookId })).toBe(false);
    expect(await pp.verifyWebhookSignature({ headers: fx.webhookHeaders, body: fx.webhookEventBody, webhookId: fx.webhookId })).toBe(false);
    const { "PAYPAL-TRANSMISSION-SIG": _omit, ...partial } = fx.webhookHeaders;
    expect(await pp.verifyWebhookSignature({ headers: partial, body: fx.webhookEventBody, webhookId: fx.webhookId })).toBe(false);
    expect(await pp.verifyWebhookSignature({ headers: fx.webhookHeaders, body: "not json", webhookId: fx.webhookId })).toBe(false);
    expect(stub.apiCalls()).toHaveLength(2);
  });

  it("throws on 5xx so the webhook endpoint answers non-2xx and PayPal redelivers", async () => {
    const stub = fetchStub([["POST", "/v1/notifications/verify-webhook-signature", { status: 503, json: fx.errors.internal }]]);
    const err = await catchError(
      client(stub, { maxRetries: 0 }).verifyWebhookSignature({ headers: fx.webhookHeaders, body: fx.webhookEventBody, webhookId: fx.webhookId }),
    );
    expect(err.status).toBe(503);
  });
});

describe("Transaction Search", () => {
  it("queries with second-precision dates, pages through results and normalises +0000 dates", async () => {
    const stub = fetchStub([["GET", "/v1/reporting/transactions", { json: fx.transactionSearchPage(1, 2) }, { json: fx.transactionSearchPage(2, 2) }]]);
    const rows = await client(stub).searchTransactions({ start: new Date("2026-09-28T00:00:00.123Z"), end: new Date("2026-09-30T12:00:00Z") });
    expect(rows).toEqual([
      {
        id: "5TY05013RG002845M",
        amount: { currency: "USD", value: "38.50" },
        status: "COMPLETED",
        customId: "q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f-T_bcM5JjLk",
        time: "2026-09-30T04:03:52.000Z",
        invoiceId: "CS-RCPT-0001",
        eventCode: "T0003",
        statusCode: "S",
        fee: { currency: "USD", value: "-1.83" },
      },
      expect.objectContaining({ id: "9XG02315BV174352L", status: "REVERSED", eventCode: "T1107", amount: { currency: "USD", value: "-38.50" } }),
    ]);
    const [first, second] = stub.apiCalls();
    expect(Object.fromEntries(first!.url.searchParams)).toEqual({
      start_date: "2026-09-28T00:00:00Z",
      end_date: "2026-09-30T12:00:00Z",
      fields: "transaction_info",
      page_size: "500",
      page: "1",
    });
    expect(second!.url.searchParams.get("page")).toBe("2");
  });

  it("splits ranges longer than 31 days into separate windows", async () => {
    const stub = fetchStub([["GET", "/v1/reporting/transactions", { json: { transaction_details: [], total_pages: 0 } }]]);
    await client(stub).searchTransactions({ start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-30T00:00:00Z") });
    const windows = stub.apiCalls().map((c) => [c.url.searchParams.get("start_date"), c.url.searchParams.get("end_date")]);
    expect(windows).toHaveLength(2);
    for (const [s, e] of windows) expect(Date.parse(e!) - Date.parse(s!)).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);
    expect(windows[0]![0]).toBe("2026-08-01T00:00:00Z");
    expect(windows[1]![1]).toBe("2026-09-30T00:00:00Z");
    expect(Date.parse(windows[1]![0]!) - Date.parse(windows[0]![1]!)).toBe(1000); // no overlapping second

  });

  it("rejects inverted ranges locally", async () => {
    const stub = fetchStub([]);
    const err = await catchError(client(stub).searchTransactions({ start: new Date("2026-09-30"), end: new Date("2026-09-01") }));
    expect(err.name).toBe("CLIENT_VALIDATION_ERROR");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("headers", () => {
  it("adds PayPal-Partner-Attribution-Id when configured", async () => {
    const stub = fetchStub([["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    await client(stub, { partnerAttributionId: "GOODFAITH_SP" }).getOrder("A1");
    expect(stub.apiCalls()[0]!.headers["PayPal-Partner-Attribution-Id"]).toBe("GOODFAITH_SP");
    expect(stub.apiCalls()[0]!.headers.Accept).toBe("application/json");
  });
});
