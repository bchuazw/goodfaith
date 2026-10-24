import { describe, expect, it } from "vitest";
import { formatMoney, fromMinor, sumMoney, toMinor } from "@/lib/money";
import { appModeFromEnv, llmForMode, paypalForMode } from "@/lib/server/mode";
import { settle } from "@/lib/server/settlement";
import { captureFunding, createFundingOrder, poolBalance } from "@/lib/server/sponsor";
import { transparencyStats } from "@/lib/server/stats";
import { ORIGIN, testEnv, triagedClaim } from "./helpers";

describe("sponsor funding (CAPTURE order)", () => {
  it("creates a CAPTURE order, refuses to capture before approval, then captures once", async () => {
    const env = testEnv();
    const { funding, approveUrl } = await createFundingOrder(env.svc, { amount: "500", sponsor: "Lantern Foundation" }, { origin: ORIGIN });
    expect(funding).toMatchObject({ status: "CREATED", amount: { currency: "USD", value: "500.00" } });
    expect(approveUrl).toMatch(/\/checkoutnow\?token=/);
    await expect(captureFunding(env.svc, funding.id)).rejects.toMatchObject({ code: "ORDER_NOT_APPROVED" });
    env.paypal.simulateBuyerApproval(funding.id);
    const done = await captureFunding(env.svc, funding.id);
    expect(done).toMatchObject({ status: "COMPLETED", captureStatus: "COMPLETED" });
    await captureFunding(env.svc, funding.id);
    expect(env.paypal.events().filter((e) => e.action === "captureOrder" && !e.error)).toHaveLength(1);
    expect((await poolBalance(env.svc)).funded.value).toBe("500.00");
  });

  it("validates amounts", async () => {
    const env = testEnv();
    await expect(createFundingOrder(env.svc, { amount: "1.50", sponsor: "x y" }, { origin: ORIGIN })).rejects.toMatchObject({ code: "INVALID_FUNDING" });
    await expect(createFundingOrder(env.svc, { amount: "-5", sponsor: "Acme" }, { origin: ORIGIN })).rejects.toMatchObject({ code: "INVALID_FUNDING" });
  });
});

describe("transparency stats", () => {
  it("counts verdicts, deposits, payouts and the pool from the Store", async () => {
    const env = testEnv();
    const { funding } = await createFundingOrder(env.svc, { amount: "1000", sponsor: "Acme" }, { origin: ORIGIN });
    env.paypal.simulateBuyerApproval(funding.id);
    await captureFunding(env.svc, funding.id);
    const slop = await triagedClaim(env, "slop");
    const idor = await triagedClaim(env, "idor");
    const dup = await triagedClaim(env, "duplicate");
    await settle(env.svc, slop, { action: "capture", confirm: true });
    await settle(env.svc, idor, { action: "pay" });
    await settle(env.svc, dup, { action: "release" });
    await env.svc.paypal.getPayoutBatch?.((await env.svc.db.payouts.value(idor))?.batchId as string);
    const { refreshPayout } = await import("@/lib/server/payouts");
    await refreshPayout(env.svc, idor);

    const s = await transparencyStats(env.svc);
    expect(s).toMatchObject({ received: 3, triaged: 3, reproduced: 1, reproducedPct: 33, slop: 1, duplicates: 1, needsHuman: 0 });
    expect(s.depositsCaptured).toEqual({ count: 1, total: { currency: "USD", value: "20.00" } });
    expect(s.depositsReleased).toEqual({ count: 2, total: { currency: "USD", value: "40.00" } });
    expect(s.bountiesPaid).toEqual({ count: 1, total: { currency: "USD", value: "500.00" } });
    expect(s.hallOfFame).toEqual([{ handle: "mkdir_p", verified: 1, paid: { currency: "USD", value: "500.00" } }]);
    expect(s.medianTriageMs).not.toBeNull();
    expect(s.pool).toMatchObject({ funded: { value: "1000.00" }, paid: { value: "500.00" }, available: { value: "500.00" }, slopTax: { value: "20.00" } });
  });
});

describe("mode", () => {
  it("defaults to mock and rejects unknown modes", () => {
    expect(appModeFromEnv({})).toBe("mock");
    expect(appModeFromEnv({ GOODFAITH_MODE: " Live " })).toBe("live");
    expect(() => appModeFromEnv({ GOODFAITH_MODE: "prod" })).toThrow(/mock" or "live/);
  });

  it("mock mode uses the PayPal mock with the app's approval sheet, even with real credentials present", () => {
    const pp = paypalForMode("mock", { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_MOCK_SEED: "mode-test" });
    expect((pp as { mode?: string }).mode).toBe("mock");
    expect(llmForMode("mock", { ANTHROPIC_API_KEY: "sk-test" }).provider).toBe("scripted");
  });

  it("live mode fails loudly without PayPal credentials or an LLM key", () => {
    expect(() => paypalForMode("live", {})).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => paypalForMode("live", { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_MODE: "mock" })).toThrow(/PAYPAL_MODE=mock/);
    expect(() => llmForMode("live", {})).toThrow(/needs a real LLM/);
  });
});

describe("money", () => {
  it("does integer arithmetic on PayPal decimal strings", () => {
    expect(toMinor({ currency: "USD", value: "1500.00" })).toBe(150000);
    expect(toMinor({ currency: "USD", value: "0.1" })).toBe(10);
    expect(fromMinor(2025, "USD")).toEqual({ currency: "USD", value: "20.25" });
    expect(sumMoney([{ currency: "USD", value: "0.10" }, { currency: "USD", value: "0.20" }])).toEqual({ currency: "USD", value: "0.30" });
    expect(formatMoney({ currency: "USD", value: "1500.00" })).toBe("$1,500.00");
    expect(formatMoney({ currency: "USD", value: "20.00" }, { code: true })).toBe("$20.00 USD");
    expect(formatMoney({ currency: "JPY", value: "500" })).toBe("500 JPY");
  });
});
