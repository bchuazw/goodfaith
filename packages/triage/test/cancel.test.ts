import type { ReportInput } from "@goodfaith/core";
import { createLlm } from "@goodfaith/llm";
import { createLanternRunner, lanternCodeSource } from "@goodfaith/target";
import { describe, expect, it } from "vitest";
import { triageReport } from "../src/index.js";

/** Gemini behind a fetch that never answers (an overloaded free tier); records each request's signal. */
function hangingGemini(opts: { timeoutMs: number; maxRetries: number }) {
  const signals: AbortSignal[] = [];
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof globalThis.fetch;
  const llm = createLlm({ provider: "gemini", apiKey: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789", model: "gemini-hang", fetch, retryBaseDelayMs: 0, ...opts });
  return { llm, signals };
}

const IDOR: ReportInput = {
  id: "rpt_cancel",
  programId: "lantern",
  title: "IDOR on note read",
  body: "GET /api/notes/:id in src/notes.ts does not check ownership (CWE-639).",
  claimedVersion: "1.4.0",
  poc: { steps: [{ method: "GET", path: "/api/notes/note_2", as: "alice" }] },
  reporter: { handle: "researcher" },
  submittedAt: "2026-02-01T00:00:00.000Z",
};

const deps = (llm: ReturnType<typeof createLlm>) => ({ llm, code: lanternCodeSource(), target: createLanternRunner() });

describe("triageReport: cancellation reaches the LLM", () => {
  it("aborting the run aborts the in-flight model request and rejects at once", async () => {
    const { llm, signals } = hangingGemini({ timeoutMs: 60_000, maxRetries: 2 });
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 50);
    const err = await triageReport(IDOR, deps(llm), { signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signals).toHaveLength(1); // the claims call, never retried
    expect(signals[0]?.aborted).toBe(true);
  });

  it("an already-aborted run never calls the model", async () => {
    const { llm, signals } = hangingGemini({ timeoutMs: 60_000, maxRetries: 0 });
    const ctl = new AbortController();
    ctl.abort(new Error("stop"));
    await expect(triageReport(IDOR, deps(llm), { signal: ctl.signal })).rejects.toThrow("stop");
    expect(signals).toHaveLength(0);
  });

  it("the LLM budget cancels a hung model and the run still finishes with a verdict", async () => {
    const { llm, signals } = hangingGemini({ timeoutMs: 60_000, maxRetries: 2 });
    const started = Date.now();
    const v = await triageReport(IDOR, deps(llm), { llmBudgetMs: 80 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(v.verdict).toBe("REPRODUCED"); // the structured PoC still replays: a canary hit is a fact
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("per-call timeouts bound a hung model even without a budget", async () => {
    const { llm, signals } = hangingGemini({ timeoutMs: 30, maxRetries: 1 });
    const v = await triageReport(IDOR, deps(llm));
    expect(v.verdict).toBe("REPRODUCED");
    expect(signals.length).toBeGreaterThanOrEqual(2); // the first call timed out and was retried once
  });
});
