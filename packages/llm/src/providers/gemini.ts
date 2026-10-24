import { type Content, type FunctionDeclaration, type GenerateContentConfig, GoogleGenAI, type Part, type Schema } from "@google/genai";
import type { Conversation, ConversationInit, ModelTurn, ProviderAdapter } from "../engine.js";
import { LlmError } from "../errors.js";
import { toGeminiSchema } from "../json-schema.js";

/** Current stable Flash model with a free tier (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-02). */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

export type GeminiAdapterConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs: number;
  fetch?: typeof fetch;
  client?: GoogleGenAI;
};

const REFUSAL_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/**
 * Gemini API via @google/genai: function calling with automatic function calling disabled (we run the loop),
 * `responseMimeType: application/json` + `responseSchema` for structured output. The model's Content
 * (including thought signatures) is replayed unchanged.
 */
export function geminiAdapter(cfg: GeminiAdapterConfig): ProviderAdapter {
  const ai =
    cfg.client ??
    new GoogleGenAI({
      apiKey: cfg.apiKey,
      httpOptions: {
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        timeout: cfg.timeoutMs,
        retryOptions: { attempts: 1 }, // retries are handled (and logged) by robustCall
        ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
      },
    });

  return {
    provider: "gemini",
    model: cfg.model,
    conversation(init: ConversationInit): Conversation {
      const contents: Content[] = [{ role: "user", parts: [{ text: init.user || "(no input)" }] }];
      const functionDeclarations: FunctionDeclaration[] = (init.tools ?? []).map((t) => {
        const parameters = toGeminiSchema(t.jsonSchema) as Schema;
        // Gemini rejects OBJECT parameters with empty `properties`; argument-less tools omit them.
        const empty = parameters.type === "OBJECT" && Object.keys(parameters.properties ?? {}).length === 0;
        return { name: t.name, description: t.description, ...(empty ? {} : { parameters }) };
      });
      const responseSchema = init.output ? (toGeminiSchema(init.output.jsonSchema) as Schema) : undefined;
      /** ids we generated for calls that had none; never echoed back to the API */
      const syntheticIds = new Set<string>();
      let turnNo = 0;

      return {
        async send(signal: AbortSignal): Promise<ModelTurn> {
          const config: GenerateContentConfig = {
            ...(init.system ? { systemInstruction: init.system } : {}),
            abortSignal: signal,
            ...(functionDeclarations.length > 0
              ? { tools: [{ functionDeclarations }], automaticFunctionCalling: { disable: true } }
              : {}),
            ...(responseSchema ? { responseMimeType: "application/json", responseSchema } : {}),
            ...(cfg.maxTokens ? { maxOutputTokens: cfg.maxTokens } : {}),
          };
          const res = await ai.models.generateContent({ model: cfg.model, contents: [...contents], config });
          const blockReason = res.promptFeedback?.blockReason;
          if (blockReason) {
            throw new LlmError(`Gemini blocked the prompt (${String(blockReason)}).`, { code: "refusal", provider: "gemini", model: cfg.model });
          }
          const candidate = res.candidates?.[0];
          const finish = candidate?.finishReason ? String(candidate.finishReason) : undefined;
          if (finish && REFUSAL_FINISH.has(finish)) {
            throw new LlmError(`Gemini stopped the response (${finish}).`, { code: "refusal", provider: "gemini", model: cfg.model });
          }
          if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") {
            throw new LlmError(`Gemini produced an invalid function call (${finish}).`, {
              code: "unknown",
              provider: "gemini",
              model: cfg.model,
              retryable: true,
            });
          }
          const content = candidate?.content;
          if (!content) {
            throw new LlmError("Gemini returned no content.", { code: "unknown", provider: "gemini", model: cfg.model, retryable: true });
          }
          const parts: Part[] = content.parts ?? [];
          contents.push({ ...content, role: "model" });
          turnNo++;
          const text = parts
            .filter((p) => typeof p.text === "string" && p.thought !== true)
            .map((p) => p.text)
            .join("")
            .trim();
          const toolCalls = parts
            .filter((p) => p.functionCall)
            .map((p, idx) => {
              const fc = p.functionCall ?? {};
              let id = fc.id;
              if (!id) {
                id = `gemini_${turnNo}_${idx}`;
                syntheticIds.add(id);
              }
              return { id, name: fc.name ?? "", args: fc.args ?? {} };
            });
          const usage = res.usageMetadata;
          return {
            text,
            toolCalls,
            usage: {
              inputTokens: usage?.promptTokenCount,
              outputTokens:
                usage?.candidatesTokenCount === undefined && usage?.thoughtsTokenCount === undefined
                  ? undefined
                  : (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
              cacheReadTokens: usage?.cachedContentTokenCount,
              totalTokens: usage?.totalTokenCount,
            },
            stopReason: finish === "MAX_TOKENS" ? "max_tokens" : finish,
          };
        },
        addToolResults(results) {
          contents.push({
            role: "user",
            parts: results.map((r) => ({
              functionResponse: {
                ...(syntheticIds.has(r.callId) ? {} : { id: r.callId }),
                name: r.name,
                response: r.isError ? { error: r.content } : { output: r.content },
              },
            })),
          });
        },
        addUserText(text) {
          contents.push({ role: "user", parts: [{ text }] });
        },
      };
    },
  };
}
