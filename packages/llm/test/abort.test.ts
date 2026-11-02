import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm, defineTool, LlmError, type LlmLogEntry } from "../src/index.js";
import { json, makeFetch } from "./helpers.js";

const KEY = "sk-ant-api03-SECRETSECRETSECRET0123456789";
const schema = z.object({ ok: z.boolean() });

/** A fetch that never answers until its own signal aborts, recording the signal it was given. */
function hangingRecorder() {
  const signals: AbortSignal[] = [];
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof globalThis.fetch;
  return { fetch, signals };
}

describe("cancellation (AbortSignal on structured and toolLoop)", () => {
  it("an already-aborted signal rejects with code 'aborted' and calls nothing", async () => {
    const { fetch, calls } = makeFetch(() => json({}));
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch });
    const ctl = new AbortController();
    ctl.abort();
    const err = await llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "aborted", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("aborting a hung call stops it at once: no retry, and the HTTP request itself is aborted", async () => {
    const hang = hangingRecorder();
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch: hang.fetch, timeoutMs: 60_000, maxRetries: 2, onLog: (e) => logs.push(e) });
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 30);
    const err = await llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hang.signals).toHaveLength(1); // one attempt, never retried
    expect(hang.signals[0]?.aborted).toBe(true);
    expect(logs.map((l) => [l.ok, l.willRetry])).toEqual([[false, false]]);
  });

  it("aborting during a retry backoff ends the call without another attempt", async () => {
    const { fetch, calls } = makeFetch(() => json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, { "retry-after": "30" }));
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, maxRetries: 3, retryMaxDelayMs: 60_000 });
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 50);
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it("a cancelled call says why when the caller gives a reason", async () => {
    const hang = hangingRecorder();
    const llm = createLlm({ provider: "gemini", apiKey: "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789", fetch: hang.fetch, timeoutMs: 60_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("triage budget used up")), 20);
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal })).rejects.toThrow(/cancelled: triage budget used up/);
  });

  it("the per-attempt timeout still applies when a signal is given", async () => {
    const hang = hangingRecorder();
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch: hang.fetch, timeoutMs: 40, maxRetries: 1, retryBaseDelayMs: 0 });
    const ctl = new AbortController();
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal })).rejects.toMatchObject({ code: "timeout" });
    expect(hang.signals).toHaveLength(2); // the first attempt timed out and was retried once
    expect(hang.signals.every((s) => s.aborted)).toBe(true);
  });

  it("toolLoop: aborting stops a running tool and the loop", async () => {
    let toolStarted = false;
    const slowTool = defineTool({
      name: "slow_lookup",
      description: "Never finishes.",
      parameters: z.object({}),
      execute: () => {
        toolStarted = true;
        return new Promise(() => undefined);
      },
    });
    const llm = createLlm({ provider: "scripted", script: [{ type: "tool_calls", calls: [{ name: "slow_lookup", args: {} }] }, { type: "final", text: "done" }] });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const started = Date.now();
    await expect(llm.toolLoop({ system: "s", user: "u", tools: [slowTool], maxSteps: 3, signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(toolStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the scripted provider honours an aborted signal too", async () => {
    const llm = createLlm({ provider: "scripted" });
    const ctl = new AbortController();
    ctl.abort();
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
