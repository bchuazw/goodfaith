import { describe, expect, it } from "vitest";
import { createMockPayPal, isMockPayPal, PayPalError, type MockPayPal, type WebhookDelivery } from "../src/index.js";

const MANDATE_HASH = "q3RlIZ0rL0vXyYHk2E6kCw7m1a9U7n3f-T_bcM5JjLk";
const RETURN = "https://cs.example/wallet/linked";
const CANCEL = "https://cs.example/wallet";

function fixedClock(start = "2026-10-02T09:00:00Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function catchError(p: Promise<unknown> | (() => unknown)): Promise<PayPalError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof PayPalError) return e;
    throw e;
  }
  throw new Error("expected a PayPalError");
}

/** Link PayPal: setup token -> buyer approval -> payment token. */
async function vaultWallet(pp: MockPayPal) {
  const st = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL });
  pp.simulateBuyerApproval(st.id, { email: "maya@example.com", givenName: "Maya", surname: "Lee" });
  return pp.createPaymentToken(st.id);
}

async function vaultCapture(pp: MockPayPal, value = "38.50", requestId = "cs-order-1") {
  const pt = await vaultWallet(pp);
  const order = await pp.createOrder({
    intent: "CAPTURE",
    amount: { currency: "USD", value },
    customId: MANDATE_HASH,
    invoiceId: `CS-${requestId}`,
    vaultId: pt.vaultId,
    requestId,
  });
  return { pt, order };
}

describe("Vault: link PayPal without purchase", () => {
  it("walks setup token PAYER_ACTION_REQUIRED -> APPROVED -> VAULTED and mints a payment token", async () => {
    const pp = createMockPayPal({ seed: "vault" });
    expect(isMockPayPal(pp)).toBe(true);
    const st = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL, description: "Good Faith deposits" });
    expect(st.status).toBe("PAYER_ACTION_REQUIRED");
    expect(st.id).toMatch(/^[0-9A-Z]{17}$/);
    expect(st.approveUrl).toBe(`https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${st.id}`);
    expect(st.customerId).toMatch(/^customer_\d{10}$/);

    const early = await catchError(pp.createPaymentToken(st.id));
    expect(early).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "PAYER_ACTION_REQUIRED" });
    expect(early.debugId).toMatch(/^[0-9a-f]{13}$/);

    const approval = pp.simulateBuyerApproval(st.id, { email: "maya@example.com", givenName: "Maya" });
    expect(approval).toEqual({
      kind: "setup_token",
      id: st.id,
      status: "APPROVED",
      redirectUrl: `${RETURN}?approval_token_id=${st.id}&approval_session_id=${st.id}`,
    });

    const pt = await pp.createPaymentToken(st.id);
    expect(pt.vaultId).toMatch(/^[a-z0-9]{7}$/);
    expect(pt.customerId).toBe(st.customerId);
    expect(pt.payerEmail).toBe("maya@example.com");
    expect(pt.payerId).toMatch(/^[A-Z0-9]{13}$/);

    const snapshot = pp._state() as { setupTokens: Array<{ id: string; status: string }> };
    expect(snapshot.setupTokens.find((t) => t.id === st.id)?.status).toBe("VAULTED");
    expect((await catchError(pp.createPaymentToken(st.id))).issue).toBe("SETUP_TOKEN_ALREADY_TOKENIZED");
    expect((await catchError(pp.createPaymentToken("0000000000000000X"))).issue).toBe("TOKEN_NOT_FOUND");

    await pp.flushWebhooks();
    expect(pp.webhooks().map((w) => w.event.event_type)).toEqual(["VAULT.PAYMENT-TOKEN.CREATED"]);
  });

  it("expires unapproved setup tokens after 3 days", async () => {
    const clock = fixedClock();
    const pp = createMockPayPal({ seed: "exp", now: clock.now });
    const st = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL });
    pp.simulateBuyerApproval(st.id);
    clock.advance(3 * 24 * 3600 * 1000 + 1);
    expect((await catchError(pp.createPaymentToken(st.id))).status).toBe(404);
  });

  it("replays setup tokens and payment tokens for a repeated PayPal-Request-Id", async () => {
    const pp = createMockPayPal({ seed: "idem" });
    const a = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL, requestId: "st-1" });
    const b = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL, requestId: "st-1" });
    expect(b.id).toBe(a.id);
    pp.simulateBuyerApproval(a.id);
    const p1 = await pp.createPaymentToken(a.id, { requestId: "pt-1" });
    const p2 = await pp.createPaymentToken(a.id, { requestId: "pt-1" });
    expect(p2).toEqual(p1);
  });
});

describe("Orders: merchant-initiated (vault_id) charges", () => {
  it("completes a CAPTURE order immediately with no buyer present and links custom_id everywhere", async () => {
    const clock = fixedClock();
    const pp = createMockPayPal({ seed: "mit", now: clock.now });
    const { order } = await vaultCapture(pp);
    expect(order.status).toBe("COMPLETED");
    expect(order.id).toMatch(/^[0-9A-Z]{17}$/);
    expect(order.captureId).toMatch(/^[0-9A-Z]{17}$/);
    expect(order.captureStatus).toBe("COMPLETED");
    expect(order.approveUrl).toBeUndefined();

    const details = await pp.getOrder(order.id);
    expect(details).toMatchObject({ status: "COMPLETED", intent: "CAPTURE", customId: MANDATE_HASH, payerEmail: "maya@example.com", amount: { currency: "USD", value: "38.50" } });
    const raw = details.raw as any;
    expect(raw.payment_source.paypal.attributes.vault.status).toBe("VAULTED");
    expect(raw.purchase_units[0].payments.captures[0].seller_receivable_breakdown).toEqual({
      gross_amount: { currency_code: "USD", value: "38.50" },
      paypal_fee: { currency_code: "USD", value: "1.83" },
      net_amount: { currency_code: "USD", value: "36.67" },
    });
    expect(raw.purchase_units[0].payee.merchant_id).toMatch(/^[A-Z0-9]{13}$/);

    const txns = await pp.searchTransactions({ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-03T00:00:00Z") });
    expect(txns).toEqual([
      {
        id: order.captureId,
        amount: { currency: "USD", value: "38.50" },
        status: "COMPLETED",
        customId: MANDATE_HASH,
        time: "2026-10-02T09:00:00.000Z",
        invoiceId: "CS-cs-order-1",
        eventCode: "T0003",
        statusCode: "S",
        fee: { currency: "USD", value: "-1.83" },
      },
    ]);

    await pp.flushWebhooks();
    const capture = pp.webhooks().find((w) => w.event.event_type === "PAYMENT.CAPTURE.COMPLETED");
    expect(capture?.event.resource).toMatchObject({ id: order.captureId, custom_id: MANDATE_HASH, status: "COMPLETED" });
    expect(capture?.event.summary).toBe("Payment completed for $ 38.5 USD");
  });

  it("replays the same order for a repeated PayPal-Request-Id instead of charging twice", async () => {
    const pp = createMockPayPal({ seed: "replay" });
    const { pt, order } = await vaultCapture(pp);
    const again = await pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "38.50" }, vaultId: pt.vaultId, requestId: "cs-order-1" });
    expect(again).toEqual(order);
    expect((pp._state() as { captures: unknown[] }).captures).toHaveLength(1);
  });

  it("authorizes a vault AUTHORIZE order at once and can void it (HOLD path)", async () => {
    const pp = createMockPayPal({ seed: "hold" });
    const pt = await vaultWallet(pp);
    const order = await pp.createOrder({ intent: "AUTHORIZE", amount: { currency: "USD", value: "120.00" }, vaultId: pt.vaultId, requestId: "hold-1" });
    expect(order).toMatchObject({ status: "COMPLETED", authorizationStatus: "CREATED" });
    expect(order.authorizationId).toMatch(/^[0-9A-Z]{17}$/);
    expect(await pp.voidAuthorization(order.authorizationId!)).toEqual({ status: "VOIDED" });
    expect((await catchError(pp.voidAuthorization(order.authorizationId!))).issue).toBe("PREVIOUSLY_VOIDED");
    expect((await catchError(pp.captureAuthorization(order.authorizationId!, "c-1"))).issue).toBe("AUTHORIZATION_VOIDED");
    await pp.flushWebhooks();
    expect(pp.webhooks().map((w) => w.event.event_type)).toEqual(["VAULT.PAYMENT-TOKEN.CREATED", "PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED"]);
  });

  it("fails vault charges with 422 PAYMENT_DENIED when failVaultCharges is set", async () => {
    const pp = createMockPayPal({ seed: "deny", failVaultCharges: true });
    const pt = await vaultWallet(pp);
    const err = await catchError(pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: pt.vaultId, requestId: "r1" }));
    expect(err).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "PAYMENT_DENIED", method: "POST", path: "/v2/checkout/orders" });
    expect((pp._state() as { orders: unknown[] }).orders).toHaveLength(0);
  });

  it("rejects unknown vault ids and validates input like the real client", async () => {
    const pp = createMockPayPal({ seed: "bad" });
    expect((await catchError(pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: "nope123", requestId: "r1" }))).issue).toBe(
      "TOKEN_ID_NOT_FOUND",
    );
    expect((await catchError(pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.001" }, requestId: "r2" }))).name).toBe("CLIENT_VALIDATION_ERROR");
  });

  it("enforces unique invoice ids like PayPal's default account setting", async () => {
    const pp = createMockPayPal({ seed: "inv" });
    const pt = await vaultWallet(pp);
    await pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: pt.vaultId, invoiceId: "INV-1", requestId: "r1" });
    const dup = await catchError(pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "5.00" }, vaultId: pt.vaultId, invoiceId: "INV-1", requestId: "r2" }));
    expect(dup.issue).toBe("DUPLICATE_INVOICE_ID");
  });
});

describe("Orders: buyer approval (step-up)", () => {
  it("runs PAYER_ACTION_REQUIRED -> APPROVED -> COMPLETED with the documented errors in between", async () => {
    const pp = createMockPayPal({ seed: "stepup" });
    const order = await pp.createOrder({
      intent: "CAPTURE",
      amount: { currency: "USD", value: "52.00" },
      customId: MANDATE_HASH,
      returnUrl: "https://cs.example/step-up/return",
      cancelUrl: "https://cs.example/step-up/cancel",
      requestId: "stepup-1",
    });
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    expect(order.approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`);

    expect((await catchError(pp.captureOrder(order.id, "cap-early"))).issue).toBe("ORDER_NOT_APPROVED");
    expect((await catchError(pp.authorizeOrder(order.id, "auth-wrong"))).issue).toBe("ACTION_DOES_NOT_MATCH_INTENT");

    const cancel = pp.simulateBuyerCancel(order.id);
    expect(cancel.redirectUrl).toBe(`https://cs.example/step-up/cancel?token=${order.id}`);
    expect((await pp.getOrder(order.id)).status).toBe("PAYER_ACTION_REQUIRED");

    const approval = pp.simulateBuyerApproval(order.id);
    expect(approval.status).toBe("APPROVED");
    const redirect = new URL(approval.redirectUrl);
    expect(redirect.origin + redirect.pathname).toBe("https://cs.example/step-up/return");
    expect(redirect.searchParams.get("token")).toBe(order.id);
    expect(redirect.searchParams.get("PayerID")).toMatch(/^[A-Z0-9]{13}$/);
    expect((await pp.getOrder(order.id)).status).toBe("APPROVED");

    const captured = await pp.captureOrder(order.id, "cap-1");
    expect(captured).toMatchObject({ id: order.id, status: "COMPLETED", captureStatus: "COMPLETED" });
    expect(await pp.captureOrder(order.id, "cap-1")).toEqual(captured); // idempotent replay
    expect((await catchError(pp.captureOrder(order.id, "cap-2"))).issue).toBe("ORDER_ALREADY_CAPTURED");
    expect(() => pp.simulateBuyerApproval(order.id)).toThrow(/not awaiting buyer approval/);

    const txns = await pp.searchTransactions({ start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 60_000) });
    expect(txns[0]?.eventCode).toBe("T0006"); // buyer-approved checkout, unlike T0003 for vault charges

    await pp.flushWebhooks();
    expect(pp.webhooks().map((w) => w.event.event_type)).toEqual(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED"]);
  });

  it("creates plain JS-SDK style orders in CREATED with an approve link", async () => {
    const pp = createMockPayPal({ seed: "plain", webBaseUrl: "https://cs.example/mock-paypal" });
    const order = await pp.createOrder({ intent: "CAPTURE", amount: { currency: "USD", value: "9.99" }, requestId: "plain-1" });
    expect(order).toMatchObject({ status: "CREATED", approveUrl: `https://cs.example/mock-paypal/checkoutnow?token=${order.id}` });
    expect(pp.simulateBuyerApproval(order.id).redirectUrl).toBe("");
  });
});

describe("Authorizations: AUTHORIZE -> capture / void", () => {
  async function approvedAuthorization(pp: MockPayPal, value = "100.00") {
    const order = await pp.createOrder({ intent: "AUTHORIZE", amount: { currency: "USD", value }, returnUrl: RETURN, cancelUrl: CANCEL, requestId: `a-${value}` });
    pp.simulateBuyerApproval(order.id);
    expect((await catchError(pp.captureOrder(order.id, "wrong"))).issue).toBe("ACTION_DOES_NOT_MATCH_INTENT");
    const auth = await pp.authorizeOrder(order.id, `auth-${value}`);
    expect(auth).toMatchObject({ status: "COMPLETED", authorizationStatus: "CREATED" });
    expect(auth.expiresAt).toMatch(/Z$/);
    expect((await catchError(pp.authorizeOrder(order.id, "auth-again"))).issue).toBe("ORDER_ALREADY_AUTHORIZED");
    return auth.authorizationId!;
  }

  it("captures partially, then the rest, then refuses to void a captured authorization", async () => {
    const pp = createMockPayPal({ seed: "partial" });
    const authId = await approvedAuthorization(pp);
    const first = await pp.captureAuthorization(authId, "part-1", { amount: { currency: "USD", value: "38.50" }, finalCapture: false });
    expect(first.status).toBe("COMPLETED");
    let raw = (await pp.getOrder((pp._state() as any).orders[0].id)).raw as any;
    expect(raw.purchase_units[0].payments.authorizations[0].status).toBe("PARTIALLY_CAPTURED");

    const tooMuch = await catchError(pp.captureAuthorization(authId, "part-2", { amount: { currency: "USD", value: "70.00" } }));
    expect(tooMuch.issue).toBe("MAX_CAPTURE_AMOUNT_EXCEEDED");
    const second = await pp.captureAuthorization(authId, "part-3");
    expect(second.captureId).not.toBe(first.captureId);
    raw = (await pp.getOrder((pp._state() as any).orders[0].id)).raw as any;
    expect(raw.purchase_units[0].payments.authorizations[0].status).toBe("CAPTURED");
    expect(raw.purchase_units[0].payments.captures.map((c: any) => c.amount.value)).toEqual(["38.50", "61.50"]);
    expect((await catchError(pp.voidAuthorization(authId))).issue).toBe("PREVIOUSLY_CAPTURED");
    expect((await catchError(pp.captureAuthorization(authId, "part-4"))).issue).toBe("AUTHORIZATION_ALREADY_CAPTURED");
    expect(await pp.captureAuthorization(authId, "part-3")).toEqual(second); // replay
  });

  it("expires authorizations after 29 days", async () => {
    const clock = fixedClock();
    const pp = createMockPayPal({ seed: "expire", now: clock.now });
    const authId = await approvedAuthorization(pp);
    clock.advance(30 * 24 * 3600 * 1000);
    expect((await catchError(pp.captureAuthorization(authId, "late"))).issue).toBe("AUTHORIZATION_EXPIRED");
  });
});

describe("Refunds", () => {
  it("refunds partially then fully, with PayPal's errors and T1107 rows", async () => {
    const pp = createMockPayPal({ seed: "refund" });
    const { order } = await vaultCapture(pp, "40.00");
    const captureId = order.captureId!;
    const r1 = await pp.refundCapture(captureId, { currency: "USD", value: "10.00" }, "rf-1", { note: "Item out of stock" });
    expect(r1).toMatchObject({ status: "COMPLETED" });
    expect(r1.refundId).toMatch(/^[0-9A-Z]{17}$/);
    expect(await pp.refundCapture(captureId, { currency: "USD", value: "10.00" }, "rf-1")).toEqual(r1); // replay
    expect((await catchError(pp.refundCapture(captureId, { currency: "USD", value: "30.01" }))).issue).toBe("REFUND_AMOUNT_EXCEEDED");
    let capture = ((pp._state() as any).captures as any[]).find((c) => c.id === captureId);
    expect(capture.status).toBe("PARTIALLY_REFUNDED");
    await pp.refundCapture(captureId);
    capture = ((pp._state() as any).captures as any[]).find((c) => c.id === captureId);
    expect(capture.status).toBe("REFUNDED");
    expect((await catchError(pp.refundCapture(captureId))).issue).toBe("CAPTURE_FULLY_REFUNDED");

    const txns = await pp.searchTransactions({ start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 60_000) });
    expect(txns.map((t) => [t.eventCode, t.amount.value])).toEqual([
      ["T0003", "40.00"],
      ["T1107", "-10.00"],
      ["T1107", "-30.00"],
    ]);
    expect(txns.every((t) => t.customId === MANDATE_HASH)).toBe(true);
    await pp.flushWebhooks();
    expect(pp.webhooks().filter((w) => w.event.event_type === "PAYMENT.CAPTURE.REFUNDED")).toHaveLength(2);
  });
});

describe("Disputes", () => {
  it("opens an UNAUTHORISED dispute, accepts evidence, and resolves it in the seller's favour", async () => {
    const pp = createMockPayPal({ seed: "dispute" });
    const { order } = await vaultCapture(pp);
    const { id } = await pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "38.50" } });
    expect(id).toMatch(/^PP-R-[A-Z]{3}-\d{8}$/);

    const d = await pp.getDispute(id);
    expect(d).toMatchObject({
      id,
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "UNAUTHORISED",
      amount: { currency: "USD", value: "38.50" },
      transactionId: order.captureId,
      customId: MANDATE_HASH,
      stage: "CHARGEBACK",
      state: "REQUIRED_ACTION",
      requestedEvidence: ["OTHER"],
    });
    expect(d.allowedActions).toEqual(["accept_claim", "make_offer", "provide_evidence"]);
    expect(d.sellerResponseDueDate).toMatch(/Z$/);

    const list = await pp.listDisputes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: "WAITING_FOR_SELLER_RESPONSE", reason: "UNAUTHORISED", stage: "CHARGEBACK" });
    // Like PayPal's list response, only the buyer-side transaction id is present.
    expect(list[0]!.transactionId).not.toBe(order.captureId);
    expect(await pp.listDisputes({ transactionId: order.captureId! })).toHaveLength(1);
    expect(await pp.listDisputes({ states: ["RESOLVED"] })).toHaveLength(0);

    expect((await catchError(pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "1.00" } }))).status).toBe(422);
    expect((await catchError(pp.refundCapture(order.captureId!, { currency: "USD", value: "5.00" }))).issue).toBe("TRANSACTION_DISPUTED");

    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const evidence = await pp.provideEvidence(id, {
      notes: "AP2 mandate chain verified: user-signed intent, merchant-signed cart, agent countersignature.",
      files: [{ name: "Mandate chain (PS-7).pdf", contentType: "application/pdf", data: pdf }],
    });
    expect(evidence).toEqual({ status: "UNDER_REVIEW" });
    const reviewed = await pp.getDispute(id);
    expect(reviewed).toMatchObject({ status: "UNDER_REVIEW", state: "UNDER_PAYPAL_REVIEW" });
    expect(reviewed.allowedActions).toEqual(["adjudicate", "require_evidence"]);
    const submitted = (reviewed.raw as any).evidences.at(-1);
    expect(submitted).toMatchObject({ evidence_type: "OTHER", source: "SUBMITTED_BY_SELLER", documents: [{ name: "Mandate chain -PS-7-.pdf" }] });
    expect((await catchError(pp.provideEvidence(id, { notes: "again" }))).issue).toBe("ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE");

    expect(pp.simulateDisputeDecision(id, "SELLER_FAVOR")).toEqual({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
    const resolved = await pp.getDispute(id);
    expect(resolved).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", allowedActions: [] });

    await pp.flushWebhooks();
    expect(pp.webhooks().filter((w) => w.event.event_type.startsWith("CUSTOMER.DISPUTE")).map((w) => w.event.event_type)).toEqual([
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.RESOLVED",
    ]);
  });

  it("reverses the payment when the buyer wins", async () => {
    const pp = createMockPayPal({ seed: "lost" });
    const { order } = await vaultCapture(pp, "20.00");
    const { id } = await pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "20.00" }, strategy: "chargeback" });
    expect((await pp.getDispute(id)).raw).toMatchObject({ dispute_channel: "EXTERNAL", dispute_life_cycle_stage: "CHARGEBACK" });
    expect(() => pp.simulateDisputeDecision(id, "BUYER_FAVOR")).toThrow(PayPalError); // needs UNDER_REVIEW first
    await pp.provideEvidence(id, { notes: "Signed mandate attached" });
    pp.simulateDisputeDecision(id, "BUYER_FAVOR");
    const capture = ((pp._state() as any).captures as any[])[0];
    expect(capture.status).toBe("REFUNDED");
    const txns = await pp.searchTransactions({ start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 60_000) });
    expect(txns.map((t) => t.eventCode)).toEqual(["T0003", "T1106"]);
    await pp.flushWebhooks();
    expect(pp.webhooks().map((w) => w.event.event_type)).toContain("PAYMENT.CAPTURE.REVERSED");
  });

  it("opens item-not-received disputes in INQUIRY asking for proof of fulfillment, and can re-request evidence", async () => {
    const pp = createMockPayPal({ seed: "inr" });
    const { order } = await vaultCapture(pp);
    const { id } = await pp.createSandboxDispute({ captureId: order.captureId!, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: { currency: "USD", value: "10.00" } });
    const d = await pp.getDispute(id);
    expect(d).toMatchObject({ stage: "INQUIRY", requestedEvidence: ["PROOF_OF_FULFILLMENT"], amount: { value: "10.00" } });
    expect(d.allowedActions).toEqual(["send_message", "escalate", "accept_claim", "make_offer", "provide_evidence"]);
    await pp.provideEvidence(id, { notes: "Tracking attached", evidenceType: "PROOF_OF_FULFILLMENT" });
    expect(pp.simulateDisputeRequireEvidence(id)).toEqual({ status: "WAITING_FOR_SELLER_RESPONSE" });
    expect((await pp.getDispute(id)).requestedEvidence).toEqual(["PROOF_OF_FULFILLMENT", "OTHER"]);
  });

  it("validates dispute input and evidence files", async () => {
    const pp = createMockPayPal({ seed: "dv" });
    const { order } = await vaultCapture(pp, "10.00");
    expect((await catchError(pp.createSandboxDispute({ captureId: order.captureId!, reason: "BOGUS", amount: { currency: "USD", value: "1.00" } }))).name).toBe(
      "CLIENT_VALIDATION_ERROR",
    );
    expect((await catchError(pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "11.00" } }))).status).toBe(422);
    expect((await catchError(pp.createSandboxDispute({ captureId: "1234567890ABCDEFG", reason: "UNAUTHORISED", amount: { currency: "USD", value: "1.00" } }))).status).toBe(404);
    const { id } = await pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "10.00" } });
    const bad = await catchError(pp.provideEvidence(id, { notes: "x", files: [{ name: "a.docx", contentType: "application/msword", data: new Uint8Array(1) }] }));
    expect(bad.issue).toBe("INVALID_EVIDENCE_FILE");
    expect((await catchError(pp.getDispute("PP-R-XXX-10000000"))).status).toBe(404);
  });
});

describe("Webhooks", () => {
  it("delivers PayPal-shaped events asynchronously, after the API call returns", async () => {
    const received: WebhookDelivery[] = [];
    const viaOption: string[] = [];
    const pp = createMockPayPal({ seed: "wh", emitWebhook: (d) => void viaOption.push(d.event.event_type) });
    const off = pp.onWebhook((d) => void received.push(d));
    await vaultWallet(pp);
    expect(received).toHaveLength(0); // not yet: delivery happens on a later tick
    await pp.flushWebhooks();
    expect(received.map((d) => d.event.event_type)).toEqual(["VAULT.PAYMENT-TOKEN.CREATED"]);
    expect(viaOption).toEqual(["VAULT.PAYMENT-TOKEN.CREATED"]);

    const w = received[0]!;
    expect(w.event.id).toMatch(/^WH-[0-9A-Z]{17}-[0-9A-Z]{17}$/);
    expect(w.event).toMatchObject({ event_version: "1.0", resource_type: "payment_token", resource_version: "3.0" });
    expect(w.event.links.map((l) => l.rel)).toEqual(["self", "resend"]);
    expect(JSON.parse(w.body)).toEqual(w.event);
    expect(w.headers["paypal-auth-algo"]).toBe("SHA256withRSA");
    expect(w.headers["paypal-transmission-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.headers["paypal-cert-url"]).toMatch(/^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\/CERT-/);
    expect(w.webhookId).toBe(pp.webhookId);

    off();
    await vaultWallet(pp);
    await pp.flushWebhooks();
    expect(received).toHaveLength(1);
    expect(viaOption).toHaveLength(2);
  });

  it("verifies its own deliveries and rejects tampering", async () => {
    const pp = createMockPayPal({ seed: "verify" });
    await vaultCapture(pp);
    const [w] = pp.webhooks().filter((d) => d.event.event_type === "PAYMENT.CAPTURE.COMPLETED");
    const upper = Object.fromEntries(Object.entries(w!.headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(await pp.verifyWebhookSignature({ headers: upper, body: w!.body, webhookId: pp.webhookId })).toBe(true);
    expect(await pp.verifyWebhookSignature({ headers: w!.headers, body: w!.body.replace("38.50", "3850.00"), webhookId: pp.webhookId })).toBe(false);
    expect(await pp.verifyWebhookSignature({ headers: w!.headers, body: w!.body, webhookId: "OTHERWEBHOOK1" })).toBe(false);
    expect(
      await pp.verifyWebhookSignature({ headers: { ...w!.headers, "paypal-transmission-sig": "forged" }, body: w!.body, webhookId: pp.webhookId }),
    ).toBe(false);
    expect(await pp.verifyWebhookSignature({ headers: {}, body: w!.body, webhookId: pp.webhookId })).toBe(false);
  });

  it("isolates failing listeners", async () => {
    const pp = createMockPayPal({ seed: "boom" });
    const ok: string[] = [];
    pp.onWebhook(() => {
      throw new Error("listener exploded");
    });
    pp.onWebhook((d) => void ok.push(d.event.event_type));
    await vaultWallet(pp);
    await pp.flushWebhooks();
    expect(ok).toEqual(["VAULT.PAYMENT-TOKEN.CREATED"]);
    expect(pp.events().some((e) => e.action === "listener_error" && e.detail?.message === "listener exploded")).toBe(true);
  });
});

describe("event log", () => {
  it("records API calls, buyer actions, failures and webhooks in order", async () => {
    const live: string[] = [];
    const pp = createMockPayPal({ seed: "log", onEvent: (e) => live.push(`${e.kind}:${e.action}`) });
    const st = await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL });
    await catchError(pp.createPaymentToken(st.id));
    pp.simulateBuyerApproval(st.id);
    await pp.createPaymentToken(st.id);
    const events = pp.events();
    expect(events.map((e) => `${e.kind}:${e.action}`)).toEqual([
      "api:createVaultSetupToken",
      "api:createPaymentToken",
      "buyer:approve_setup_token",
      "webhook:VAULT.PAYMENT-TOKEN.CREATED",
      "api:createPaymentToken",
    ]);
    expect(live).toEqual(events.map((e) => `${e.kind}:${e.action}`));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]).toMatchObject({ id: st.id, status: "PAYER_ACTION_REQUIRED" });
    expect(events[1]?.error).toEqual({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "PAYER_ACTION_REQUIRED" });
  });
});

describe("determinism", () => {
  async function script(seed?: string) {
    const clock = fixedClock();
    const pp = createMockPayPal({ ...(seed ? { seed } : {}), now: clock.now });
    const { order } = await vaultCapture(pp);
    const { id } = await pp.createSandboxDispute({ captureId: order.captureId!, reason: "UNAUTHORISED", amount: { currency: "USD", value: "38.50" } });
    return { state: pp._state(), webhooks: pp.webhooks(), ids: [order.id, order.captureId, id] };
  }

  it("produces identical ids, state and webhooks for the same seed and clock", async () => {
    const a = await script("goodfaith-demo");
    const b = await script("goodfaith-demo");
    expect(a).toEqual(b);
    const c = await script("another-seed");
    expect(c.ids).not.toEqual(a.ids);
  });

  it("is random without a seed", async () => {
    const a = await script();
    const b = await script();
    expect(a.ids[0]).not.toBe(b.ids[0]);
  });
});

describe("misc", () => {
  it("simulates latency", async () => {
    const pp = createMockPayPal({ seed: "slow", latencyMs: 25 });
    const t0 = performance.now();
    await pp.createVaultSetupToken({ returnUrl: RETURN, cancelUrl: CANCEL });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it("returns 404 RESOURCE_NOT_FOUND for unknown resources and rejects inverted searches", async () => {
    const pp = createMockPayPal({ seed: "404" });
    const err = await catchError(pp.getOrder("1234567890ABCDEFG"));
    expect(err).toMatchObject({ status: 404, name: "RESOURCE_NOT_FOUND", issue: "INVALID_RESOURCE_ID" });
    expect((await catchError(pp.searchTransactions({ start: new Date(2), end: new Date(1) }))).name).toBe("CLIENT_VALIDATION_ERROR");
    expect(() => pp.simulateBuyerApproval("NOPE")).toThrow(/no setup token or order/);
  });
});
