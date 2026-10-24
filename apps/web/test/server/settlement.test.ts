import type { PayPalClient } from "@goodfaith/paypal";
import { createMockPayPal, PayPalError } from "@goodfaith/paypal";
import { describe, expect, it } from "vitest";
import { createDepositOrder } from "@/lib/server/deposits";
import { AppError } from "@/lib/server/errors";
import { pollPayout } from "@/lib/server/payouts";
import { submitReport } from "@/lib/server/reports";
import { createServices } from "@/lib/server/services";
import { settle, settlementContext, settlementOptions } from "@/lib/server/settlement";
import { createMemoryStore } from "@/lib/server/store";
import { apiCalls, heroInput, testEnv, triagedClaim } from "./helpers";

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

describe("hero flows end to end (mock PayPal, @goodfaith/triage with the scripted LLM, real Lantern runner)", () => {
  it("REPRODUCED IDOR: pay voids the deposit, then pays the bounty once with senderBatchId gf-<id>", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "idor");
    const before = await settlementContext(env.svc, id);
    expect(before.verdict?.verdict).toBe("REPRODUCED");
    expect(before.verdict?.replay?.canaryHits[0]?.label).toBe("Bob's private note");
    expect(before.report.status).toBe("triaged");
    expect(before.deposit?.status).toBe("AUTHORIZED");
    expect(settlementOptions(before)).toMatchObject({ pay: { allowed: true }, release: { allowed: true }, capture: { allowed: false } });

    const after = await settle(env.svc, id, { action: "pay" });
    expect(after.report.status).toBe("settled");
    expect(after.report.settlement).toMatchObject({ action: "pay", status: "done", severity: "high", amount: { currency: "USD", value: "500.00" } });
    expect(after.deposit?.status).toBe("VOIDED");
    expect(after.payout).toMatchObject({ senderBatchId: `gf-${id}`, receiver: "mkdir.p.research@example.com", amount: { value: "500.00" } });
    expect(apiCalls(env.paypal, "voidAuthorization")).toHaveLength(1);
    expect(apiCalls(env.paypal, "createPayout")).toHaveLength(1);

    // Paying again is a no-op: no second void, no second payout.
    await settle(env.svc, id, { action: "pay" });
    expect(apiCalls(env.paypal, "voidAuthorization")).toHaveLength(1);
    expect(apiCalls(env.paypal, "createPayout")).toHaveLength(1);

    await pollPayout(env.svc, id, { sleep: async () => {} });
    const final = await settlementContext(env.svc, id);
    expect(final.payout?.status).toBe("SUCCESS");
    expect(final.payout?.transactionId).toBeTruthy();
    const trail = await env.svc.db.ledger.read(id);
    expect(trail.map((l) => l.op)).toEqual(["orders.create", "orders.authorize", "authorizations.void", "payouts.create", "payouts.get"]);
  });

  it("SLOP: capture needs explicit confirmation, then captures exactly once", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "slop");
    const ctx = await settlementContext(env.svc, id);
    expect(ctx.verdict?.verdict).toBe("SLOP");
    expect(ctx.verdict?.findings.some((f) => f.kind === "injection" && f.status === "fail")).toBe(true);
    expect(ctx.verdict?.findings.some((f) => f.kind === "code_ref" && f.status === "fail" && f.title.includes("src/session.ts"))).toBe(true);
    expect(settlementOptions(ctx).capture).toEqual({ allowed: true, needs: "confirm" });

    expect((await refusal(settle(env.svc, id, { action: "capture" }))).code).toBe("CONFIRMATION_REQUIRED");
    expect((await refusal(settle(env.svc, id, { action: "capture", confirm: false }))).code).toBe("CONFIRMATION_REQUIRED");
    expect(apiCalls(env.paypal, "captureAuthorization")).toHaveLength(0);

    const done = await settle(env.svc, id, { action: "capture", confirm: true });
    expect(done.deposit).toMatchObject({ status: "CAPTURED", resolution: { action: "capture" } });
    expect(done.deposit?.captureId).toBeTruthy();
    expect(done.report.settlement).toMatchObject({ action: "capture", status: "done", amount: { value: "20.00" } });

    await settle(env.svc, id, { action: "capture", confirm: true }); // idempotent
    expect(apiCalls(env.paypal, "captureAuthorization")).toHaveLength(1);
    expect((await refusal(settle(env.svc, id, { action: "release" }))).code).toBe("ACTION_NOT_ALLOWED");
    expect(apiCalls(env.paypal, "voidAuthorization")).toHaveLength(0);
  });

  it("DUPLICATE: release voids the deposit; capture is refused because the verdict is not SLOP", async () => {
    const env = testEnv();
    await triagedClaim(env, "idor");
    const id = await triagedClaim(env, "duplicate");
    const ctx = await settlementContext(env.svc, id);
    expect(ctx.verdict?.verdict).toBe("DUPLICATE");
    expect(ctx.verdict?.duplicateOf).toBeTruthy();
    expect(settlementOptions(ctx).capture.allowed).toBe(false);
    expect((await refusal(settle(env.svc, id, { action: "capture", confirm: true }))).code).toBe("ACTION_NOT_ALLOWED");

    const done = await settle(env.svc, id, { action: "release", note: "Thanks: this was already reported." });
    expect(done.deposit?.status).toBe("VOIDED");
    expect(done.report.settlement).toMatchObject({ action: "release", status: "done", note: "Thanks: this was already reported." });
    expect(apiCalls(env.paypal, "captureAuthorization")).toHaveLength(0);
  });
});

describe("money rules", () => {
  it("pay without REPRODUCED needs a typed override reason", async () => {
    const env = testEnv();
    await triagedClaim(env, "idor");
    const id = await triagedClaim(env, "duplicate");
    expect(settlementOptions(await settlementContext(env.svc, id)).pay).toMatchObject({ allowed: true, needs: "override" });
    expect((await refusal(settle(env.svc, id, { action: "pay" }))).code).toBe("OVERRIDE_REASON_REQUIRED");
    expect((await refusal(settle(env.svc, id, { action: "pay", overrideReason: "  ok  " }))).code).toBe("OVERRIDE_REASON_REQUIRED");
    expect(apiCalls(env.paypal, "createPayout")).toHaveLength(0);

    const done = await settle(env.svc, id, { action: "pay", severity: "medium", overrideReason: "Different root cause in the same handler; verified by hand." });
    expect(done.report.settlement).toMatchObject({ action: "pay", status: "done", severity: "medium", amount: { value: "200.00" }, overrideReason: expect.stringContaining("verified by hand") });
    expect(done.payout?.amount.value).toBe("200.00");
  });

  it("capture needs a SLOP verdict, even with confirmation", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "idor");
    expect((await refusal(settle(env.svc, id, { action: "capture", confirm: true }))).code).toBe("ACTION_NOT_ALLOWED");
    expect(apiCalls(env.paypal, "captureAuthorization")).toHaveLength(0);
  });

  it("free reports have no money actions at all", async () => {
    const env = testEnv();
    const { report, depositRequired } = await submitReport(env.svc, heroInput("idor", "free"));
    expect(depositRequired).toBe(false);
    await env.drain();
    const ctx = await settlementContext(env.svc, report.id);
    expect(ctx.report.status).toBe("triaged");
    expect(ctx.deposit).toBeUndefined();
    for (const action of ["pay", "release", "capture"] as const) {
      expect(settlementOptions(ctx)[action].allowed).toBe(false);
      expect((await refusal(settle(env.svc, report.id, { action, confirm: true }))).code).toBe("ACTION_NOT_ALLOWED");
    }
  });

  it("nothing settles while the deposit is unapproved", async () => {
    const env = testEnv();
    const { report } = await submitReport(env.svc, heroInput("slop"));
    await createDepositOrder(env.svc, report.id, { origin: "http://localhost:3000" });
    expect((await refusal(settle(env.svc, report.id, { action: "release" }))).code).toBe("ACTION_NOT_ALLOWED");
  });

  it("rejects unknown actions", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "slop");
    expect((await refusal(settle(env.svc, id, { action: "refund" }))).code).toBe("INVALID_ACTION");
  });
});

describe("races between instances (shared Store, no shared memory)", () => {
  it("release and capture racing on the same SLOP deposit: exactly one resolution reaches PayPal", async () => {
    const store = createMemoryStore();
    const paypal = createMockPayPal({ seed: "race-1" });
    const a = testEnv({ store, paypal });
    const b = testEnv({ store, paypal });
    const id = await triagedClaim(a, "slop");

    const results = await Promise.allSettled([settle(a.svc, id, { action: "release" }), settle(b.svc, id, { action: "capture", confirm: true })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["ALREADY_SETTLING", "DEPOSIT_ALREADY_RESOLVED", "ACTION_NOT_ALLOWED"]).toContain((rejected.reason as AppError).code);
    expect(apiCalls(paypal, "voidAuthorization").length + apiCalls(paypal, "captureAuthorization").length).toBe(1);
    const ctx = await settlementContext(a.svc, id);
    expect(["VOIDED", "CAPTURED"]).toContain(ctx.deposit?.status);
  });

  it("two pays racing create one payout batch", async () => {
    const store = createMemoryStore();
    const paypal = createMockPayPal({ seed: "race-2" });
    const a = testEnv({ store, paypal });
    const b = testEnv({ store, paypal });
    const id = await triagedClaim(a, "idor");
    await Promise.allSettled([settle(a.svc, id, { action: "pay" }), settle(b.svc, id, { action: "pay" })]);
    const batches = new Set(apiCalls(paypal, "createPayout").map((e) => e.id));
    expect(batches.size).toBe(1);
    const payout = await a.svc.db.payouts.value(id);
    expect(payout?.senderBatchId).toBe(`gf-${id}`);
    expect((await settlementContext(a.svc, id)).report.settlement?.status).toBe("done");
  });
});

describe("crash and failure recovery", () => {
  /** A PayPal client whose next voidAuthorization fails like a network error. */
  function flakyVoid(base: PayPalClient): PayPalClient & { failNext: boolean } {
    const wrapper = Object.create(base) as PayPalClient & { failNext: boolean };
    wrapper.failNext = true;
    wrapper.voidAuthorization = async (id, opts) => {
      if (wrapper.failNext) {
        wrapper.failNext = false;
        throw new PayPalError({ status: 0, name: "NETWORK_ERROR", message: "could not reach PayPal" });
      }
      return base.voidAuthorization(id, opts);
    };
    return wrapper;
  }

  it("a failed release stays a release: capture is refused, and retrying the release completes it", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "slop");
    const flaky = flakyVoid(env.paypal);
    const svc = createServices({ ...env.svc, app: "mock", store: env.store, paypal: flaky, llm: env.svc.llm, triage: env.svc.triage, defer: () => {} });

    const err = await refusal(settle(svc, id, { action: "release" }));
    expect(err.code).toBe("PAYPAL_ERROR");
    const mid = await settlementContext(svc, id);
    expect(mid.report.settlement).toMatchObject({ action: "release", status: "failed" });
    expect(mid.deposit).toMatchObject({ status: "VOIDING", resolution: { action: "void" } });
    // The resolution is claimed: the deposit can no longer be captured, even though the verdict is SLOP.
    expect((await refusal(settle(svc, id, { action: "capture", confirm: true }))).code).toBe("ACTION_NOT_ALLOWED");

    const done = await settle(svc, id, { action: "release" });
    expect(done.deposit?.status).toBe("VOIDED");
    expect(done.report.settlement?.status).toBe("done");
    expect(apiCalls(env.paypal, "captureAuthorization")).toHaveLength(0);
  });

  it("treats PREVIOUSLY_VOIDED as already released (e.g. voided in the PayPal dashboard)", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "slop");
    const dep = await env.svc.db.deposits.value(id);
    await env.paypal.voidAuthorization(dep?.authorizationId as string);
    const done = await settle(env.svc, id, { action: "release" });
    expect(done.deposit?.status).toBe("VOIDED");
    expect(done.report.settlement?.status).toBe("done");
  });
});
