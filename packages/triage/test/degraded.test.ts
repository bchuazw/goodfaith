import { type PriorReport, type ReportInput, triageVerdictSchema } from "@goodfaith/core";
import { createLlm, type Llm, LlmError, type StructuredInput, withFallback } from "@goodfaith/llm";
import { createLanternRunner, lanternCodeSource } from "@goodfaith/target";
import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../evals/reports.js";
import { affectedCodeComponents, decideVerdict, describeLlmFailure, type TriageDeps, triageReport } from "../src/index.js";

/** Gemini behind a fetch that never answers (an overloaded free tier), with tiny per-call timeouts. */
function hangingGemini() {
  let requests = 0;
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      requests++;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof globalThis.fetch;
  const llm = createLlm({ provider: "gemini", apiKey: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789", model: "gemini-3.8-flash", fetch, timeoutMs: 30, maxRetries: 1, retryBaseDelayMs: 0 });
  return { llm, requests: () => requests };
}

/** A model that answers like the scripted heuristics until `failAt`, then fails with an overload. */
function failingAt(failAt: string): Llm {
  const inner = createLlm({ provider: "scripted" });
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    structured<T>(i: StructuredInput<T>) {
      if (i.name === failAt) return Promise.reject(new LlmError("anthropic API error 529: Overloaded", { code: "http", status: 529, provider: "anthropic", model: "claude-opus-5-5", retryable: true }));
      return inner.structured(i);
    },
    toolLoop: (i) => inner.toolLoop(i),
  };
}

const caseReport = (id: string): ReportInput => {
  const c = EVAL_CASES.find((e) => e.id === id);
  if (!c) throw new Error(`missing eval case ${id}`);
  return c.report;
};

const deps = (llm: Llm, over: Partial<TriageDeps> = {}): TriageDeps => ({
  llm,
  code: lanternCodeSource(),
  target: createLanternRunner(),
  now: () => new Date("2026-11-02T00:00:00.000Z"),
  ...over,
});

const HERO2_PRIOR: PriorReport = {
  id: "rpt_hero2",
  title: "IDOR: read another user's note",
  summary: "Any authenticated user can read another user's private note by id via GET /api/notes/:id",
  vulnClass: "CWE-639",
  components: [{ path: "src/notes.ts", symbol: "getNote" }],
  verdict: "REPRODUCED",
  reportedAt: "2026-10-20T00:00:00.000Z",
};

describe("degraded mode: the LLM is down, triage still finishes on the deterministic checks", () => {
  it("polished slop with a hallucinated function and an injection is NEEDS_HUMAN, never SLOP, without the AI", async () => {
    const { llm, requests } = hangingGemini();
    const v = await triageReport(caseReport("hero1_slop"), deps(llm));
    triageVerdictSchema.parse(v);
    expect(v.verdict).toBe("NEEDS_HUMAN");
    expect(v.model).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", mode: "degraded", degraded: { stage: "claims", reason: "gemini gemini-3.8-flash did not answer in time" } });
    // The facts are still found and shown.
    expect(v.slopSignals.join(" ")).toMatch(/does not exist/);
    expect(v.slopSignals.join(" ")).toMatch(/AI triager/);
    expect(v.summary).toMatch(/^AI unavailable \(gemini gemini-3\.8-flash did not answer in time\), so only the deterministic checks ran\./);
    expect(v.summary).toMatch(/AI assessment was unavailable and SLOP needs it/);
    expect(v.researcherSummary).toMatch(/AI reviewer was unavailable/);
    expect(v.findings.some((f) => f.title === "AI unavailable: deterministic checks only")).toBe(true);
    // Which checks ran, in plain English.
    const checks = v.model.degraded?.checks ?? [];
    expect(checks.some((c) => c.startsWith("Version: 1.4.0 exists"))).toBe(true);
    expect(checks.some((c) => c.startsWith("Cited code:"))).toBe(true);
    expect(checks.some((c) => /^Prompt-injection scan: [1-9]\d* instruction/.test(c))).toBe(true);
    expect(checks.some((c) => c.startsWith("Duplicates:"))).toBe(true);
    expect(checks.some((c) => c.startsWith("Replay:"))).toBe(true);
    // Circuit breaker: only the first LLM call (and its one retry) was attempted.
    expect(requests()).toBe(2);
  });

  it("a canary hit from the structured PoC is still REPRODUCED", async () => {
    const { llm } = hangingGemini();
    const v = await triageReport(caseReport("hero2_real_idor"), deps(llm));
    expect(v.verdict).toBe("REPRODUCED");
    expect(v.model.mode).toBe("degraded");
    expect(v.replay?.canaryHits.length).toBeGreaterThan(0);
    expect(v.suggestedSeverity?.rationale).toMatch(/^Provisional, by rule \(AI unavailable\)/);
    expect(v.researcherSummary).toMatch(/reproduced.*AI reviewer was unavailable/);
    expect(v.model.degraded?.checks.some((c) => /structured PoC ran in the sandbox .* reproduced/.test(c))).toBe(true);
  });

  it("a duplicate is still found by class and component", async () => {
    const { llm } = hangingGemini();
    const v = await triageReport(caseReport("hero3_duplicate"), deps(llm, { priorReports: [HERO2_PRIOR] }));
    expect(v.verdict).toBe("DUPLICATE");
    expect(v.duplicateOf).toBe("rpt_hero2");
    expect(v.model.mode).toBe("degraded");
  });

  it("only the structured PoC is replayed: a PoC written in prose needs the AI", async () => {
    const { llm } = hangingGemini();
    const report: ReportInput = {
      ...caseReport("hero2_real_idor"),
      id: "rpt_prose",
      poc: undefined,
      body: "GET /api/notes/:id in src/notes.ts has no owner check (CWE-639).\n\nPoC:\nGET /api/notes/note_2  (as alice)",
    };
    const v = await triageReport(report, deps(llm));
    expect(v.verdict).toBe("NEEDS_HUMAN");
    expect(v.replay).toBeUndefined();
    expect(v.findings.some((f) => f.title === "Free-text PoC not replayed (AI unavailable)")).toBe(true);
    // With the (scripted) AI available the same prose PoC is parsed and reproduces.
    const live = await triageReport(report, deps(createLlm({ provider: "scripted" })));
    expect(live.verdict).toBe("REPRODUCED");
  });

  it("the form's Affected code field leads the cited code", async () => {
    const { llm } = hangingGemini();
    const report: ReportInput = {
      ...caseReport("hero2_real_idor"),
      id: "rpt_form",
      poc: undefined,
      body: ["## Affected code", "- `src/session.ts`, `lantern_session_rehydrate()`", "", "## Description", "Sessions can be replayed after logout; see the notes handler in src/notes.ts."].join("\n"),
    };
    const v = await triageReport(report, deps(llm));
    expect(v.claims.components[0]).toEqual({ path: "src/session.ts", symbol: "lantern_session_rehydrate" });
    expect(v.findings.some((f) => f.kind === "code_ref" && f.status === "fail" && /src\/session\.ts/.test(f.title))).toBe(true);
    expect(v.model.degraded?.checks.some((c) => c.includes("(1 from the Affected code field)"))).toBe(true);
    expect(v.verdict).toBe("NEEDS_HUMAN"); // hard evidence, but SLOP needs the AI
  });

  it("a model that fails mid-run degrades from that stage on", async () => {
    const v = await triageReport(caseReport("hero1_slop"), deps(failingAt("triage_assessment")));
    expect(v.model).toMatchObject({ mode: "degraded", degraded: { stage: "assess", reason: "anthropic claude-opus-5-5 returned HTTP 529 (overloaded)" } });
    expect(v.verdict).toBe("NEEDS_HUMAN");
    // The same report with the model healthy is SLOP.
    expect((await triageReport(caseReport("hero1_slop"), deps(createLlm({ provider: "scripted" })))).verdict).toBe("SLOP");
  });

  it("the AI time budget running out degrades the run and says so", async () => {
    const v = await triageReport(caseReport("hero2_real_idor"), deps(hangingGeminiNoTimeout()), { llmBudgetMs: 60 });
    expect(v.model.degraded?.reason).toBe("gemini gemini-hang was cancelled: the AI time budget was used up");
    expect(v.verdict).toBe("REPRODUCED");
  });
});

function hangingGeminiNoTimeout(): Llm {
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof globalThis.fetch;
  return createLlm({ provider: "gemini", apiKey: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789", model: "gemini-hang", fetch, timeoutMs: 60_000, maxRetries: 2 });
}

describe("degraded mode helpers", () => {
  it("the policy never returns SLOP without the AI, but REPRODUCED and DUPLICATE still stand", () => {
    const base = { versionProvided: true, versionResolves: true, canaryHit: false, hardCodeRefFailure: true, injectionDetected: true, slopScore: 0.99 };
    expect(decideVerdict(base).verdict).toBe("SLOP");
    expect(decideVerdict({ ...base, aiUnavailable: true })).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: [expect.stringMatching(/AI assessment was unavailable/)] });
    expect(decideVerdict({ ...base, aiUnavailable: true, canaryHit: true }).verdict).toBe("REPRODUCED");
    const dup = { ofId: "r1", similarity: 0.8, sameClassAndComponent: true, priorAccepted: true };
    expect(decideVerdict({ ...base, hardCodeRefFailure: false, injectionDetected: false, aiUnavailable: true, duplicate: dup }).verdict).toBe("DUPLICATE");
  });

  it("reads the Affected code section: file + symbol per line, bare files, bare symbols", () => {
    const body = ["## Affected code", "- `src/notes.ts`, `getNote()`", "* src/attachments.ts:42", "1. `renderAdmin()`", "", "## Description", "`notInTheSection()` in src/users.ts"].join("\n");
    expect(affectedCodeComponents(body)).toEqual([
      { path: "src/notes.ts", symbol: "getNote" },
      { path: "src/attachments.ts", line: 42 },
      { path: "", symbol: "renderAdmin" },
    ]);
    expect(affectedCodeComponents("## Description\nno section here")).toEqual([]);
  });

  it("describes LLM failures in one plain line", () => {
    const err = (code: ConstructorParameters<typeof LlmError>[1]["code"], status?: number) => new LlmError("x", { code, provider: "anthropic", model: "claude-opus-5-5", ...(status ? { status } : {}) });
    expect(describeLlmFailure(err("http", 401))).toBe("anthropic claude-opus-5-5 returned HTTP 401 (authentication failed)");
    expect(describeLlmFailure(err("http", 429))).toBe("anthropic claude-opus-5-5 returned HTTP 429 (rate limited)");
    expect(describeLlmFailure(err("timeout"))).toBe("anthropic claude-opus-5-5 did not answer in time");
    expect(describeLlmFailure(err("refusal"))).toBe("anthropic claude-opus-5-5 declined the request");
    expect(describeLlmFailure(new Error("boom"))).toBe("The AI failed: boom");
  });
});

describe("provider fallback in triage", () => {
  /** Answers like the scripted heuristics but as a named model, so the verdict can show who answered. */
  const namedModel = (provider: string, model: string): Llm => {
    const inner = createLlm({ provider: "scripted" });
    return {
      provider,
      model,
      structured: async <T>(i: StructuredInput<T>) => {
        const v = await inner.structured({ ...i, onAnswer: undefined });
        i.onAnswer?.({ provider, model });
        return v;
      },
      toolLoop: (i) => inner.toolLoop(i),
    };
  };
  const deadClaude: Llm = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    structured: () => Promise.reject(new LlmError("anthropic API error 401: invalid x-api-key", { code: "http", status: 401, provider: "anthropic", model: "claude-opus-5-5" })),
    toolLoop: () => Promise.reject(new Error("unused")),
  };

  it("records the fallback model that actually answered", async () => {
    const llm = withFallback(deadClaude, [namedModel("gemini", "gemini-3.5-flash")]);
    const v = await triageReport(caseReport("hero1_slop"), deps(llm));
    expect(v.model).toEqual({ provider: "gemini", model: "gemini-3.5-flash", mode: "live" });
    expect(v.verdict).toBe("SLOP"); // a working fallback is the AI: SLOP stays possible
  });

  it("when every model fails, the degraded reason names each one", async () => {
    const overloaded: Llm = { ...deadClaude, provider: "gemini", model: "gemini-3.5-flash", structured: () => Promise.reject(new LlmError("503", { code: "http", status: 503, provider: "gemini", model: "gemini-3.5-flash" })) };
    const v = await triageReport(caseReport("hero1_slop"), deps(withFallback(deadClaude, [overloaded])));
    expect(v.model.mode).toBe("degraded");
    expect(v.model.degraded?.reason).toBe("anthropic claude-opus-5-5 returned HTTP 401 (authentication failed); then gemini gemini-3.5-flash returned HTTP 503 (overloaded)");
    expect(v.verdict).toBe("NEEDS_HUMAN");
  });
});

