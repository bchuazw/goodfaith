import type { TriageEvent } from "@goodfaith/core";
import { createLlm } from "@goodfaith/llm";
import { describe, expect, it } from "vitest";
import { llmForMode, TRIAGE_LLM_DEFAULTS, triageLlmEnv } from "@/lib/server/mode";
import { submitReport } from "@/lib/server/reports";
import { DEFAULT_CONFIG } from "@/lib/server/services";
import type { TriageEngine } from "@/lib/server/triage-engine";
import { reconcileTriage, rerunTriage, runTriage, triageEvents } from "@/lib/server/triage";
import { heroInput, testEnv, triagedClaim } from "./helpers";

describe("triage service", () => {
  it("stores every event in order and ends with the verdict", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "idor");
    const events = await triageEvents(env.svc, id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.attempt === 1)).toBe(true);
    const stages = events.filter((e) => e.event.type === "stage").map((e) => `${(e.event as Extract<TriageEvent, { type: "stage" }>).stage}:${(e.event as Extract<TriageEvent, { type: "stage" }>).status}`);
    expect(stages[0]).toBe("claims:start");
    expect(stages.at(-1)).toBe("verdict:done");
    expect(events.some((e) => e.event.type === "replay_step" && e.event.step.status === 200)).toBe(true);
    expect(events.at(-1)?.event.type).toBe("verdict");
    expect((await env.svc.db.reports.value(id))?.triage).toMatchObject({ attempt: 1, engine: "triage", finishedAt: expect.any(String) });
  });

  it("runs once per attempt even when two instances try to start it", async () => {
    const env = testEnv();
    let runs = 0;
    const counting: TriageEngine = { kind: "fixture", run: async (...args) => (runs++, env.svc.triage.run(...args)) };
    const svc = { ...env.svc, triage: counting };
    const { report } = await submitReport(svc, heroInput("idor", "free"));
    await Promise.all([runTriage(svc, report.id), runTriage(svc, report.id), runTriage(svc, report.id)]);
    expect(runs).toBe(1);
    expect((await svc.db.reports.value(report.id))?.status).toBe("triaged");
  });

  it("records a failure instead of hanging, and a re-run starts attempt 2", async () => {
    const env = testEnv();
    const failing: TriageEngine = {
      kind: "fixture",
      run: async (report, _deps, opts) => {
        opts?.onEvent?.({ type: "stage", stage: "claims", status: "start", at: new Date().toISOString() });
        throw new Error(`model unavailable for ${report.id}`);
      },
    };
    const svc = { ...env.svc, triage: failing };
    const { report } = await submitReport(svc, heroInput("slop", "free"));
    await env.drain(); // the deferred run uses the failing engine
    expect(await svc.db.reports.value(report.id)).toMatchObject({ status: "triage_failed", triage: { attempt: 1, error: expect.stringContaining("model unavailable") } });

    const ok = { ...env.svc };
    await rerunTriage(ok, report.id);
    await env.drain();
    const after = await ok.db.reports.value(report.id);
    expect(after).toMatchObject({ status: "triaged", triage: { attempt: 2 } });
    const events = await triageEvents(ok, report.id);
    expect(new Set(events.map((e) => e.attempt))).toEqual(new Set([1, 2]));
  });

  it("marks a run abandoned by a dead instance as failed once it is stale", async () => {
    let now = Date.parse("2026-10-24T00:00:00Z");
    const env = testEnv({ now: () => new Date(now) });
    const { report } = await submitReport(env.svc, heroInput("idor", "free"));
    // Simulate an instance that claimed the run and died.
    await env.svc.db.reports.update(report.id, (r) => (r ? { ...r, status: "triaging", triage: { attempt: 1, claimedAt: new Date(now).toISOString() } } : r) as never);
    now += env.svc.config.triageStaleMs + 1000;
    const reconciled = await reconcileTriage(env.svc, (await env.svc.db.reports.value(report.id)) as never);
    expect(reconciled).toMatchObject({ status: "triage_failed", triage: { error: expect.stringContaining("interrupted") } });
  });

  it("trusted researchers claim bounties without a deposit", async () => {
    const env = testEnv();
    const { settle } = await import("@/lib/server/settlement");
    const { approveDeposit, createDepositOrder } = await import("@/lib/server/deposits");
    // trustAfterVerified is 3: three distinct, reproduced and paid Lantern 1.4.0 bugs from one handle.
    const bugs = [
      { title: "IDOR on GET /api/notes/:id leaks private notes", body: "GET /api/notes/:id in `src/notes.ts` has no owner check (CWE-639 IDOR).", steps: [{ method: "GET" as const, path: "/api/notes/note_2", as: "alice" }] },
      { title: "Path traversal in attachment download reads secrets.env", body: "GET /api/attachments/download in `src/attachments.ts` joins the file name without normalising it: path traversal (CWE-22).", steps: [{ method: "GET" as const, path: "/api/attachments/download?file=../secrets.env", as: "alice" }] },
      { title: "Mass assignment of role on PATCH /api/users/me grants admin", body: "PATCH /api/users/me in `src/users.ts` copies the whole body onto the user, including role (CWE-915 mass assignment).", steps: [{ method: "PATCH" as const, path: "/api/users/me", body: JSON.stringify({ role: "admin" }), as: "alice" }, { method: "GET" as const, path: "/api/admin/users", as: "alice" }] },
    ];
    for (const bug of bugs) {
      const { report } = await submitReport(env.svc, { kind: "bounty", title: bug.title, body: bug.body, claimedVersion: "1.4.0", claimedSeverity: "high", poc: { steps: bug.steps }, reporter: { handle: "steady_hand" } });
      const { deposit } = await createDepositOrder(env.svc, report.id, { origin: "http://localhost:3000" });
      env.paypal.simulateBuyerApproval(deposit.orderId, { email: "steady@example.com" });
      await approveDeposit(env.svc, report.id, { orderId: deposit.orderId });
      await env.drain();
      expect((await env.svc.db.verdicts.value(report.id))?.verdict).toBe("REPRODUCED");
      await settle(env.svc, report.id, { action: "pay" });
    }
    const { report, depositRequired } = await submitReport(env.svc, { kind: "bounty", title: "A fourth finding from a trusted researcher", body: "Details follow in the PoC section of this report.", reporter: { handle: "@Steady_Hand" } });
    expect(depositRequired).toBe(false);
    expect(report.input.reporter.trusted).toBe(true);
    expect(report.status).toBe("queued");
  });
});

/** Gemini behind a fetch that never answers (an overloaded free tier); records each request's signal. */
function hangingGemini(timeoutMs = 60_000) {
  const signals: AbortSignal[] = [];
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof globalThis.fetch;
  return { llm: createLlm({ provider: "gemini", apiKey: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789", model: "gemini-hang", fetch, timeoutMs, maxRetries: 1, retryBaseDelayMs: 0 }), signals };
}

const stageEvent = (stage: "claims", status: "start" | "done"): TriageEvent => ({ type: "stage", stage, status, at: new Date().toISOString() });

describe("triage time limits (a hosted function has 300 s)", () => {
  it("a hung engine that ignores the abort still ends as triage_failed at the hard limit, and can be re-run", async () => {
    const env = testEnv({ config: { triageTimeoutMs: 120 } });
    let emitLate: (() => void) | undefined;
    const hung: TriageEngine = {
      kind: "fixture",
      run: (_report, _deps, opts) => {
        opts?.onEvent?.(stageEvent("claims", "start"));
        emitLate = () => opts?.onEvent?.(stageEvent("claims", "done"));
        return new Promise(() => undefined); // never settles, never looks at the signal
      },
    };
    const svc = { ...env.svc, triage: hung };
    const { report } = await submitReport(svc, heroInput("idor", "free"));
    const started = Date.now();
    await env.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await svc.db.reports.value(report.id)).toMatchObject({ status: "triage_failed", triage: { attempt: 1, error: expect.stringMatching(/stopped after 0 s; re-run/) } });

    emitLate?.(); // a stray event from the abandoned run is not written to the attempt
    await new Promise((r) => setTimeout(r, 20));
    expect(await triageEvents(svc, report.id)).toHaveLength(1);

    await rerunTriage(env.svc, report.id);
    await env.drain();
    expect(await env.svc.db.reports.value(report.id)).toMatchObject({ status: "triaged", triage: { attempt: 2 } });
  });

  it("a model that never answers is cancelled at the hard limit: its request is aborted and the run fails cleanly", async () => {
    const { llm, signals } = hangingGemini();
    const env = testEnv({ llm, config: { triageTimeoutMs: 150, triageLlmBudgetMs: 60_000 } });
    const { report } = await submitReport(env.svc, heroInput("idor", "free"));
    const started = Date.now();
    await env.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await env.svc.db.reports.value(report.id)).toMatchObject({ status: "triage_failed" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(await env.svc.db.verdicts.value(report.id)).toBeUndefined();
  });

  it("when the AI budget runs out first, the run still finishes with a verdict", async () => {
    const { llm, signals } = hangingGemini();
    const env = testEnv({ llm, config: { triageTimeoutMs: 5_000, triageLlmBudgetMs: 80 } });
    const { report } = await submitReport(env.svc, heroInput("idor", "free"));
    await env.drain();
    expect(await env.svc.db.reports.value(report.id)).toMatchObject({ status: "triaged" });
    expect((await env.svc.db.verdicts.value(report.id))?.verdict).toBe("REPRODUCED");
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("the defaults fit: 45 s per LLM attempt, one retry, a budget below the hard limit, and both well inside 300 s", () => {
    expect(triageLlmEnv({})).toMatchObject(TRIAGE_LLM_DEFAULTS);
    expect(triageLlmEnv({ LLM_TIMEOUT_MS: "20000", LLM_MAX_RETRIES: " " })).toMatchObject({ LLM_TIMEOUT_MS: "20000", LLM_MAX_RETRIES: "1" });
    const perCall = Number(TRIAGE_LLM_DEFAULTS.LLM_TIMEOUT_MS) * (1 + Number(TRIAGE_LLM_DEFAULTS.LLM_MAX_RETRIES));
    expect(perCall).toBeLessThanOrEqual(DEFAULT_CONFIG.triageLlmBudgetMs);
    expect(DEFAULT_CONFIG.triageLlmBudgetMs).toBeLessThan(DEFAULT_CONFIG.triageTimeoutMs);
    expect(DEFAULT_CONFIG.triageTimeoutMs).toBeLessThanOrEqual(240_000);
    expect(DEFAULT_CONFIG.triageStaleMs).toBeGreaterThan(DEFAULT_CONFIG.triageTimeoutMs);
  });
});

describe("degraded mode in the web app", () => {
  it("with the AI down, a slop claim is triaged NEEDS_HUMAN on the deterministic checks and its deposit cannot be captured", async () => {
    const { settle } = await import("@/lib/server/settlement");
    const { queueRows } = await import("@/lib/server/views");
    const { llm } = hangingGemini(30);
    const env = testEnv({ llm });
    const id = await triagedClaim(env, "slop");
    expect(await env.svc.db.reports.value(id)).toMatchObject({ status: "triaged" });
    const v = await env.svc.db.verdicts.value(id);
    expect(v).toMatchObject({ verdict: "NEEDS_HUMAN", model: { mode: "degraded", degraded: { stage: "claims", reason: expect.stringContaining("did not answer in time") } } });
    expect(v?.model.degraded?.checks.length).toBeGreaterThanOrEqual(5);
    expect((await queueRows(env.svc)).find((r) => r.id === id)).toMatchObject({ verdict: "NEEDS_HUMAN", aiUnavailable: true });
    await expect(settle(env.svc, id, { action: "capture", confirm: true })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });
});

describe("provider fallback in live mode", () => {
  it("LLM_FALLBACK_PROVIDER / LLM_FALLBACK_MODEL chain Claude to Gemini, and the mode badge shows both", () => {
    const llm = llmForMode("live", {
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-api03-TESTTESTTESTTEST0123456789",
      GEMINI_API_KEY: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789",
      LLM_FALLBACK_PROVIDER: "gemini",
      LLM_FALLBACK_MODEL: "gemini-3.5-flash",
    });
    expect([llm.provider, llm.model, llm.fallbacks]).toEqual(["anthropic", "claude-opus-5-5", [{ provider: "gemini", model: "gemini-3.5-flash" }]]);
    const env = testEnv({ llm });
    expect(env.svc.mode.llm).toEqual({ provider: "anthropic", model: "claude-opus-5-5", fallbacks: [{ provider: "gemini", model: "gemini-3.5-flash" }] });
  });
});

