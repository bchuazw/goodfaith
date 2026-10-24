import { describe, expect, it } from "vitest";
import { createMockPayPal, createPayPalClient, PayPalError } from "../src/index.js";
import { errorFromResponse } from "../src/errors.js";
import { duplicatePayoutBatchId, mapPayoutBatch, mapPayoutItem } from "../src/mappers.js";
import { buildPayoutRequest, payoutRequestId } from "../src/requests.js";
import { fetchStub } from "./fetch-stub.js";

// Response samples from PayPal's Payouts v1 reference (create batch, show batch details, show item details).
const createdBatch = {
  batch_header: {
    sender_batch_header: { sender_batch_id: "Payouts_2018_100007", email_subject: "You have a payout!" },
    payout_batch_id: "5UXD2E8A7EBQJ",
    batch_status: "PENDING",
  },
  links: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/5UXD2E8A7EBQJ", rel: "self", method: "GET", encType: "application/json" }],
};

const payoutItem = {
  payout_item_id: "DUCD8GQ5LBH9A",
  transaction_id: "8GL41891AM7357525",
  transaction_status: "SUCCESS",
  payout_item_fee: { currency: "USD", value: "0.35" },
  payout_batch_id: "5UXD2E8A7EBQJ",
  payout_item: {
    recipient_type: "EMAIL",
    amount: { value: "9.87", currency: "USD" },
    note: "Thanks for your patronage!",
    receiver: "receiver@example.com",
    sender_item_id: "14Feb_234",
  },
  time_processed: "2018-01-27T10:18:32Z",
};

const batchDetails = {
  batch_header: {
    payout_batch_id: "5UXD2E8A7EBQJ",
    batch_status: "SUCCESS",
    time_created: "2018-01-27T10:17:00Z",
    time_completed: "2018-01-27T11:17:39.00Z",
    sender_batch_header: { sender_batch_id: "Payouts_2018_100007" },
    amount: { value: "9.87", currency: "USD" },
    fees: { value: "0.35", currency: "USD" },
  },
  items: [payoutItem],
};

// Shape of PayPal's answer to a reused sender_batch_id (USER_BUSINESS_ERROR with the original batch linked on
// the detail). The live sandbox test exercises the real response.
const duplicateBatchError = {
  name: "USER_BUSINESS_ERROR",
  message: "User business error.",
  debug_id: "f0f3e7e5d4c3b",
  information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
  details: [
    {
      field: "SENDER_BATCH_ID",
      location: "body",
      issue: "Batch with given sender_batch_id already exists",
      link: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/5UXD2E8A7EBQJ", rel: "self", method: "GET", encType: "application/json" }],
    },
  ],
  links: [],
};

function client(stub: ReturnType<typeof fetchStub>) {
  return createPayPalClient({ clientId: "client-id", clientSecret: "client-secret", env: "sandbox", fetch: stub.fetch, retryBaseDelayMs: 0 });
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

describe("Payouts request", () => {
  it("builds the batch body with Payouts money ({ value, currency }) and EMAIL as the default recipient type", () => {
    expect(
      buildPayoutRequest({
        senderBatchId: "bounty-42",
        emailSubject: "You got paid",
        items: [
          { receiver: "dev@example.com", amount: { currency: "USD", value: "50" }, note: "Fixes #42", senderItemId: "issue-42" },
          { receiver: "+14155550100", recipientType: "PHONE", amount: { currency: "USD", value: "5.5" } },
        ],
      }),
    ).toEqual({
      sender_batch_header: { sender_batch_id: "bounty-42", email_subject: "You got paid" },
      items: [
        { recipient_type: "EMAIL", amount: { value: "50.00", currency: "USD" }, receiver: "dev@example.com", note: "Fixes #42", sender_item_id: "issue-42" },
        { recipient_type: "PHONE", amount: { value: "5.50", currency: "USD" }, receiver: "+14155550100" },
      ],
    });
  });

  it("applies the batch recipient type to items that do not set one", () => {
    const body = buildPayoutRequest({ senderBatchId: "b", recipientType: "PAYPAL_ID", items: [{ receiver: "AJM9JTWQJCFTA", amount: { currency: "USD", value: "1" } }] });
    expect(body.sender_batch_header.recipient_type).toBe("PAYPAL_ID");
    expect(body.items[0]?.recipient_type).toBe("PAYPAL_ID");
  });

  it("rejects payouts PayPal would refuse, before any request", () => {
    const one = [{ receiver: "dev@example.com", amount: { currency: "USD", value: "1" } }];
    expect(() => buildPayoutRequest({ senderBatchId: " ", items: one })).toThrow(/senderBatchId/);
    expect(() => buildPayoutRequest({ senderBatchId: "b", items: [] })).toThrow(/at least one item/);
    expect(() => buildPayoutRequest({ senderBatchId: "b", items: [{ receiver: "not-an-email", amount: { currency: "USD", value: "1" } }] })).toThrow(/email address/);
    expect(() => buildPayoutRequest({ senderBatchId: "b", items: [{ receiver: "dev@example.com", amount: { currency: "USD", value: "0" } }] })).toThrow();
  });

  it("derives PayPal-Request-Id from sender_batch_id, hashing ids that cannot go in a header", async () => {
    expect(await payoutRequestId("bounty-42")).toBe("payout-bounty-42");
    const hashed = await payoutRequestId("bounty für #42");
    expect(hashed).toMatch(/^payout-[0-9a-f]{64}$/);
    expect(await payoutRequestId("bounty für #42")).toBe(hashed);
  });
});

describe("Payouts mappers and errors", () => {
  it("maps batch details and items", () => {
    expect(mapPayoutBatch(batchDetails)).toMatchObject({
      batchId: "5UXD2E8A7EBQJ",
      status: "SUCCESS",
      senderBatchId: "Payouts_2018_100007",
      createdAt: "2018-01-27T10:17:00Z",
      completedAt: "2018-01-27T11:17:39.00Z",
      amount: { currency: "USD", value: "9.87" },
      fees: { currency: "USD", value: "0.35" },
      items: [
        {
          itemId: "DUCD8GQ5LBH9A",
          batchId: "5UXD2E8A7EBQJ",
          status: "SUCCESS",
          receiver: "receiver@example.com",
          amount: { currency: "USD", value: "9.87" },
          recipientType: "EMAIL",
          senderItemId: "14Feb_234",
          note: "Thanks for your patronage!",
          transactionId: "8GL41891AM7357525",
          fee: { currency: "USD", value: "0.35" },
          processedAt: "2018-01-27T10:18:32Z",
        },
      ],
    });
    expect(mapPayoutBatch(createdBatch)).toMatchObject({ batchId: "5UXD2E8A7EBQJ", status: "PENDING", items: [] });
  });

  it("maps an unclaimed item's error", () => {
    const item = mapPayoutItem({ ...payoutItem, transaction_status: "UNCLAIMED", errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" } });
    expect(item.status).toBe("UNCLAIMED");
    expect(item.error).toEqual({ name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" });
  });

  it("keeps HATEOAS links from an error body, including links on a detail", () => {
    const e = errorFromResponse({ status: 400, bodyText: JSON.stringify(duplicateBatchError) });
    expect(e.links.map((l) => l.href)).toContain("https://api-m.sandbox.paypal.com/v1/payments/payouts/5UXD2E8A7EBQJ");
    expect(e.informationLink).toBe("https://developer.paypal.com/docs/api/payments.payouts-batch/#errors");
    expect(duplicatePayoutBatchId(e)).toBe("5UXD2E8A7EBQJ");
  });

  it("does not treat other errors as a duplicate batch", () => {
    const insufficient = errorFromResponse({
      status: 422,
      bodyText: JSON.stringify({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds.", debug_id: "x", links: [] }),
    });
    expect(duplicatePayoutBatchId(insufficient)).toBeUndefined();
  });
});

describe("Payouts on the real client", () => {
  it("creates a batch with an idempotent PayPal-Request-Id and maps the PENDING header", async () => {
    const stub = fetchStub([["POST", "/v1/payments/payouts", { status: 201, json: createdBatch }]]);
    const batch = await client(stub).createPayout({
      senderBatchId: "Payouts_2018_100007",
      emailSubject: "You have a payout!",
      items: [{ receiver: "receiver@example.com", amount: { currency: "USD", value: "9.87" } }],
    });
    expect(batch).toMatchObject({ batchId: "5UXD2E8A7EBQJ", status: "PENDING", senderBatchId: "Payouts_2018_100007", items: [] });
    expect(batch.replayed).toBeUndefined();
    const [call] = stub.apiCalls();
    expect(call?.headers["PayPal-Request-Id"]).toBe("payout-Payouts_2018_100007");
    expect(JSON.parse(call?.text ?? "{}")).toMatchObject({ sender_batch_header: { sender_batch_id: "Payouts_2018_100007" } });
  });

  it("answers a reused sender_batch_id with the original batch instead of failing or paying twice", async () => {
    const stub = fetchStub([
      ["POST", "/v1/payments/payouts", { status: 400, json: duplicateBatchError }],
      ["GET", "/v1/payments/payouts/5UXD2E8A7EBQJ", { json: batchDetails }],
    ]);
    const batch = await client(stub).createPayout({
      senderBatchId: "Payouts_2018_100007",
      requestId: "a-different-request-id",
      items: [{ receiver: "receiver@example.com", amount: { currency: "USD", value: "9.87" } }],
    });
    expect(batch).toMatchObject({ batchId: "5UXD2E8A7EBQJ", status: "SUCCESS", replayed: true });
    expect(stub.apiCalls().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/payments/payouts", "GET /v1/payments/payouts/5UXD2E8A7EBQJ"]);
  });

  it("rethrows other payout errors", async () => {
    const stub = fetchStub([["POST", "/v1/payments/payouts", { status: 422, json: { name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds.", debug_id: "x" } }]]);
    const e = await catchError(client(stub).createPayout({ senderBatchId: "b-1", items: [{ receiver: "dev@example.com", amount: { currency: "USD", value: "1" } }] }));
    expect(e.status).toBe(422);
    expect(e.name).toBe("INSUFFICIENT_FUNDS");
  });

  it("reads batch details (with paging) and single items", async () => {
    const stub = fetchStub([
      ["GET", "/v1/payments/payouts/5UXD2E8A7EBQJ", { json: batchDetails }],
      ["GET", "/v1/payments/payouts-item/DUCD8GQ5LBH9A", { json: payoutItem }],
    ]);
    const pp = client(stub);
    expect((await pp.getPayoutBatch("5UXD2E8A7EBQJ", { page: 2, pageSize: 50 })).items).toHaveLength(1);
    expect(await pp.getPayoutItem("DUCD8GQ5LBH9A")).toMatchObject({ itemId: "DUCD8GQ5LBH9A", status: "SUCCESS", transactionId: "8GL41891AM7357525" });
    const [batchCall] = stub.apiCalls();
    expect(batchCall?.url.searchParams.get("page")).toBe("2");
    expect(batchCall?.url.searchParams.get("page_size")).toBe("50");
  });
});

describe("Payouts on the mock", () => {
  it("creates a PENDING batch that completes on first read, with fees and webhooks", async () => {
    const pp = createMockPayPal({ seed: "payouts" });
    const created = await pp.createPayout({
      senderBatchId: "bounty-42",
      items: [
        { receiver: "dev@example.com", amount: { currency: "USD", value: "50.00" }, senderItemId: "issue-42" },
        { receiver: "big@example.com", amount: { currency: "USD", value: "2000.00" } },
      ],
    });
    expect(created).toMatchObject({ status: "PENDING", senderBatchId: "bounty-42", items: [] });

    const done = await pp.getPayoutBatch(created.batchId);
    expect(done.status).toBe("SUCCESS");
    expect(done.amount).toEqual({ currency: "USD", value: "2050.00" });
    // The sandbox's flat 0.25 per item
    expect(done.fees).toEqual({ currency: "USD", value: "0.50" });
    expect(done.items.map((i) => [i.status, i.senderItemId ?? null])).toEqual([
      ["SUCCESS", "issue-42"],
      ["SUCCESS", null],
    ]);
    expect(done.items.every((i) => typeof i.transactionId === "string")).toBe(true);

    await pp.flushWebhooks();
    expect(pp.webhooks().map((w) => w.event.event_type)).toEqual([
      "PAYMENT.PAYOUTSBATCH.PROCESSING",
      "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      "PAYMENT.PAYOUTSBATCH.SUCCESS",
    ]);
  });

  it("leaves items for unregistered receivers UNCLAIMED", async () => {
    const pp = createMockPayPal({ seed: "payouts" });
    const created = await pp.createPayout({ senderBatchId: "b", items: [{ receiver: "unregistered-dev@example.com", amount: { currency: "USD", value: "5" } }] });
    const [item] = (await pp.getPayoutBatch(created.batchId)).items;
    expect(item?.status).toBe("UNCLAIMED");
    expect(item?.error?.name).toBe("RECEIVER_UNREGISTERED");
    expect(await pp.getPayoutItem(item?.itemId ?? "")).toMatchObject({ status: "UNCLAIMED" });
  });

  it("pays a sender_batch_id once, like PayPal", async () => {
    const pp = createMockPayPal({ seed: "payouts" });
    const input = { senderBatchId: "bounty-7", items: [{ receiver: "dev@example.com", amount: { currency: "USD", value: "10" } }] };
    const first = await pp.createPayout(input);
    const again = await pp.createPayout({ ...input, items: [{ receiver: "dev@example.com", amount: { currency: "USD", value: "99" } }] });
    expect(again.batchId).toBe(first.batchId);
    expect(again.replayed).toBe(true);
    const details = await pp.getPayoutBatch(first.batchId);
    expect(details.items).toHaveLength(1);
    expect(details.amount).toEqual({ currency: "USD", value: "10.00" });
  });

  it("validates like the real client and 404s unknown ids", async () => {
    const pp = createMockPayPal({ seed: "payouts" });
    await expect(pp.createPayout({ senderBatchId: "b", items: [{ receiver: "nope", amount: { currency: "USD", value: "1" } }] })).rejects.toThrow(/email address/);
    expect((await catchError(pp.getPayoutBatch("MISSINGBATCH1"))).status).toBe(404);
    expect((await catchError(pp.getPayoutItem("MISSINGITEM01"))).status).toBe(404);
  });
});
