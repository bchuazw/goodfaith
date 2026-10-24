import { describe, expect, it } from "vitest";
import { approveDeposit, createDepositOrder } from "@/lib/server/deposits";
import { HERO_REPORTS } from "@/lib/hero-reports";
import { submitReport } from "@/lib/server/reports";
import { settle, settlementContext } from "@/lib/server/settlement";
import { createFundingOrder } from "@/lib/server/sponsor";
import { handleWebhook } from "@/lib/server/webhooks";
import { heroInput, ORIGIN, testEnv, triagedClaim } from "./helpers";

describe("webhook handler", () => {
  it("rejects tampered or unsigned deliveries and ignores duplicates", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "duplicate").catch(() => undefined);
    void id;
    await env.paypal.flushWebhooks();
    const delivery = env.paypal.webhooks().at(-1);
    expect(delivery).toBeDefined();
    if (!delivery) return;

    const tampered = delivery.body.replace(/"summary":"[^"]*"/, '"summary":"forged"');
    expect(await handleWebhook(env.svc, { headers: delivery.headers, body: tampered })).toMatchObject({ status: 400 });
    expect(await handleWebhook(env.svc, { headers: {}, body: delivery.body })).toMatchObject({ status: 400 });

    const first = await handleWebhook(env.svc, { headers: delivery.headers, body: delivery.body });
    expect(first.status).toBe(200);
    expect(await handleWebhook(env.svc, { headers: delivery.headers, body: delivery.body })).toEqual({ status: 200, outcome: "Duplicate delivery ignored" });
    expect((await env.svc.db.webhooks.value(delivery.event.id))?.outcome).toBe(first.outcome);
  });

  it("CHECKOUT.ORDER.APPROVED authorizes the deposit and starts triage even if the browser never calls back", async () => {
    const env = testEnv({ webhooks: true });
    const { report } = await submitReport(env.svc, heroInput("idor"));
    const { deposit } = await createDepositOrder(env.svc, report.id, { origin: ORIGIN });
    env.paypal.simulateBuyerApproval(deposit.orderId, { email: HERO_REPORTS.idor.payoutEmail });
    await env.paypal.flushWebhooks(); // CHECKOUT.ORDER.APPROVED -> approveDeposit (deferred)
    await env.drain();
    await env.paypal.flushWebhooks();
    const ctx = await settlementContext(env.svc, report.id);
    expect(ctx.deposit?.status).toBe("AUTHORIZED");
    expect(ctx.verdict?.verdict).toBe("REPRODUCED");

    // The browser's late onApprove is harmless: same hold, no second authorization.
    await approveDeposit(env.svc, report.id, { orderId: deposit.orderId });
    expect(env.paypal.events().filter((e) => e.action === "authorizeOrder" && !e.error)).toHaveLength(1);
  });

  it("payout webhooks update the payout record", async () => {
    const env = testEnv({ webhooks: true });
    const id = await triagedClaim(env, "idor");
    await settle(env.svc, id, { action: "pay" });
    await env.svc.paypal.getPayoutBatch?.((await env.svc.db.payouts.value(id))?.batchId as string); // the mock settles the batch on first read
    await env.paypal.flushWebhooks();
    const payout = await env.svc.db.payouts.value(id);
    expect(payout?.status).toBe("SUCCESS");
    expect(payout?.batchStatus).toBe("SUCCESS");
    const trail = await env.svc.db.ledger.read(id);
    expect(trail.some((l) => l.op === "webhook" && l.summary.includes("PAYMENT.PAYOUTSBATCH.SUCCESS"))).toBe(true);
  });

  it("a void made outside Good Faith (PayPal dashboard) is recorded from PAYMENT.AUTHORIZATION.VOIDED", async () => {
    const env = testEnv({ webhooks: true });
    const id = await triagedClaim(env, "slop");
    const dep = await env.svc.db.deposits.value(id);
    await env.paypal.voidAuthorization(dep?.authorizationId as string);
    await env.paypal.flushWebhooks();
    const after = await env.svc.db.deposits.value(id);
    expect(after).toMatchObject({ status: "VOIDED", resolution: { action: "void", requestId: "external" } });
  });

  it("a sponsor's approved order is captured from the webhook", async () => {
    const env = testEnv({ webhooks: true });
    const { funding } = await createFundingOrder(env.svc, { amount: "250", sponsor: "Acme Security" }, { origin: ORIGIN });
    env.paypal.simulateBuyerApproval(funding.id);
    await env.paypal.flushWebhooks();
    await env.drain();
    expect((await env.svc.db.fundings.value(funding.id))?.status).toBe("COMPLETED");
  });

  it("refuses everything when no webhook id is configured (live without PAYPAL_WEBHOOK_ID)", async () => {
    const env = testEnv();
    const live = { ...env.svc, paypal: { ...env.svc.paypal, mode: "paypal" } as typeof env.svc.paypal, config: { ...env.svc.config } };
    expect(await handleWebhook(live, { headers: {}, body: "{}" })).toMatchObject({ status: 503 });
  });
});

describe("payout status ordering", () => {
  it("never moves a payout backwards when deliveries arrive out of order", async () => {
    const { applyPayoutBatch } = await import("@/lib/server/payouts");
    const env = testEnv();
    const id = await triagedClaim(env, "idor");
    await settle(env.svc, id, { action: "pay" });
    const p = await env.svc.db.payouts.value(id);
    const batch = await env.svc.paypal.getPayoutBatch?.(p?.batchId as string);
    await applyPayoutBatch(env.svc, id, batch as NonNullable<typeof batch>);
    expect((await env.svc.db.payouts.value(id))?.status).toBe("SUCCESS");
    // A late PROCESSING/PENDING view of the same batch must not undo SUCCESS.
    await applyPayoutBatch(env.svc, id, { batchId: p?.batchId as string, status: "PROCESSING", items: [{ ...(batch?.items[0] as NonNullable<typeof batch>["items"][number]), status: "PENDING" }] });
    expect(await env.svc.db.payouts.value(id)).toMatchObject({ status: "SUCCESS", batchStatus: "SUCCESS" });
  });
});
