import { describe, expect, it } from "vitest";
import { createMockPayPal, createPayPalClient, type HttpLogEntry, PayPalError } from "../src/index.js";
import { fetchStub } from "./fetch-stub.js";
import * as fx from "./fixtures.js";

const CLIENT_ID = "AZgbuZOSPtbrHZsk4VGxP19QodU3VOuGTyPHaE6I6BUVoMu2oJzHdLFyW7FjowYZlgUhI8ydsqxzFP-I";
const CLIENT_SECRET = "EBWKjlELKMYqRNQ6sYvFo64FtaRLRR5BdHEESmha49TM-super-secret";

/** PayPal's documented client-token response: the same shape as an access token, a different token. */
const clientTokenResponse = {
  access_token: "eyJraWQiOiJjbGllbnQtdG9rZW4ifQ.eyJpc3MiOiJodHRwczovL2FwaS1tLnNhbmRib3gucGF5cGFsLmNvbSJ9.c2lnbmF0dXJl",
  app_id: "APP-80W284485P519543T",
  expires_in: 900,
  nonce: "2026-10-24T03:00:00Z0123456789",
  scope: "https://uri.paypal.com/services/payments/realtimepayment",
  token_type: "Bearer",
};

function tokenRoute() {
  return [
    "POST",
    "/v1/oauth2/token",
    (call: { text: string }) => ({
      status: 200,
      json: new URLSearchParams(call.text).get("response_type") === "client_token" ? clientTokenResponse : fx.oauthToken,
    }),
  ] as [string, string, (call: { text: string }) => { status: number; json: unknown }];
}

function client(stub: ReturnType<typeof fetchStub>, extra: Partial<Parameters<typeof createPayPalClient>[0]> = {}) {
  return createPayPalClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, env: "sandbox", fetch: stub.fetch, retryBaseDelayMs: 0, ...extra });
}

describe("createClientToken (JS SDK v6 browser-safe token)", () => {
  it("requests response_type=client_token with Basic auth and returns the token and lifetime", async () => {
    const stub = fetchStub([tokenRoute()]);
    const result = await client(stub).createClientToken();

    expect(result).toEqual({ clientToken: clientTokenResponse.access_token, expiresIn: 900 });
    const calls = stub.to("POST", "/v1/oauth2/token");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.origin).toBe("https://api-m.sandbox.paypal.com");
    expect(call.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.text);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("response_type")).toBe("client_token");
    expect(form.has("domains[]")).toBe(false);
  });

  it("sends domains[] as one comma-separated field, as PayPal documents it", async () => {
    const stub = fetchStub([tokenRoute()]);
    await client(stub).createClientToken({ domains: ["goodfaith.example", "demo.goodfaith.dev"] });
    const form = new URLSearchParams(stub.to("POST", "/v1/oauth2/token")[0]!.text);
    expect(form.getAll("domains[]")).toEqual(["goodfaith.example,demo.goodfaith.dev"]);
  });

  it("rejects domains that would corrupt the comma-separated list, before any call", async () => {
    const stub = fetchStub([tokenRoute()]);
    // The sandbox answers 401 invalid_domain for a scheme, a port or a dotless host (checked 2026-10-24).
    for (const bad of ["a.example,b.example", "https://goodfaith.example", "goodfaith.example/path", "localhost", "localhost:3000", "two words", ""]) {
      const err = await client(stub).createClientToken({ domains: [bad] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayPalError);
      expect((err as PayPalError).name).toBe("CLIENT_VALIDATION_ERROR");
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("mints a fresh token per call and never hands out or replaces the cached server token", async () => {
    const stub = fetchStub([tokenRoute(), ["GET", /^\/v2\/checkout\/orders\//, { json: fx.orderCaptured }]]);
    const pp = client(stub);
    await pp.getOrder("5O190127TN364715T"); // caches the server access token
    const a = await pp.createClientToken();
    const b = await pp.createClientToken();
    await pp.getOrder("5O190127TN364715T");

    expect(a.clientToken).not.toBe(fx.oauthToken.access_token);
    expect(b.clientToken).toBe(a.clientToken);
    const grants = stub.to("POST", "/v1/oauth2/token").map((c) => new URLSearchParams(c.text).get("response_type"));
    expect(grants).toEqual([null, "client_token", "client_token"]);
    for (const c of stub.apiCalls()) expect(c.headers.Authorization).toBe(`Bearer ${fx.oauthToken.access_token}`);
  });

  it("maps OAuth failures to PayPalError without leaking the secret", async () => {
    const stub = fetchStub([["POST", "/v1/oauth2/token", { status: 401, json: fx.errors.invalidClient }]]);
    const logs: HttpLogEntry[] = [];
    const err = (await client(stub, { onLog: (e) => logs.push(e) }).createClientToken().catch((e: unknown) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(err.name).toBe("invalid_client");
    const serialized = JSON.stringify({ message: err.message, json: err.toJSON(), stack: err.stack, logs });
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(logs).toEqual([expect.objectContaining({ method: "POST", path: "/v1/oauth2/token", status: 401 })]);
  });

  it("retries a 5xx token response like the server token request", async () => {
    const stub = fetchStub([
      ["POST", "/v1/oauth2/token", { status: 503, json: { name: "SERVICE_UNAVAILABLE", message: "try later", debug_id: "x" } }, { status: 200, json: clientTokenResponse }],
    ]);
    const result = await client(stub).createClientToken();
    expect(result.clientToken).toBe(clientTokenResponse.access_token);
    expect(stub.to("POST", "/v1/oauth2/token")).toHaveLength(2);
  });
});

describe("mock createClientToken", () => {
  it("returns a recognisable placeholder and records the call", async () => {
    const mock = createMockPayPal({ seed: "client-token" });
    const t = await mock.createClientToken({ domains: ["goodfaith.example"] });
    expect(t.clientToken.startsWith("MOCK-CLIENT-TOKEN.")).toBe(true);
    expect(t.expiresIn).toBe(900);
    expect(mock.events().map((e) => e.action)).toContain("createClientToken");
    await expect(mock.createClientToken({ domains: ["a.example,b.example"] })).rejects.toMatchObject({ name: "CLIENT_VALIDATION_ERROR" });
    await expect(mock.createClientToken({ domains: ["localhost:3000"] })).rejects.toMatchObject({ name: "CLIENT_VALIDATION_ERROR" });
  });
});
