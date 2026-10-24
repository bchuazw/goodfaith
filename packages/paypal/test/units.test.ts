import { describe, expect, it } from "vitest";
import { errorFromResponse } from "../src/errors.js";
import { authAssertion, base64Url } from "../src/http.js";
import { createRng, transactionId } from "../src/ids.js";
import { parseReportingDate } from "../src/mappers.js";
import { fromMinor, normalizeMoney, toMinor } from "../src/money.js";
import { encodeMultipart } from "../src/multipart.js";
import { sanitizeEvidenceFilename } from "../src/requests.js";
import { decodeJwtPart, parseMultipart } from "./fetch-stub.js";

describe("money (integer minor units)", () => {
  it("parses and formats decimal strings without floating point drift", () => {
    expect(toMinor({ currency: "USD", value: "38.50" })).toBe(3850);
    expect(toMinor({ currency: "USD", value: "0.1" })).toBe(10);
    expect(toMinor({ currency: "USD", value: "-4.05" })).toBe(-405);
    expect(toMinor({ currency: "JPY", value: "1200" })).toBe(1200);
    expect(fromMinor(3850, "USD")).toEqual({ currency: "USD", value: "38.50" });
    expect(fromMinor(-5, "USD")).toEqual({ currency: "USD", value: "-0.05" });
    expect(fromMinor(1200, "JPY")).toEqual({ currency: "JPY", value: "1200" });
    expect(normalizeMoney({ currency: "USD", value: "32.5" })).toEqual({ currency: "USD", value: "32.50" });
    expect(toMinor({ currency: "USD", value: "0.1" }) + toMinor({ currency: "USD", value: "0.2" })).toBe(30);
  });

  it("rejects malformed values", () => {
    expect(() => toMinor({ currency: "usd", value: "1.00" })).toThrow(/currency/);
    expect(() => toMinor({ currency: "USD", value: "1,00" })).toThrow(/decimal/);
    expect(() => toMinor({ currency: "USD", value: "1.001" })).toThrow(/decimal places/);
    expect(() => toMinor({ currency: "HUF", value: "10.5" })).toThrow(/decimal places/);
  });
});

describe("multipart encoder", () => {
  it("produces RFC 7578 parts that an independent parser reads back byte for byte", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const { body, contentType, boundary } = encodeMultipart(
      [
        { name: "input", contentType: "application/json", data: '{"a":"ü"}' },
        { name: "evidence-file", filename: 'we"ird\r\nname.pdf', contentType: "application/pdf", data: bytes },
      ],
      "TESTBOUNDARY",
    );
    expect(boundary).toBe("TESTBOUNDARY");
    expect(contentType).toBe("multipart/form-data; boundary=TESTBOUNDARY");
    const parts = parseMultipart(body, contentType);
    expect(parts[0]).toMatchObject({ name: "input", contentType: "application/json", text: '{"a":"ü"}' });
    expect(parts[1]!.filename).toBe("we%22ird%0D%0Aname.pdf");
    expect(Array.from(parts[1]!.data)).toEqual(Array.from(bytes));
  });
});

describe("evidence file names", () => {
  it("match PayPal's document name pattern", () => {
    const pattern = /^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$/;
    for (const [name, type] of [
      ["mandate chain (v2).pdf", "application/pdf"],
      ["évidence.final.PNG", "image/png"],
      [".pdf", "application/pdf"],
      ["no-extension", "image/jpeg"],
      ["../../etc/passwd", "image/gif"],
    ] as const) {
      expect(sanitizeEvidenceFilename(name, type)).toMatch(pattern);
    }
    expect(sanitizeEvidenceFilename("trace.png", "image/png")).toBe("trace.png");
    expect(sanitizeEvidenceFilename("receipt", "image/jpeg")).toBe("receipt.jpg");
  });
});

describe("PayPal-Auth-Assertion", () => {
  it("is an unsigned JWT matching PayPal's documented sandbox example", () => {
    const iss = "AZgbuZOSPtbrHZsk4VGxP19QodU3VOuGTyPHaE6I6BUVoMu2oJzHdLFyW7FjowYZlgUhI8ydsqxzFP-I";
    // From the "Accelerated response" sample in https://developer.paypal.com/disputes/test-go-live/
    const documented =
      "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJBWmdidVpPU1B0YnJIWnNrNFZHeFAxOVFvZFUzVk91R1R5UEhhRTZJNkJVVm9NdTJvSnpIZExGeVc3Rmpvd1labGdVaEk4eWRzcXh6RlAtSSIsImVtYWlsIjoic2ItcmstYnV5ZXJAcGVyc29uYWwuZXhhbXBsZS5jb20ifQ.";
    expect(authAssertion(iss, { email: "sb-rk-buyer@personal.example.com" })).toBe(documented);
    expect(decodeJwtPart(authAssertion("cid", { payer_id: "AJM9JTWQJCFTA" }).split(".")[1]!)).toEqual({ iss: "cid", payer_id: "AJM9JTWQJCFTA" });
    expect(base64Url("??>")).toBe("Pz8-");
  });
});

describe("errors", () => {
  it("handles empty and array bodies", () => {
    expect(errorFromResponse({ status: 500, statusText: "Internal Server Error", bodyText: "" }).name).toBe("HTTP_500");
    expect(errorFromResponse({ status: 400, bodyText: "[1,2]" }).name).toBe("HTTP_400");
  });
});

describe("misc helpers", () => {
  it("normalises Transaction Search dates", () => {
    expect(parseReportingDate("2014-07-11T04:03:52+0000")).toBe("2014-07-11T04:03:52.000Z");
    expect(parseReportingDate("2014-07-11T04:03:52-0700")).toBe("2014-07-11T11:03:52.000Z");
    expect(parseReportingDate("garbage")).toBe("garbage");
  });

  it("generates PayPal-like 17 character ids from a seeded rng", () => {
    const a = createRng("seed");
    const b = createRng("seed");
    const ids = Array.from({ length: 20 }, () => transactionId(a));
    expect(ids).toEqual(Array.from({ length: 20 }, () => transactionId(b)));
    for (const id of ids) expect(id).toMatch(/^[0-9][0-9A-Z]{16}$/);
  });
});
