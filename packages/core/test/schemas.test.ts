import { describe, expect, it } from "vitest";
import { httpPocSchema, reportInputSchema } from "../src/index.js";

describe("httpPocSchema", () => {
  it("accepts target-relative steps", () => {
    expect(httpPocSchema.parse({ steps: [{ method: "GET", path: "/api/notes/2", as: "alice" }] }).steps).toHaveLength(1);
  });

  it("rejects absolute and protocol-relative URLs, reserved headers, and empty or oversized PoCs", () => {
    expect(httpPocSchema.safeParse({ steps: [{ method: "GET", path: "https://evil.example/x" }] }).success).toBe(false);
    expect(httpPocSchema.safeParse({ steps: [{ method: "GET", path: "//evil.example/x" }] }).success).toBe(false);
    expect(httpPocSchema.safeParse({ steps: [{ method: "GET", path: "/x", headers: { Cookie: "sid=1" } }] }).success).toBe(false);
    expect(httpPocSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(httpPocSchema.safeParse({ steps: Array.from({ length: 21 }, () => ({ method: "GET", path: "/" })) }).success).toBe(false);
  });
});

describe("reportInputSchema", () => {
  it("validates a submitted report", () => {
    const r = reportInputSchema.parse({
      id: "r_1",
      programId: "lantern",
      title: "IDOR on GET /api/notes/:id",
      body: "Any signed-in user can read any note.",
      claimedVersion: "1.4.0",
      claimedSeverity: "high",
      reporter: { handle: "maya" },
      submittedAt: "2026-10-24T08:00:00.000Z",
    });
    expect(r.programId).toBe("lantern");
  });
});
