import OpenAI from "openai";
import type { Conversation, ConversationInit, ModelToolCall, ModelTurn, ProviderAdapter } from "../engine.js";
import { LlmError } from "../errors.js";
import { toOpenAIStrictSchema } from "../json-schema.js";
import type { JsonSchema } from "../types.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5.4-mini";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAIAdapterConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Send `strict: true` (OpenAI structured outputs). Non-OpenAI endpoints often reject or ignore it. */
  strict: boolean;
  timeoutMs: number;
  fetch?: typeof fetch;
  client?: OpenAI;
};

/** Chat Completions with function tools and `response_format: json_schema`. Works with OpenRouter, Groq, Ollama via baseUrl. */
export function openaiAdapter(cfg: OpenAIAdapterConfig): ProviderAdapter {
  const baseURL = cfg.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
  const isOpenAI = /(^|\.)api\.openai\.com/i.test(new URL(baseURL).host);
  const client =
    cfg.client ??
    new OpenAI({
      apiKey: cfg.apiKey,
      baseURL,
      maxRetries: 0,
      timeout: cfg.timeoutMs,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    });
  const schemaFor = (s: JsonSchema): JsonSchema => (cfg.strict ? toOpenAIStrictSchema(s) : s);

  return {
    provider: "openai-compatible",
    model: cfg.model,
    conversation(init: ConversationInit): Conversation {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...(init.system ? [{ role: "system" as const, content: init.system }] : []),
        { role: "user", content: init.user || "(no input)" },
      ];
      const tools: OpenAI.Chat.ChatCompletionFunctionTool[] = (init.tools ?? []).map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: schemaFor(t.jsonSchema),
          ...(cfg.strict ? { strict: true } : {}),
        },
      }));
      const responseFormat: OpenAI.ResponseFormatJSONSchema | undefined = init.output
        ? {
            type: "json_schema",
            json_schema: {
              name: init.output.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
              schema: schemaFor(init.output.jsonSchema),
              strict: cfg.strict,
            },
          }
        : undefined;

      return {
        async send(signal: AbortSignal): Promise<ModelTurn> {
          const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model: cfg.model,
            messages: [...messages],
            ...(tools.length > 0 ? { tools } : {}),
            ...(responseFormat ? { response_format: responseFormat } : {}),
            ...(cfg.maxTokens ? (isOpenAI ? { max_completion_tokens: cfg.maxTokens } : { max_tokens: cfg.maxTokens }) : {}),
          };
          const res = await client.chat.completions.create(body, { signal, timeout: cfg.timeoutMs });
          const choice = res.choices[0];
          if (!choice) {
            throw new LlmError("Model returned no choices.", { code: "unknown", provider: "openai-compatible", model: cfg.model, retryable: true });
          }
          const msg = choice.message;
          if (msg.refusal || choice.finish_reason === "content_filter") {
            throw new LlmError(`Model declined the request${msg.refusal ? `: ${msg.refusal}` : " (content filter)"}.`, {
              code: "refusal",
              provider: "openai-compatible",
              model: cfg.model,
            });
          }
          const functionCalls = (msg.tool_calls ?? []).filter(
            (tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === "function",
          );
          const toolCalls: ModelToolCall[] = functionCalls.map((tc) => {
            const raw = tc.function.arguments?.trim() || "{}";
            try {
              return { id: tc.id, name: tc.function.name, args: JSON.parse(raw) as unknown };
            } catch (e) {
              return { id: tc.id, name: tc.function.name, args: raw, argsError: e instanceof Error ? e.message : "invalid JSON" };
            }
          });
          messages.push({
            role: "assistant",
            content: msg.content ?? null,
            ...(functionCalls.length > 0 ? { tool_calls: functionCalls } : {}),
          });
          return {
            text: msg.content ?? "",
            toolCalls,
            usage: {
              inputTokens: res.usage?.prompt_tokens,
              outputTokens: res.usage?.completion_tokens,
              totalTokens: res.usage?.total_tokens,
              cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
            },
            stopReason: choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason,
          };
        },
        addToolResults(results) {
          for (const r of results) messages.push({ role: "tool", tool_call_id: r.callId, content: r.content });
        },
        addUserText(text) {
          messages.push({ role: "user", content: text });
        },
      };
    },
  };
}
