import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm, LlmError, LlmFallbackError, llmFromEnv, shouldFallBack, withFallback } from "../src/index.js";
import { json, makeFetch } from "./helpers.js";

const ANTHROPIC_KEY = "sk-ant-api03-SECRETSECRETSECRET0123456789";
const GEMINI_KEY = "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789";
const schema = z.object({ ok: z.boolean() });

const claudeMessage = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const geminiResponse = (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }] });
const anthropicError = (status: number, type: string) => json({ type: "error", error: { type, message: type } }, status);

/** One fetch for both providers: Anthropic answers with `claude(i)`, Gemini with `{"ok":true}`. */
function twoProviders(claude: (i: number) => Response | Promise<Response>) {
  let claudeCalls = 0;
  let geminiCalls = 0;
  const { fetch } = makeFetch((req) => {
    if (req.url.includes("anthropic.com")) return claude(claudeCalls++);
    geminiCalls++;
    return json(geminiResponse('{"ok":true}'));
  });
  const chain = () =>
    withFallback(createLlm({ provider: "anthropic", apiKey: ANTHROPIC_KEY, fetch, maxRetries: 0, timeoutMs: 50 }), [
      createLlm({ provider: "gemini", apiKey: GEMINI_KEY, model: "gemini-3.5-flash", fetch, maxRetries: 0 }),
    ]);
  return { chain, claudeCalls: () => claudeCalls, geminiCalls: () => geminiCalls };
}

const hang = () => new Promise<Response>(() => undefined);

describe("provider fallback", () => {
  it.each([
    ["an auth error (401)", () => anthropicError(401, "authentication_error")],
    ["a rate limit (429)", () => anthropicError(429, "rate_limit_error")],
    ["an overload (529)", () => anthropicError(529, "overloaded_error")],
    ["a 503", () => anthropicError(503, "api_error")],
    ["a refusal", () => json(claudeMessage("", "refusal"))],
  ])("falls back on %s and reports the model that answered", async (_label, failure) => {
    const p = twoProviders(failure);
    const llm = p.chain();
    let by: unknown;
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", onAnswer: (b) => (by = b) })).resolves.toEqual({ ok: true });
    expect(by).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
    expect([p.claudeCalls(), p.geminiCalls()]).toEqual([1, 1]);
    expect(llm.provider).toBe("anthropic");
    expect(llm.fallbacks).toEqual([{ provider: "gemini", model: "gemini-3.5-flash" }]);
  });

  it("falls back on a timeout", async () => {
    const p = twoProviders(hang);
    await expect(p.chain().structured({ system: "s", user: "u", schema, name: "x" })).resolves.toEqual({ ok: true });
    expect([p.claudeCalls(), p.geminiCalls()]).toEqual([1, 1]);
  });

  it("the primary answers when it is healthy", async () => {
    const p = twoProviders(() => json(claudeMessage('{"ok":true}')));
    let by: unknown;
    await p.chain().structured({ system: "s", user: "u", schema, name: "x", onAnswer: (b) => (by = b) });
    expect(by).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(p.geminiCalls()).toBe(0);
  });

  it("never falls back on our own bugs: a 400, or output that does not match the schema", async () => {
    const bad = twoProviders(() => anthropicError(400, "invalid_request_error"));
    await expect(bad.chain().structured({ system: "s", user: "u", schema, name: "x" })).rejects.toMatchObject({ code: "http", status: 400 });
    expect(bad.geminiCalls()).toBe(0);

    const junk = twoProviders(() => json(claudeMessage('{"ok":"definitely"}')));
    await expect(junk.chain().structured({ system: "s", user: "u", schema, name: "x" })).rejects.toMatchObject({ code: "validation" });
    expect(junk.claudeCalls()).toBe(2); // the first answer and its repair, both from Claude
    expect(junk.geminiCalls()).toBe(0);
  });

  it("never falls back when the caller cancels", async () => {
    const p = twoProviders(hang);
    const llm = withFallback(createLlm({ provider: "anthropic", apiKey: ANTHROPIC_KEY, fetch: makeFetch(hang).fetch, timeoutMs: 60_000 }), [createLlm({ provider: "scripted" })]);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(p.geminiCalls()).toBe(0);
  });

  it("skips a primary that just failed, then tries it again after the cooldown", async () => {
    let t = 0;
    let claude = 0;
    let gemini = 0;
    const { fetch } = makeFetch((req) => {
      if (req.url.includes("anthropic.com")) return claude++ === 0 ? anthropicError(529, "overloaded_error") : json(claudeMessage('{"ok":true}'));
      gemini++;
      return json(geminiResponse('{"ok":true}'));
    });
    const llm = withFallback(createLlm({ provider: "anthropic", apiKey: ANTHROPIC_KEY, fetch, maxRetries: 0 }), [createLlm({ provider: "gemini", apiKey: GEMINI_KEY, fetch })], {
      cooldownMs: 1_000,
      now: () => t,
    });
    const call = () => llm.structured({ system: "s", user: "u", schema, name: "x" });
    await call(); // Claude 529, Gemini answers
    await call(); // Claude cooling down: straight to Gemini
    expect([claude, gemini]).toEqual([1, 2]);
    t = 1_001;
    await call(); // cooled down: Claude again, and it answers
    expect([claude, gemini]).toEqual([2, 2]);
  });

  it("when every model fails, the error lists each attempt", async () => {
    const { fetch } = makeFetch((req) => (req.url.includes("anthropic.com") ? anthropicError(401, "authentication_error") : json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503)));
    const llm = withFallback(createLlm({ provider: "anthropic", apiKey: ANTHROPIC_KEY, fetch, maxRetries: 0 }), [createLlm({ provider: "gemini", apiKey: GEMINI_KEY, model: "gemini-3.5-flash", fetch, maxRetries: 0 })]);
    const err = (await llm.structured({ system: "s", user: "u", schema, name: "x" }).catch((e: unknown) => e)) as LlmFallbackError;
    expect(err).toBeInstanceOf(LlmFallbackError);
    expect(err).toMatchObject({ code: "http", status: 503, provider: "gemini" });
    expect(err.attempts.map((a) => [a.provider, a.status])).toEqual([
      ["anthropic", 401],
      ["gemini", 503],
    ]);
    expect(err.message).not.toContain("SECRETSECRET");
  });

  it("a chain that ends in our own error still names every model it tried", async () => {
    const { fetch } = makeFetch((req) => (req.url.includes("anthropic.com") ? anthropicError(401, "authentication_error") : json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, 400)));
    const llm = withFallback(createLlm({ provider: "anthropic", apiKey: ANTHROPIC_KEY, fetch, maxRetries: 0 }), [createLlm({ provider: "gemini", apiKey: GEMINI_KEY, fetch, maxRetries: 0 })]);
    const err = (await llm.structured({ system: "s", user: "u", schema, name: "x" }).catch((e: unknown) => e)) as LlmFallbackError;
    expect(err).toBeInstanceOf(LlmFallbackError);
    expect(err).toMatchObject({ code: "http", status: 400 });
    expect(err.attempts.map((a) => a.status)).toEqual([401, 400]);
  });

  it("a tool loop does not move to another model once a tool has run", async () => {
    let ran = 0;
    const tool = { name: "lookup", description: "d", parameters: z.object({}), execute: async () => ++ran };
    const failingAfterTool = createLlm({
      provider: "scripted",
      script: [
        { type: "tool_calls", calls: [{ name: "lookup", args: {} }] },
        { type: "dynamic", resolve: () => Promise.reject(new LlmError("overloaded", { code: "http", status: 529, provider: "anthropic", model: "m" })) },
      ],
    });
    const llm = withFallback(failingAfterTool, [createLlm({ provider: "scripted", script: [{ type: "final", text: "fallback answered" }] })]);
    await expect(llm.toolLoop({ system: "s", user: "u", tools: [tool], maxSteps: 3 })).rejects.toMatchObject({ status: 529 });
    expect(ran).toBe(1);
  });

  it("classifies errors", () => {
    const err = (code: ConstructorParameters<typeof LlmError>[1]["code"], status?: number) => new LlmError("x", { code, provider: "p", model: "m", ...(status ? { status } : {}) });
    expect([401, 403, 408, 429, 500, 503, 529].map((s) => shouldFallBack(err("http", s)))).toEqual([true, true, true, true, true, true, true]);
    expect([400, 404, 422].map((s) => shouldFallBack(err("http", s)))).toEqual([false, false, false]);
    expect(["timeout", "network", "refusal"].map((c) => shouldFallBack(err(c as "timeout")))).toEqual([true, true, true]);
    expect(["validation", "config", "aborted", "truncated", "script", "unknown"].map((c) => shouldFallBack(err(c as "timeout")))).toEqual([false, false, false, false, false, false]);
    expect(shouldFallBack(new Error("plain"))).toBe(false);
  });
});

describe("llmFromEnv with LLM_FALLBACK_PROVIDER", () => {
  const env = { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: ANTHROPIC_KEY, GEMINI_API_KEY: GEMINI_KEY, LLM_FALLBACK_PROVIDER: "gemini", LLM_FALLBACK_MODEL: "gemini-3.5-flash" };

  it("builds Claude first, Gemini second, and the primary does not retry before falling back", async () => {
    let claude = 0;
    const { fetch } = makeFetch((req) => (req.url.includes("anthropic.com") ? (claude++, anthropicError(529, "overloaded_error")) : json(geminiResponse('{"ok":true}'))));
    const llm = llmFromEnv({ ...env, LLM_MAX_RETRIES: "2" }, { fetch, retryBaseDelayMs: 0 });
    expect([llm.provider, llm.model]).toEqual(["anthropic", "claude-opus-5-5"]);
    expect(llm.fallbacks).toEqual([{ provider: "gemini", model: "gemini-3.5-flash" }]);
    let by: unknown;
    await expect(llm.structured({ system: "s", user: "u", schema, name: "x", onAnswer: (b) => (by = b) })).resolves.toEqual({ ok: true });
    expect(claude).toBe(1);
    expect(by).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
  });

  it("fails loudly when the fallback has no key, or is unknown or scripted", () => {
    expect(() => llmFromEnv({ ...env, GEMINI_API_KEY: undefined })).toThrow(/LLM_FALLBACK_PROVIDER=gemini has no API key/);
    expect(() => llmFromEnv({ ...env, LLM_FALLBACK_PROVIDER: "geminy" })).toThrow(/Unknown LLM_FALLBACK_PROVIDER/);
    expect(() => llmFromEnv({ ...env, LLM_FALLBACK_PROVIDER: "scripted" })).toThrow(/cannot be scripted/);
  });

  it("uses the fallback alone when the primary has no key, and no chain when they are the same model", () => {
    const only = llmFromEnv({ ...env, ANTHROPIC_API_KEY: undefined });
    expect([only.provider, only.model, only.fallbacks]).toEqual(["gemini", "gemini-3.5-flash", undefined]);
    const same = llmFromEnv({ LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash", GEMINI_API_KEY: GEMINI_KEY, LLM_FALLBACK_PROVIDER: "gemini", LLM_FALLBACK_MODEL: "gemini-3.5-flash" });
    expect(same.fallbacks).toBeUndefined();
  });

  it("without LLM_FALLBACK_PROVIDER nothing changes", () => {
    const llm = llmFromEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    expect([llm.provider, llm.fallbacks]).toEqual(["anthropic", undefined]);
  });
});
