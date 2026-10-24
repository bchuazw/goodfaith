import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm, type LlmLogEntry, UNTRUSTED_CONTENT_RULE } from "../src/index.js";
import { demoTools, json, makeFetch } from "./helpers.js";

const KEY = "AIzaSyDUMMYDUMMYDUMMYDUMMY0123456789";

const response = (parts: unknown[], finishReason = "STOP") => ({
  candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, thoughtsTokenCount: 30, totalTokenCount: 82 },
  modelVersion: "gemini-3.8-flash",
});

describe("gemini provider (stubbed fetch)", () => {
  it("sends function declarations, replays model content (with thought signatures) and function responses", async () => {
    const { tools } = demoTools();
    const { fetch, calls } = makeFetch((_req, i) =>
      json(
        i === 0
          ? response([
              { text: "Checking the market." },
              { functionCall: { id: "fc_1", name: "search_market", args: { query: "cat food" } }, thoughtSignature: "c2lnbmF0dXJl" },
              { functionCall: { name: "browse_merchant", args: { merchantId: "northwind" } } },
            ])
          : response([{ text: "Bought it." }]),
      ),
    );
    const logs: LlmLogEntry[] = [];
    const llm = createLlm({ provider: "gemini", apiKey: KEY, fetch, onLog: (e) => logs.push(e) });
    expect(llm.model).toBe("gemini-3.8-flash");
    const res = await llm.toolLoop({ system: "Shop.", user: "Buy cat food", tools, maxSteps: 3 });
    expect(res.finalText).toBe("Bought it.");

    const first = calls[0];
    expect(first?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(first?.headers.get("x-goog-api-key")).toBe(KEY);
    expect(first?.body.contents).toEqual([{ role: "user", parts: [{ text: "Buy cat food" }] }]);
    expect(first?.body.systemInstruction.parts[0].text).toBe(`Shop.\n\n${UNTRUSTED_CONTENT_RULE}`);
    const decls = first?.body.tools[0].functionDeclarations;
    expect(decls[0]).toEqual({
      name: "search_market",
      description: "Search the market (Channel3) for products and prices.",
      parameters: {
        type: "OBJECT",
        properties: { query: { type: "STRING" }, limit: { type: "INTEGER" } },
        required: ["query"],
        propertyOrdering: ["query", "limit"],
      },
    });
    expect(decls[1]).toEqual({ name: "list_merchants", description: "List merchants the agent can shop at." }); // no empty OBJECT
    expect(decls[2].parameters.properties.merchantId).toEqual({ type: "STRING", enum: ["northwind", "dealfang"] });

    const second = calls[1]?.body.contents;
    expect(second[1]).toEqual({
      role: "model",
      parts: [
        { text: "Checking the market." },
        { functionCall: { id: "fc_1", name: "search_market", args: { query: "cat food" } }, thoughtSignature: "c2lnbmF0dXJl" },
        { functionCall: { name: "browse_merchant", args: { merchantId: "northwind" } } },
      ],
    });
    expect(second[2].role).toBe("user");
    expect(second[2].parts[0].functionResponse).toMatchObject({ id: "fc_1", name: "search_market", response: { output: expect.stringMatching(/^<<<UNTRUSTED_DATA/) } });
    // a call without an id is answered by name only
    expect(second[2].parts[1].functionResponse.id).toBeUndefined();
    expect(second[2].parts[1].functionResponse.name).toBe("browse_merchant");
    expect(logs[0]?.usage).toEqual({ inputTokens: 40, outputTokens: 42, cacheReadTokens: undefined, totalTokens: 82 });
  });

  it("uses responseMimeType + responseSchema for structured output", async () => {
    const Verdict = z.object({ recommendation: z.enum(["ALLOW", "STEP_UP", "BLOCK"]), evidence: z.array(z.string()), score: z.number().nullable() });
    const { fetch, calls } = makeFetch(() => json(response([{ text: '{"recommendation":"BLOCK","evidence":["injection"],"score":null}' }])));
    const llm = createLlm({ provider: "gemini", apiKey: KEY, fetch, maxTokens: 800 });
    await expect(llm.structured({ system: "Judge.", user: "trace", schema: Verdict, name: "verdict" })).resolves.toEqual({
      recommendation: "BLOCK",
      evidence: ["injection"],
      score: null,
    });
    const body = calls[0]?.body;
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          recommendation: { type: "STRING", enum: ["ALLOW", "STEP_UP", "BLOCK"] },
          evidence: { type: "ARRAY", items: { type: "STRING" } },
          score: { type: "NUMBER", nullable: true },
        },
        required: ["recommendation", "evidence", "score"],
        propertyOrdering: ["recommendation", "evidence", "score"],
      },
      maxOutputTokens: 800,
    });
  });

  it("maps safety stops to refusals and retries 503", async () => {
    const { fetch } = makeFetch(() => json(response([], "SAFETY")));
    const llm = createLlm({ provider: "gemini", apiKey: KEY, fetch });
    await expect(llm.toolLoop({ system: "s", user: "u", tools: [], maxSteps: 1 })).rejects.toMatchObject({ code: "refusal" });

    const flaky = makeFetch((_req, i) =>
      i === 0 ? json({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }, 503) : json(response([{ text: '{"ok":true}' }])),
    );
    const llm2 = createLlm({ provider: "gemini", apiKey: KEY, fetch: flaky.fetch, retryBaseDelayMs: 0 });
    await expect(llm2.structured({ system: "s", user: "u", schema: z.object({ ok: z.boolean() }), name: "x" })).resolves.toEqual({ ok: true });
    expect(flaky.calls).toHaveLength(2);
  });
});
