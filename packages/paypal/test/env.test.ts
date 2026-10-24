import { describe, expect, it } from "vitest";
import { isMockPayPal, paypalFromEnv, type RealPayPalClient } from "../src/index.js";

const creds = { PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret" };

describe("paypalFromEnv", () => {
  it("falls back to the mock when credentials are missing or blank", () => {
    expect(isMockPayPal(paypalFromEnv({}, { shared: false }))).toBe(true);
    expect(isMockPayPal(paypalFromEnv({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "  " }, { shared: false }))).toBe(true);
  });

  it("uses the real sandbox client when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET exist", () => {
    const pp = paypalFromEnv(creds, { shared: false }) as RealPayPalClient;
    expect(isMockPayPal(pp)).toBe(false);
    expect(pp.mode).toBe("paypal");
    expect(pp.env).toBe("sandbox");
  });

  it("forces the mock in GOODFAITH_MODE=mock or PAYPAL_MODE=mock even with credentials", () => {
    expect(isMockPayPal(paypalFromEnv({ ...creds, GOODFAITH_MODE: "mock" }, { shared: false }))).toBe(true);
    expect(isMockPayPal(paypalFromEnv({ ...creds, PAYPAL_MODE: "MOCK" }, { shared: false }))).toBe(true);
  });

  it("never falls back to the mock when GOODFAITH_MODE=live", () => {
    expect(() => paypalFromEnv({ GOODFAITH_MODE: "live", PAYPAL_CLIENT_ID: "id" }, { shared: false })).toThrow(/GOODFAITH_MODE=live/);
    expect(isMockPayPal(paypalFromEnv({ ...creds, GOODFAITH_MODE: "live" }, { shared: false }))).toBe(false);
  });

  it("refuses live PayPal unless PAYPAL_ALLOW_LIVE=true", () => {
    expect(() => paypalFromEnv({ ...creds, PAYPAL_ENV: "live" }, { shared: false })).toThrow(/PAYPAL_ALLOW_LIVE/);
    const live = paypalFromEnv({ ...creds, PAYPAL_ENV: "production", PAYPAL_ALLOW_LIVE: "true" }, { shared: false }) as RealPayPalClient;
    expect(live.env).toBe("live");
  });

  it("shares one instance per configuration so mock state survives across route handlers", async () => {
    const env = { PAYPAL_MOCK_SEED: "shared-test-seed" };
    const a = paypalFromEnv(env);
    const b = paypalFromEnv({ ...env });
    expect(a).toBe(b);
    const st = await a.createVaultSetupToken({ returnUrl: "https://cs.example/r", cancelUrl: "https://cs.example/c" });
    if (!isMockPayPal(b)) throw new Error("expected mock");
    expect(b.simulateBuyerApproval(st.id).status).toBe("APPROVED");
    expect(paypalFromEnv(env, { shared: false })).not.toBe(a);
    expect(paypalFromEnv(creds)).toBe(paypalFromEnv(creds));
  });

  it("passes mock options through", async () => {
    const pp = paypalFromEnv({ PAYPAL_MOCK_FAIL_VAULT: "1", PAYPAL_MOCK_WEB_BASE_URL: "https://cs.example/mock-paypal" }, { shared: false });
    const st = await pp.createVaultSetupToken({ returnUrl: "https://cs.example/r", cancelUrl: "https://cs.example/c" });
    expect(st.approveUrl.startsWith("https://cs.example/mock-paypal/agreements/approve")).toBe(true);
  });

  it("reads process.env when no env object is given", () => {
    const keys = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "GOODFAITH_MODE", "PAYPAL_MOCK_SEED"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      process.env.PAYPAL_MOCK_SEED = "from-process-env";
      expect(isMockPayPal(paypalFromEnv(undefined, { shared: false }))).toBe(true);
    } finally {
      for (const k of keys) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
