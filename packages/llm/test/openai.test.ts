import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm, type LlmLogEntry, type ToolDef, type ToolEvent, UNTRUSTED_CONTENT_RULE } from "../src/index.js";
import { demoTools, json, makeFetch } from "./helpers.js";

const KEY = "sk-proj-SECRETSECRETSECRET0123456789";

const completion = (message: Record<string, unknown>, finish_reason: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_790_000_000,
  model: "gpt-5.4-mini",
  choices: [{ index: 0, message: { role: "assistant", refusal: null, ...message }, finish_reason, logprobs: null }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 32 } },
});

describe("openai-compatible provider (stubbed fetch)", () => {
  it("sends chat completions with strict function tools against api.openai.com", async () => {
    const { tools } = demoTools();
    const { fetch, calls } = makeFetch((_req, i) =>
      json(
        i === 0
          ? completion(
              {
                content: "Looking at Northwind.",
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "browse_merchant", arguments: '{"merchantId":"northwind"}' } },
                  { id: "call_2", type: "function", function: { name: "search_market", arguments: '{"query": "cat food", "limit": null' } },
                ],
              },
              "tool_calls",
            )
          : completion({ content: "Finished." }, "stop"),
      ),
    );
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "openai-compatible", apiKey: KEY, fetch, onLog: (e) => logs.push(e) });
    const events: ToolEvent[] = [];
    const res = await llm.toolLoop({ system: "Shop.", user: "Buy cat food", tools, maxSteps: 3, onEvent: (e) => events.push(e) });
    expect(res.finalText).toBe("Finished.");

    const first = calls[0];
    expect(first?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(first?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(first?.body.model).toBe("gpt-5.4-mini");
    expect(first?.body.messages).toEqual([
      { role: "system", content: `Shop.\n\n${UNTRUSTED_CONTENT_RULE}` },
      { role: "user", content: "Buy cat food" },
    ]);
    expect(first?.body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "search_market",
        description: "Search the market (Channel3) for products and prices.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: ["integer", "null"] } },
          required: ["query", "limit"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    expect(first?.body.response_format).toBeUndefined();

    const second = calls[1]?.body.messages;
    expect(second[2]).toEqual({
      role: "assistant",
      content: "Looking at Northwind.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "browse_merchant", arguments: '{"merchantId":"northwind"}' } },
        { id: "call_2", type: "function", function: { name: "search_market", arguments: '{"query": "cat food", "limit": null' } },
      ],
    });
    expect(second[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: expect.stringMatching(/^<<<UNTRUSTED_DATA source="browse_merchant"/) });
    expect(second[4]).toMatchObject({ role: "tool", tool_call_id: "call_2" });
    // malformed arguments are reported back to the model instead of crashing the loop
    const bad = events.filter((e) => e.type === "tool_result")[1];
    expect(bad).toMatchObject({ result: { error: expect.stringContaining("not valid JSON") } });
    expect(logs[0]?.usage).toEqual({ inputTokens: 50, outputTokens: 10, totalTokens: 60, cacheReadTokens: 32 });
  });

  it("uses response_format json_schema (strict) and strips nulls for optional fields", async () => {
    const Schema = z.object({ verdict: z.enum(["ALLOW", "BLOCK"]), note: z.string().optional() });
    const { fetch, calls } = makeFetch(() => json(completion({ content: '{"verdict":"BLOCK","note":null}' }, "stop")));
    const llm = createLlm({ provider: "openai-compatible", apiKey: KEY, fetch, maxTokens: 500 });
    await expect(llm.structured({ system: "s", user: "u", schema: Schema, name: "risk verdict!" })).resolves.toEqual({ verdict: "BLOCK" });
    expect(calls[0]?.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "risk_verdict_",
        strict: true,
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["ALLOW", "BLOCK"] }, note: { type: ["string", "null"] } },
          required: ["verdict", "note"],
          additionalProperties: false,
        },
      },
    });
    expect(calls[0]?.body.max_completion_tokens).toBe(500);
    expect(calls[0]?.body.max_tokens).toBeUndefined();
  });

  it("targets other OpenAI-compatible servers via baseUrl without strict mode", async () => {
    const tool: ToolDef = {
      name: "lookup",
      description: "Look something up.",
      parameters: z.object({ q: z.string(), limit: z.number().optional() }),
      execute: async () => "ok",
    };
    const { fetch, calls } = makeFetch((_req, i) =>
      json(
        i === 0
          ? completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] }, "tool_calls")
          : completion({ content: "done" }, "stop"),
      ),
    );
    const llm = createLlm({
      provider: "openai-compatible",
      apiKey: "or-key-123456",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-5",
      maxTokens: 300,
      fetch,
    });
    await llm.toolLoop({ system: "s", user: "u", tools: [tool], maxSteps: 2 });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("anthropic/claude-sonnet-5");
    expect(calls[0]?.body.max_tokens).toBe(300);
    expect(calls[0]?.body.tools[0].function.strict).toBeUndefined();
    expect(calls[0]?.body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
      required: ["q"],
    });
    expect(calls[1]?.body.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
    });
    expect(calls[1]?.body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  it("works keyless against a local server (Ollama) and surfaces refusals", async () => {
    const { fetch, calls } = makeFetch(() => json(completion({ content: null, refusal: "I can't help with that." }, "stop")));
    const llm = createLlm({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.2", fetch });
    await expect(llm.structured({ system: "s", user: "u", schema: z.object({}), name: "x" })).rejects.toMatchObject({ code: "refusal" });
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  });
});
