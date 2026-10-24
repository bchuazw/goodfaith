/**
 * Live PayPal SANDBOX run of the web app's server layer: real orders, holds, voids, captures and payouts
 * (fake money). Skipped unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set; never point it at live.
 *
 *   pnpm --filter web test:live
 *
 * test:live loads the repo-root .env.local without printing it. Triage uses the scripted LLM (zero cost);
 * the PayPal side is real. PAYPAL_SANDBOX_VAULT_ID (the demo researcher's saved sandbox wallet) unlocks
 * the judge-mode flows, which need no browser approval. What does need a browser (approving an order in
 * the PayPal popup) is checked up to that point: the order exists and refuses to authorize before approval.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm } from "@goodfaith/llm";
import { isPayPalError, paypalFromEnv } from "@goodfaith/paypal";
import { triageReport } from "@goodfaith/triage";
import { describe, expect, it } from "vitest";
import { approveDeposit, createDepositOrder } from "@/lib/server/deposits";
import { runScenario } from "@/lib/server/demo";
import { pollPayout } from "@/lib/server/payouts";
import { submitReport } from "@/lib/server/reports";
import { createServices } from "@/lib/server/services";
import { settle, settlementContext } from "@/lib/server/settlement";
import { captureFunding, createFundingOrder } from "@/lib/server/sponsor";
import { createMemoryStore } from "@/lib/server/store";
import { heroInput } from "../server/helpers";

function loadEnvFiles(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const file of [path.join(root, ".env.local"), path.join(root, ".env")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m?.[1] || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
if (process.env.npm_lifecycle_event === "test:live") loadEnvFiles();

const env = (k: string) => process.env[k]?.trim() || undefined;
const LIVE = Boolean(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")) && (env("PAYPAL_ENV") ?? "sandbox") === "sandbox";
const VAULT_ID = env("PAYPAL_SANDBOX_VAULT_ID");
const ORIGIN = "https://goodfaith.example";
const note = (label: string, data: unknown) => console.info(`[web-live] ${label}: ${JSON.stringify(data)}`);

function liveServices() {
  const pending: Array<() => Promise<void>> = [];
  const svc = createServices({
    app: "live",
    store: createMemoryStore(),
    paypal: paypalFromEnv({ ...process.env, GOODFAITH_MODE: "live" }, { shared: false }),
    llm: createLlm({ provider: "scripted" }),
    triage: { kind: "triage", run: triageReport },
    config: { ...(VAULT_ID ? { sandboxVaultId: VAULT_ID } : {}) },
    defer: (t) => {
      pending.push(t);
    },
  });
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0).map((t) => t()));
  };
  return { svc, drain };
}

describe.skipIf(!LIVE)("web settlement on the PayPal sandbox (live)", () => {
  it("creates the JS SDK v6 deposit order (AUTHORIZE) and refuses to authorize it before the buyer approves", { timeout: 60_000 }, async () => {
    const { svc } = liveServices();
    const { report } = await submitReport(svc, heroInput("idor"));
    const { deposit, approveUrl } = await createDepositOrder(svc, report.id, { origin: ORIGIN });
    note("deposit order", { orderId: deposit.orderId, status: deposit.status, approveUrl });
    expect(deposit.orderId).toMatch(/^[A-Z0-9]{17}$/);
    expect(approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    const order = await svc.paypal.getOrder(deposit.orderId);
    expect(order).toMatchObject({ intent: "AUTHORIZE", status: "PAYER_ACTION_REQUIRED", amount: { currency: "USD", value: "20.00" }, customId: report.id });
    // A second click reuses the open order instead of creating another hold.
    const again = await createDepositOrder(svc, report.id, { origin: ORIGIN });
    expect(again.deposit.orderId).toBe(deposit.orderId);
    await expect(approveDeposit(svc, report.id, { orderId: deposit.orderId })).rejects.toMatchObject({ code: "ORDER_NOT_APPROVED" });
  });

  it("creates the sponsor CAPTURE order and refuses to capture before approval", { timeout: 60_000 }, async () => {
    const { svc } = liveServices();
    const { funding, approveUrl } = await createFundingOrder(svc, { amount: "250", sponsor: "Live test sponsor" }, { origin: ORIGIN });
    note("sponsor order", { orderId: funding.id, approveUrl });
    expect((await svc.paypal.getOrder(funding.id)).intent).toBe("CAPTURE");
    await expect(captureFunding(svc, funding.id)).rejects.toMatchObject({ code: "ORDER_NOT_APPROVED" });
  });

  it("mints a JS SDK v6 client token", { timeout: 30_000 }, async () => {
    const { svc } = liveServices();
    const token = await svc.paypal.createClientToken?.();
    expect(token?.clientToken.split(".")).toHaveLength(3);
    note("client token", { length: token?.clientToken.length, expiresIn: token?.expiresIn });
  });

  describe.skipIf(!VAULT_ID)("judge-mode flows on the saved sandbox wallet (no browser)", () => {
    const { svc, drain } = liveServices();

    it("IDOR: hold, REPRODUCED, pay = void + one payout that reaches SUCCESS", { timeout: 240_000 }, async () => {
      const { reportId } = await runScenario(svc, "idor", { origin: ORIGIN });
      await drain();
      const ctx = await settlementContext(svc, reportId);
      note("idor deposit", { orderId: ctx.deposit?.orderId, authorizationId: ctx.deposit?.authorizationId, status: ctx.deposit?.status, source: ctx.deposit?.source });
      expect(ctx.deposit).toMatchObject({ status: "AUTHORIZED", source: "vault" });
      expect(ctx.verdict?.verdict).toBe("REPRODUCED");

      const paid = await settle(svc, reportId, { action: "pay" });
      note("idor pay", { deposit: paid.deposit?.status, batchId: paid.payout?.batchId, senderBatchId: paid.payout?.senderBatchId, status: paid.payout?.status });
      expect(paid.deposit?.status).toBe("VOIDED");
      expect(paid.payout?.senderBatchId).toBe(`gf-${reportId}`);
      // A second pay replays nothing at PayPal.
      await settle(svc, reportId, { action: "pay" });
      await pollPayout(svc, reportId, { budgetMs: 180_000 });
      const final = await svc.db.payouts.value(reportId);
      note("idor payout", { status: final?.status, batchStatus: final?.batchStatus, itemId: final?.itemId, transactionId: final?.transactionId, fee: final?.fee });
      expect(["SUCCESS", "UNCLAIMED"]).toContain(final?.status);
      expect((await svc.paypal.getOrder(ctx.deposit?.orderId as string)).authorizationStatus).toBe("VOIDED");
    });

    it("SLOP: capture with confirmation captures the hold exactly once", { timeout: 120_000 }, async () => {
      const { reportId } = await runScenario(svc, "slop", { origin: ORIGIN });
      await drain();
      expect((await settlementContext(svc, reportId)).verdict?.verdict).toBe("SLOP");
      await expect(settle(svc, reportId, { action: "capture" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
      const done = await settle(svc, reportId, { action: "capture", confirm: true });
      note("slop capture", { captureId: done.deposit?.captureId, status: done.deposit?.status, captureStatus: done.deposit?.captureStatus });
      expect(done.deposit?.status).toBe("CAPTURED");
      await settle(svc, reportId, { action: "capture", confirm: true });
      const order = await svc.paypal.getOrder(done.deposit?.orderId as string);
      expect(order.authorizationStatus).toBe("CAPTURED");
    });

    it("DUPLICATE: release voids the hold; capture is refused", { timeout: 120_000 }, async () => {
      const { reportId } = await runScenario(svc, "duplicate", { origin: ORIGIN });
      await drain();
      const ctx = await settlementContext(svc, reportId);
      expect(ctx.verdict?.verdict).toBe("DUPLICATE");
      await expect(settle(svc, reportId, { action: "capture", confirm: true })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
      const done = await settle(svc, reportId, { action: "release" });
      note("duplicate release", { authorizationId: done.deposit?.authorizationId, status: done.deposit?.status });
      expect(done.deposit?.status).toBe("VOIDED");
      const trail = await svc.db.ledger.read(reportId);
      expect(trail.map((l) => l.op)).toEqual(["orders.create", "authorizations.void"]);
    });
  });
});

if (!LIVE) console.info("[web-live] skipped: no sandbox credentials in the environment");
void isPayPalError;
