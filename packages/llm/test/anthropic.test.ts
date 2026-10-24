import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm, LlmError, type LlmLogEntry, UNTRUSTED_CONTENT_RULE } from "../src/index.js";
import { demoTools, hangingFetch, json, makeFetch } from "./helpers.js";

const KEY = "sk-ant-api03-SECRETSECRETSECRET0123456789";

const message = (content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 64 },
  ...extra,
});

describe("anthropic provider (stubbed fetch)", () => {
  it("sends a Messages API tool loop and replays assistant content + tool results", async () => {
    const { tools } = demoTools();
    const { fetch, calls } = makeFetch((_req, i) =>
      json(
        i === 0
          ? message(
              [
                { type: "text", text: "Checking the market first." },
                { type: "tool_use", id: "toolu_1", name: "search_market", input: { query: "cat food" } },
                { type: "tool_use", id: "toolu_2", name: "browse_merchant", input: { merchantId: "northwind" } },
              ],
              "tool_use",
            )
          : message([{ type: "text", text: "All done." }], "end_turn"),
      ),
    );
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, onLog: (e) => logs.push(e) });
    expect([llm.provider, llm.model]).toEqual(["anthropic", "claude-opus-5-5"]);

    const res = await llm.toolLoop({ system: "You are a shopping agent.", user: "Buy cat food", tools, maxSteps: 4 });
    expect(res.finalText).toBe("All done.");
    expect(res.events[0]).toEqual({ type: "thought", text: "Checking the market first." });

    expect(calls).toHaveLength(2);
    const first = calls[0];
    expect(first?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(first?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(first?.method).toBe("POST");
    expect(first?.headers.get("x-api-key")).toBe(KEY);
    expect(first?.headers.get("anthropic-version")).toBeTruthy();
    expect(first?.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      messages: [{ role: "user", content: "Buy cat food" }],
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
    });
    expect(first?.body.thinking).toBeUndefined();
    expect(first?.body.system).toBe(`You are a shopping agent.\n\n${UNTRUSTED_CONTENT_RULE}`);
    expect(first?.body.temperature).toBeUndefined();
    expect(first?.body.tool_choice).toBeUndefined();
    expect(first?.body.tools[0]).toEqual({
      name: "search_market",
      description: "Search the market (Channel3) for products and prices.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
    });

    const second = calls[1]?.body;
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking the market first." },
        { type: "tool_use", id: "toolu_1", name: "search_market", input: { query: "cat food" } },
        { type: "tool_use", id: "toolu_2", name: "browse_merchant", input: { merchantId: "northwind" } },
      ],
    });
    const results = second.messages[2];
    expect(results.role).toBe("user");
    expect(results.content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    expect(results.content[0].content).toMatch(/^<<<UNTRUSTED_DATA source="search_market"/);
    expect(results.content[1].content).toMatch(/^<<<UNTRUSTED_DATA source="browse_merchant"/);

    expect(logs.map((l) => [l.op, l.step, l.attempt, l.ok, l.usage?.inputTokens, l.usage?.cacheReadTokens])).toEqual([
      ["toolLoop", 0, 0, true, 120, 64],
      ["toolLoop", 1, 0, true, 120, 64],
    ]);
  });

  it("uses output_config.format for structured output and repairs with an appended turn", async () => {
    const Slip = z.object({ maxPerOrder: z.number(), period: z.enum(["week", "month"]) });
    const { fetch, calls } = makeFetch((_req, i) =>
      json(message([{ type: "text", text: i === 0 ? '{"maxPerOrder":"lots","period":"month"}' : '{"maxPerOrder":45,"period":"month"}' }], "end_turn")),
    );
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, model: "claude-opus-5-5", effort: "low" });
    await expect(llm.structured({ system: "Draft.", user: "$45 a month", schema: Slip, name: "slip" })).resolves.toEqual({
      maxPerOrder: 45,
      period: "month",
    });
    const first = calls[0]?.body;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.tools).toBeUndefined();
    expect(first.output_config).toEqual({
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { maxPerOrder: { type: "number" }, period: { type: "string", enum: ["week", "month"] } },
          required: ["maxPerOrder", "period"],
          additionalProperties: false,
        },
      },
    });
    const repair = calls[1]?.body.messages;
    expect(repair).toHaveLength(3);
    expect(repair[1]).toEqual({ role: "assistant", content: [{ type: "text", text: '{"maxPerOrder":"lots","period":"month"}' }] });
    expect(repair[2].role).toBe("user");
    expect(repair[2].content).toContain("maxPerOrder");
  });

  it("retries 429 (honouring retry-after) and logs each attempt", async () => {
    const { fetch, calls } = makeFetch((_req, i) =>
      i === 0
        ? json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "0" })
        : json(message([{ type: "text", text: '{"ok":true}' }], "end_turn")),
    );
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, onLog: (e) => logs.push(e), retryBaseDelayMs: 0 });
    await expect(llm.structured({ system: "s", user: "u", schema: z.object({ ok: z.boolean() }), name: "x" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(logs.map((l) => [l.attempt, l.ok, l.status, l.willRetry])).toEqual([
      [0, false, 429, true],
      [1, true, undefined, undefined],
    ]);
  });

  it("gives up after maxRetries on 5xx and does not retry 400", async () => {
    const five = makeFetch(() => json({ type: "error", error: { type: "api_error", message: "boom" } }, 500));
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch: five.fetch, maxRetries: 2, retryBaseDelayMs: 0 });
    const err = await llm.structured({ system: "s", user: "u", schema: z.object({}), name: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "http", status: 500, retryable: true });
    expect(five.calls).toHaveLength(3);

    const bad = makeFetch(() => json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400));
    const llm2 = createLlm({ provider: "anthropic", apiKey: KEY, fetch: bad.fetch, retryBaseDelayMs: 0 });
    await expect(llm2.structured({ system: "s", user: "u", schema: z.object({}), name: "x" })).rejects.toMatchObject({ status: 400 });
    expect(bad.calls).toHaveLength(1);
  });

  it("times out a hung call", async () => {
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch: hangingFetch, timeoutMs: 50, maxRetries: 0 });
    await expect(llm.structured({ system: "s", user: "u", schema: z.object({}), name: "x" })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("never leaks the API key in errors or logs", async () => {
    const { fetch } = makeFetch(() =>
      json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY}` } }, 401),
    );
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, onLog: (e) => logs.push(e) });
    const err = (await llm.structured({ system: "s", user: "u", schema: z.object({}), name: "x" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("SECRETSECRET");
    expect(JSON.stringify(logs)).not.toContain("SECRETSECRET");
    expect(logs[0]?.error).toContain("[REDACTED]");
  });

  it("surfaces refusals as non-retryable errors", async () => {
    const { fetch, calls } = makeFetch(() =>
      json(message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })),
    );
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, retryBaseDelayMs: 0 });
    await expect(llm.toolLoop({ system: "s", user: "u", tools: [], maxSteps: 2 })).rejects.toMatchObject({ code: "refusal" });
    expect(calls).toHaveLength(1);
  });

  it("sets effort per call (overriding the configured default) and leaves it to the model when nobody sets it", async () => {
    const { fetch, calls } = makeFetch(() => json(message([{ type: "text", text: '{"ok":true}' }], "end_turn")));
    const plain = createLlm({ provider: "anthropic", apiKey: KEY, fetch });
    await plain.structured({ system: "s", user: "u", schema: z.object({ ok: z.boolean() }), name: "x" });
    expect(calls[0]?.body.output_config).toEqual({ format: expect.objectContaining({ type: "json_schema" }) });

    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, effort: "low" });
    await llm.structured({ system: "s", user: "u", schema: z.object({ ok: z.boolean() }), name: "risk_verdict", effort: "high" });
    expect(calls[1]?.body.output_config.effort).toBe("high");
    await llm.toolLoop({ system: "s", user: "u", tools: [], maxSteps: 1, effort: "medium" });
    expect(calls[2]?.body.output_config).toEqual({ effort: "medium" });
    await llm.toolLoop({ system: "s", user: "u", tools: [], maxSteps: 1 });
    expect(calls[3]?.body.output_config).toEqual({ effort: "low" });
  });

  it("asks for server-side refusal fallbacks only on models that support them, and can be switched off", async () => {
    const { fetch, calls } = makeFetch(() => json(message([{ type: "text", text: "ok" }], "end_turn")));
    await createLlm({ provider: "anthropic", apiKey: KEY, fetch, model: "claude-haiku-5-5" }).toolLoop({ system: "s", user: "u", tools: [], maxSteps: 1 });
    await createLlm({ provider: "anthropic", apiKey: KEY, fetch, serverSideFallbacks: false }).toolLoop({ system: "s", user: "u", tools: [], maxSteps: 1 });
    for (const c of calls) {
      expect(c.body.fallbacks).toBeUndefined();
      expect(c.headers.get("anthropic-beta")).toBeNull();
    }
  });

  it("after a refusal fallback, echoes only what the next request may carry (text before the boundary, everything after it)", async () => {
    const { tools } = demoTools();
    const { fetch, calls } = makeFetch((_req, i) =>
      json(
        i === 0
          ? message(
              [
                { type: "thinking", thinking: "", signature: "sig-declined" },
                { type: "text", text: "Let me look." },
                { type: "tool_use", id: "toolu_declined", name: "search_market", input: { query: "x" } },
                { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
                { type: "tool_use", id: "toolu_kept", name: "search_market", input: { query: "cat food" } },
              ],
              "tool_use",
              { model: "claude-opus-4-8" },
            )
          : message([{ type: "text", text: "Done." }], "end_turn", { model: "claude-opus-4-8" }),
      ),
    );
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch });
    const res = await llm.toolLoop({ system: "s", user: "Buy cat food", tools, maxSteps: 3 });
    expect(res.finalText).toBe("Done.");
    const calledTools = res.events.filter((e) => e.type === "tool_call");
    expect(calledTools).toHaveLength(1);
    const second = calls[1]?.body;
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_kept", name: "search_market", input: { query: "cat food" } },
      ],
    });
    expect(second.messages[2].content.map((r: { tool_use_id: string }) => r.tool_use_id)).toEqual(["toolu_kept"]);
  });

  it("a refusal that survives the fallback chain is an LlmError, never an answer", async () => {
    const { fetch } = makeFetch(() =>
      json(
        message([{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } }], "refusal", {
          stop_details: { type: "refusal", category: "cyber", explanation: null },
        }),
      ),
    );
    const llm = createLlm({ provider: "anthropic", apiKey: KEY, fetch, retryBaseDelayMs: 0 });
    const err = await llm.structured({ system: "s", user: "u", schema: z.object({}), name: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "refusal" });
    expect((err as Error).message).toContain("cyber");
  });
});
