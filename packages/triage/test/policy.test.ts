import { describe, expect, it } from "vitest";
import { decideVerdict, type PolicyInput } from "../src/index.js";

const base: PolicyInput = {
  versionProvided: true,
  versionResolves: true,
  canaryHit: false,
  hardCodeRefFailure: false,
  injectionDetected: false,
  slopScore: 0.1,
};

const dup = (over: Partial<PolicyInput["duplicate"]> = {}): PolicyInput["duplicate"] => ({
  ofId: "rpt_1",
  similarity: 0.9,
  sameClassAndComponent: true,
  priorAccepted: true,
  ...over,
});

describe("decideVerdict: REPRODUCED (ground truth wins)", () => {
  it("a canary hit is REPRODUCED with high confidence", () => {
    const r = decideVerdict({ ...base, canaryHit: true });
    expect(r.verdict).toBe("REPRODUCED");
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it("a canary hit beats hard fabrication signals and a strong duplicate", () => {
    expect(decideVerdict({ ...base, canaryHit: true, hardCodeRefFailure: true, injectionDetected: true, slopScore: 1 }).verdict).toBe("REPRODUCED");
    expect(decideVerdict({ ...base, canaryHit: true, duplicate: dup() }).verdict).toBe("REPRODUCED");
  });
});

describe("decideVerdict: DUPLICATE", () => {
  it("same class+component, accepted prior, similarity >= 0.8", () => {
    const r = decideVerdict({ ...base, duplicate: dup({ similarity: 0.85 }) });
    expect(r.verdict).toBe("DUPLICATE");
    expect(r.confidence).toBeCloseTo(0.85);
  });

  it("is not DUPLICATE below 0.8, or without class+component, or when the prior was not accepted", () => {
    expect(decideVerdict({ ...base, duplicate: dup({ similarity: 0.79 }) }).verdict).toBe("NEEDS_HUMAN");
    expect(decideVerdict({ ...base, duplicate: dup({ sameClassAndComponent: false }) }).verdict).toBe("NEEDS_HUMAN");
    expect(decideVerdict({ ...base, duplicate: dup({ priorAccepted: false }) }).verdict).toBe("NEEDS_HUMAN");
  });
});

describe("decideVerdict: SLOP (hard evidence AND the LLM agrees)", () => {
  it("fires on an invalid version, a hard code-ref failure or an injection, when slopScore >= 0.7", () => {
    expect(decideVerdict({ ...base, versionResolves: false, slopScore: 0.7 }).verdict).toBe("SLOP");
    expect(decideVerdict({ ...base, hardCodeRefFailure: true, slopScore: 0.8 }).verdict).toBe("SLOP");
    expect(decideVerdict({ ...base, injectionDetected: true, slopScore: 0.9 }).verdict).toBe("SLOP");
  });

  it("confidence equals the (clamped) slop score", () => {
    expect(decideVerdict({ ...base, hardCodeRefFailure: true, slopScore: 0.82 }).confidence).toBeCloseTo(0.82);
    expect(decideVerdict({ ...base, hardCodeRefFailure: true, slopScore: 5 }).confidence).toBe(1);
  });

  it("needs hard evidence: a high slop score alone is never SLOP", () => {
    expect(decideVerdict({ ...base, slopScore: 0.99 }).verdict).toBe("NEEDS_HUMAN");
  });

  it("needs the LLM to agree: hard evidence with slopScore < 0.7 is NEEDS_HUMAN", () => {
    expect(decideVerdict({ ...base, hardCodeRefFailure: true, slopScore: 0.69 }).verdict).toBe("NEEDS_HUMAN");
  });

  it("a missing (not fabricated) version is not hard evidence", () => {
    expect(decideVerdict({ ...base, versionProvided: false, versionResolves: false, slopScore: 0.9 }).verdict).toBe("NEEDS_HUMAN");
  });

  it("a hard code-ref failure is enough even without a version", () => {
    expect(decideVerdict({ ...base, versionProvided: false, versionResolves: false, hardCodeRefFailure: true, slopScore: 0.8 }).verdict).toBe("SLOP");
  });
});

describe("decideVerdict: NEEDS_HUMAN and the no-favour rule", () => {
  it("is the default when nothing is conclusive", () => {
    expect(decideVerdict(base).verdict).toBe("NEEDS_HUMAN");
    expect(decideVerdict({ ...base, slopScore: Number.NaN }).verdict).toBe("NEEDS_HUMAN");
  });

  it("an injection can only push toward SLOP, never toward a favourable verdict", () => {
    // Injection + low slop score: it does not become REPRODUCED or DUPLICATE; it stays neutral/negative.
    const r = decideVerdict({ ...base, injectionDetected: true, slopScore: 0.3 });
    expect(r.verdict).toBe("NEEDS_HUMAN");
    expect(["REPRODUCED", "DUPLICATE"]).not.toContain(r.verdict);
  });
});
