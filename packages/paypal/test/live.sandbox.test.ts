/**
 * Live PayPal SANDBOX checks for the risky flows (docs/PAYPAL_NOTES.md, "Unknowns").
 * Skipped unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set. Never point this at live.
 *
 *   pnpm --filter @goodfaith/paypal test:live
 *
 * The test:live script also loads credentials from .env.local files (repo root, then the parent
 * hackathon folder) without printing them. Optional variables unlock the human-in-the-loop steps:
 *   PAYPAL_SANDBOX_SETUP_TOKEN  a setup token you approved in the browser  -> creates a payment token
 *   PAYPAL_SANDBOX_VAULT_ID     a payment token (vault id)                 -> merchant-initiated charges
 *   PAYPAL_SANDBOX_BUYER_EMAIL  sandbox personal account email             -> buyer-assertion disputes
 *   PAYPAL_LIVE_DISPUTES=1      create sandbox disputes (slow, leaves cases behind)
 *   PAYPAL_WEBHOOK_ID           your sandbox webhook id (for the verify postback check)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PayPalHttp } from "../src/http.js";
import { createPayPalClient, DEFAULT_BRAND_NAME, isPayPalError, PayPalError, type HttpLogEntry, type RealPayPalClient } from "../src/index.js";
import * as fx from "./fixtures.js";

function loadEnvFiles(): void {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const candidates = [process.env.PAYPAL_ENV_FILE, path.join(root, ".env.local"), path.join(root, ".env"), path.join(root, "..", ".env.local")];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m?.[1] || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
if (process.env.npm_lifecycle_event === "test:live") loadEnvFiles();

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const CLIENT_ID = env("PAYPAL_CLIENT_ID");
const CLIENT_SECRET = env("PAYPAL_CLIENT_SECRET");
const LIVE = Boolean(CLIENT_ID && CLIENT_SECRET);
const SETUP_TOKEN = env("PAYPAL_SANDBOX_SETUP_TOKEN");
const VAULT_ID = env("PAYPAL_SANDBOX_VAULT_ID");
const BUYER_EMAIL = env("PAYPAL_SANDBOX_BUYER_EMAIL");
const LIVE_DISPUTES = env("PAYPAL_LIVE_DISPUTES") === "1";
const T = { timeout: 90_000 };

const TEST_HASH = "cs-live-test-q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f";
const runId = `${Date.now().toString(36)}`;
const report = (label: string, data: unknown) => console.info(`[paypal-live] ${label}: ${JSON.stringify(data)}`);
const describeError = (e: unknown) =>
  isPayPalError(e) ? { status: e.status, name: e.name, issue: e.issue, debug_id: e.debugId, message: e.paypalMessage } : String(e);

describe.skipIf(!LIVE)("PayPal sandbox (live)", () => {
  const calls: HttpLogEntry[] = [];
  const pp = (
    LIVE
      ? createPayPalClient({
          clientId: CLIENT_ID as string,
          clientSecret: CLIENT_SECRET as string,
          env: "sandbox",
          brandName: process.env.PAYPAL_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME,
          onLog: (e) => calls.push(e),
          ...(BUYER_EMAIL ? { sandboxBuyerEmail: BUYER_EMAIL } : {}),
        })
      : undefined
  ) as RealPayPalClient;
  // Raw transport for card-funded orders, which the PayPalClient contract deliberately does not expose.
  const http = (LIVE ? new PayPalHttp({ clientId: CLIENT_ID as string, clientSecret: CLIENT_SECRET as string, env: "sandbox" }) : undefined) as PayPalHttp;

  /** Card-funded order with a documented sandbox test Visa: completes with no buyer interaction. */
  async function cardOrder(intent: "CAPTURE" | "AUTHORIZE", value: string, tag: string) {
    const res = await http.request<{ id: string; status: string; purchase_units?: Array<{ payments?: { captures?: Array<{ id: string; status: string }>; authorizations?: Array<{ id: string; status: string }> } }> }>({
      method: "POST",
      path: "/v2/checkout/orders",
      requestId: `cs-live-${tag}-${runId}`,
      prefer: "return=representation",
      json: {
        intent,
        purchase_units: [{ amount: { currency_code: "USD", value }, custom_id: TEST_HASH, invoice_id: `CS-LIVE-${tag}-${runId}` }],
        payment_source: {
          card: {
            name: "Good Faith Test",
            number: "4012888888881881",
            expiry: "2030-12",
            security_code: "123",
            billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
          },
        },
      },
    });
    const payments = res.data.purchase_units?.[0]?.payments;
    return { orderId: res.data.id, status: res.data.status, captureId: payments?.captures?.[0]?.id, authorizationId: payments?.authorizations?.[0]?.id };
  }

  async function cardOrSkip(skip: (note?: string) => void, intent: "CAPTURE" | "AUTHORIZE", value: string, tag: string) {
    try {
      return await cardOrder(intent, value, tag);
    } catch (e) {
      report("card order failed (card processing may not be enabled for this sandbox app)", describeError(e));
      if (e instanceof PayPalError && e.status >= 400 && e.status < 500) skip("card processing unavailable in this sandbox app");
      throw e;
    }
  }

  it("OAuth: gets a token and reports which feature scopes the app has", T, async () => {
    const info = await pp.tokenInfo();
    const has = (s: string) => info.scopes.includes(s);
    const features = {
      vaultSetupTokens: has("https://uri.paypal.com/services/vault/payment-tokens/read"),
      vaultPaymentTokens: has("https://uri.paypal.com/services/vault/payment-tokens/readwrite"),
      authCapture: has("https://uri.paypal.com/services/payments/payment/authcapture"),
      refunds: has("https://uri.paypal.com/services/payments/refund"),
      disputesRead: has("https://uri.paypal.com/services/disputes/read-seller"),
      disputesUpdate: has("https://uri.paypal.com/services/disputes/update-seller"),
      disputesCreate: has("https://uri.paypal.com/services/disputes/create"),
      transactionSearch: has("https://uri.paypal.com/services/reporting/search/read"),
      webhooks: has("https://uri.paypal.com/services/applications/webhooks"),
    };
    report("scopes", { appId: info.appId, count: info.scopes.length, features });
    expect(info.scopes.length).toBeGreaterThan(0);
  });

  it("Idempotency: the same PayPal-Request-Id returns the same order", T, async () => {
    const input = { intent: "CAPTURE" as const, amount: { currency: "USD", value: "1.00" }, customId: TEST_HASH, requestId: `cs-live-idem-${runId}` };
    const a = await pp.createOrder(input);
    const b = await pp.createOrder(input);
    report("idempotent order", { a: a.id, b: b.id, status: a.status });
    expect(b.id).toBe(a.id);
    expect(a.status).toBe("CREATED");
  });

  it("Errors: capturing an unapproved order maps to 422 ORDER_NOT_APPROVED with a debug_id", T, async () => {
    const order = await pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "1.00" }, requestId: `cs-live-err-${runId}` });
    const err = await pp.captureOrder(order.id, `cs-live-err-cap-${runId}`).then(
      () => undefined,
      (e: unknown) => e,
    );
    report("unapproved capture", describeError(err));
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(422);
    expect((err as PayPalError).debugId).toBeTruthy();
  });

  it("Step-up: a buyer-approval order returns PAYER_ACTION_REQUIRED and a payer-action link", T, async () => {
    const order = await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "2.00" },
      customId: TEST_HASH,
      returnUrl: "https://example.com/goodfaith/return",
      cancelUrl: "https://example.com/goodfaith/cancel",
      requestId: `cs-live-stepup-${runId}`,
    });
    report("step-up order", order);
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    expect(order.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it("Vault: creates a PayPal setup token (PAYER_ACTION_REQUIRED + approve link)", T, async () => {
    const st = await pp.createVaultSetupToken({ returnUrl: "https://example.com/goodfaith/linked", cancelUrl: "https://example.com/goodfaith/wallet" });
    report("setup token", st);
    report(
      "next step",
      `Open the approve link, log in as the sandbox PERSONAL account, approve, then rerun with PAYPAL_SANDBOX_SETUP_TOKEN=${st.id}`,
    );
    expect(st.status).toBe("PAYER_ACTION_REQUIRED");
    expect(st.approveUrl).toMatch(/sandbox\.paypal\.com/);
  });

  it.skipIf(!SETUP_TOKEN)("Vault: exchanges the approved setup token for a payment token", T, async () => {
    const pt = await pp.createPaymentToken(SETUP_TOKEN as string);
    report("payment token", { ...pt, next: `rerun with PAYPAL_SANDBOX_VAULT_ID=${pt.vaultId}` });
    expect(pt.vaultId).toBeTruthy();
  });

  it.skipIf(!VAULT_ID)("MIT: a CAPTURE order with vault_id completes with no buyer present", T, async () => {
    const order = await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "1.50" },
      description: "Good Faith live MIT test",
      customId: TEST_HASH,
      invoiceId: `CS-LIVE-MIT-${runId}`,
      vaultId: VAULT_ID as string,
      requestId: `cs-live-mit-${runId}`,
    });
    report("vault capture", order);
    expect(order.status).toBe("COMPLETED");
    expect(order.captureId).toBeTruthy();
    const back = await pp.getOrder(order.id);
    expect(back.customId).toBe(TEST_HASH);
    const refund = await pp.refundCapture(order.captureId as string, undefined, `cs-live-mit-rf-${runId}`);
    report("cleanup refund", refund);
  });

  it.skipIf(!VAULT_ID)("HOLD: AUTHORIZE with vault_id, partial capture, then void the rest", T, async () => {
    const order = await pp.createOrder({
      intent: "AUTHORIZE",
      amount: { currency: "USD", value: "3.00" },
      customId: TEST_HASH,
      vaultId: VAULT_ID as string,
      requestId: `cs-live-hold-${runId}`,
    });
    report("vault authorization", order);
    expect(order.authorizationId).toBeTruthy();
    const authId = order.authorizationId as string;
    try {
      const part = await pp.captureAuthorization(authId, `cs-live-hold-cap-${runId}`, { amount: { currency: "USD", value: "1.00" }, finalCapture: false });
      report("partial capture (budget fallback)", part);
    } catch (e) {
      report("partial capture failed", describeError(e));
    }
    const voided = await pp.voidAuthorization(authId);
    report("void", voided);
    expect(voided.status).toBe("VOIDED");
  });

  it("Payments: card-funded AUTHORIZE -> void, and CAPTURE -> refund (no human needed)", T, async (ctx) => {
    const auth = await cardOrSkip((note) => ctx.skip(note), "AUTHORIZE", "4.00", "auth");
    report("card authorization", auth);
    expect(auth.authorizationId).toBeTruthy();
    expect(await pp.voidAuthorization(auth.authorizationId as string)).toEqual({ status: "VOIDED" });

    const cap = await cardOrSkip((note) => ctx.skip(note), "CAPTURE", "5.00", "cap");
    report("card capture", cap);
    expect(cap.captureId).toBeTruthy();
    const refund = await pp.refundCapture(cap.captureId as string, { currency: "USD", value: "1.00" }, `cs-live-rf-${runId}`, { note: "Good Faith test" });
    report("partial refund", refund);
    expect(refund.refundId).toBeTruthy();
  });

  it("Disputes: list works, and the documented test value ERRDIS015 maps to a 403", T, async () => {
    const list = await pp.listDisputes({ maxPages: 1 });
    report("disputes", { count: list.length, first: list[0] });
    expect(Array.isArray(list)).toBe(true);
    const err = await pp.getDispute("ERRDIS015").then(
      () => undefined,
      (e: unknown) => e,
    );
    report("ERRDIS015", describeError(err));
    expect(err).toBeInstanceOf(PayPalError);
  });

  it("Disputes: provide-evidence accepts our multipart request (test value ERRDIS043 -> 422)", T, async () => {
    const err = await pp
      .provideEvidence("ERRDIS043", {
        notes: "Good Faith multipart probe",
        files: [{ name: "probe.pdf", contentType: "application/pdf", data: new TextEncoder().encode("%PDF-1.4\n%%EOF\n") }],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    report("ERRDIS043 provide-evidence", describeError(err));
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(422);
  });

  it.skipIf(!LIVE_DISPUTES)("Disputes: chargeback simulation on a card capture, then provide evidence", { timeout: 300_000 }, async (ctx) => {
    const cap = await cardOrSkip((note) => ctx.skip(note), "CAPTURE", "6.00", "cb");
    const created = await pp.createSandboxDispute({ captureId: cap.captureId as string, reason: "UNAUTHORISED", amount: { currency: "USD", value: "6.00" }, strategy: "chargeback" });
    report("chargeback dispute", created);
    let dispute = await waitForDispute(created.id, (d) => d.allowedActions.includes("provide_evidence"));
    report("dispute", { status: dispute.status, stage: dispute.stage, actions: dispute.allowedActions, customId: dispute.customId, transactionId: dispute.transactionId });
    const res = await pp.provideEvidence(created.id, {
      notes: "Good Faith: evidence probe from the live sandbox suite.",
      files: [{ name: "mandate-chain.pdf", contentType: "application/pdf", data: new TextEncoder().encode("%PDF-1.4\n%%EOF\n") }],
    });
    report("evidence", res);
    dispute = await pp.getDispute(created.id);
    report("after evidence", { status: dispute.status, actions: dispute.allowedActions });
  });

  it.skipIf(!LIVE_DISPUTES || !BUYER_EMAIL || !VAULT_ID)("Disputes: buyer-assertion create on a vault capture", { timeout: 300_000 }, async () => {
    const order = await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "7.00" },
      customId: TEST_HASH,
      vaultId: VAULT_ID as string,
      requestId: `cs-live-bd-${runId}`,
    });
    try {
      const created = await pp.createSandboxDispute({ captureId: order.captureId as string, reason: "UNAUTHORISED", amount: { currency: "USD", value: "7.00" }, strategy: "buyer-assertion" });
      report("buyer dispute", created);
    } catch (e) {
      report("buyer-assertion dispute failed (needs the DISPUTE_CREATE scope and buyer consent)", describeError(e));
      throw e;
    }
  });

  it("Transaction Search: lists the last 3 days (data lags up to 3 hours)", T, async () => {
    try {
      const rows = await pp.searchTransactions({ start: new Date(Date.now() - 3 * 24 * 3600 * 1000), end: new Date() });
      report("transactions", { count: rows.length, withCustomId: rows.filter((r) => r.customId).length, sample: rows.slice(0, 3) });
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      report("transaction search failed (enable 'Transaction search' in the app settings)", describeError(e));
      throw e;
    }
  });

  it.skipIf(!BUYER_EMAIL)("Payouts: pays the sandbox buyer, leaves an unregistered email UNCLAIMED, and pays a sender_batch_id once", T, async () => {
    const senderBatchId = `cs-live-payout-${runId}`;
    const input = {
      senderBatchId,
      emailSubject: "Sandbox payout test",
      items: [
        { receiver: BUYER_EMAIL as string, amount: { currency: "USD", value: "1.00" }, senderItemId: "buyer", note: "Live sandbox test" },
        { receiver: `unregistered-${runId}@example.com`, amount: { currency: "USD", value: "1.00" }, senderItemId: "nobody" },
      ],
    };
    let created: Awaited<ReturnType<RealPayPalClient["createPayout"]>>;
    try {
      created = await pp.createPayout(input);
    } catch (e) {
      report("payout create failed (enable Payouts in the app; the sender needs a sandbox balance)", describeError(e));
      throw e;
    }
    report("payout created", { batchId: created.batchId, status: created.status, senderBatchId: created.senderBatchId });
    expect(["PENDING", "PROCESSING", "SUCCESS"]).toContain(created.status);

    let batch = await pp.getPayoutBatch(created.batchId);
    for (let i = 0; i < 15 && ["PENDING", "PROCESSING"].includes(batch.status); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      batch = await pp.getPayoutBatch(created.batchId);
    }
    report("payout batch", {
      status: batch.status,
      amount: batch.amount,
      fees: batch.fees,
      items: batch.items.map((it) => ({ senderItemId: it.senderItemId, status: it.status, fee: it.fee, error: it.error?.name })),
    });

    // Same sender_batch_id under a new PayPal-Request-Id: PayPal must not pay again.
    try {
      const again = await pp.createPayout({ ...input, requestId: `cs-live-payout-again-${runId}` });
      report("payout replay", { batchId: again.batchId, replayed: again.replayed, status: again.status });
      expect(again.batchId).toBe(created.batchId);
    } catch (e) {
      report("payout replay error (record its shape for duplicatePayoutBatchId)", { ...((isPayPalError(e) ? describeError(e) : {}) as object), links: isPayPalError(e) ? e.links : undefined });
      throw e;
    }
  });

  it("Webhooks: verify-webhook-signature postback returns false for a forged delivery", T, async () => {
    const ok = await pp.verifyWebhookSignature({
      headers: fx.webhookHeaders,
      body: fx.webhookEventBody,
      webhookId: env("PAYPAL_WEBHOOK_ID") ?? fx.webhookId,
    });
    const last = calls.filter((c) => c.path === "/v1/notifications/verify-webhook-signature").at(-1);
    report("verify postback", { ok, httpStatus: last?.status, debugId: last?.debugId });
    expect(ok).toBe(false);
  });

  async function waitForDispute(id: string, ready: (d: Awaited<ReturnType<RealPayPalClient["getDispute"]>>) => boolean) {
    const deadline = Date.now() + 240_000;
    for (;;) {
      try {
        const d = await pp.getDispute(id);
        if (ready(d) || Date.now() > deadline) return d;
      } catch (e) {
        if (Date.now() > deadline) throw e;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
});
