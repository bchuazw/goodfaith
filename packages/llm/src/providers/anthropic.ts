import Anthropic from "@anthropic-ai/sdk";
import type { Conversation, ConversationInit, ModelTurn, ProviderAdapter } from "../engine.js";
import { LlmError } from "../errors.js";
import { toAnthropicSchema } from "../json-schema.js";
import type { LlmEffort } from "../types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Models that accept server-side refusal fallbacks in the `"default"` form (Claude API). */
const SERVER_SIDE_FALLBACK_MODELS = /^claude-(?:opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AnthropicAdapterConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens: number;
  /** Default effort for calls that do not set their own (Claude Opus 5.5 defaults to "medium"). */
  effort?: LlmEffort;
  /** Server-side refusal fallbacks on models that support them. Default true. */
  serverSideFallbacks?: boolean;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Inject a pre-built client (tests). */
  client?: Anthropic;
};

/**
 * What goes back into history after a turn. After a refusal fallback, model-internal blocks from before the
 * last `fallback` boundary (thinking, tool_use, anything unrecognised) are dropped and only their text is kept;
 * the `fallback` marker itself is an audit block the API ignores, so it is dropped too.
 */
export function echoableContent(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  return [...content.slice(0, boundary).filter((b) => b.type === "text"), ...content.slice(boundary + 1)];
}

/**
 * Anthropic Messages API (beta endpoint, for server-side fallbacks). Tools are client tools (manual loop, so
 * we control quarantining and events); structured output uses `output_config.format` (JSON schema) rather
 * than a forced tool, because forced `tool_choice` returns 400 on Claude Opus 5.5 / Sonnet 5.5. No sampling
 * params are sent (400 on current models); thinking stays at the model default (adaptive) and thinking blocks
 * are replayed unchanged. A refusal that survives the fallback chain becomes an LlmError ("refusal"), so
 * callers fail closed.
 */
export function anthropicAdapter(cfg: AnthropicAdapterConfig): ProviderAdapter {
  const client =
    cfg.client ??
    new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl ?? "https://api.anthropic.com",
      maxRetries: 0, // retries are handled (and logged) by robustCall
      timeout: cfg.timeoutMs,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    });
  const fallbacks = cfg.serverSideFallbacks !== false && SERVER_SIDE_FALLBACK_MODELS.test(cfg.model);

  return {
    provider: "anthropic",
    model: cfg.model,
    conversation(init: ConversationInit): Conversation {
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: init.user || "(no input)" }];
      const tools: Anthropic.Beta.BetaTool[] = (init.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toAnthropicSchema(t.jsonSchema) as Anthropic.Beta.BetaTool.InputSchema,
      }));
      const effort = init.effort ?? cfg.effort;
      const outputConfig: Anthropic.Beta.BetaOutputConfig = {
        ...(effort ? { effort } : {}),
        ...(init.output ? { format: { type: "json_schema", schema: toAnthropicSchema(init.output.jsonSchema) } } : {}),
      };

      return {
        async send(signal: AbortSignal): Promise<ModelTurn> {
          const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
            model: cfg.model,
            max_tokens: cfg.maxTokens,
            ...(init.system ? { system: init.system } : {}),
            messages: [...messages],
            ...(tools.length > 0 ? { tools, cache_control: { type: "ephemeral" } } : {}),
            ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
            ...(fallbacks ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" as const } : {}),
          };
          const res = await client.beta.messages.create(body, { signal, timeout: cfg.timeoutMs });
          if (res.stop_reason === "refusal") {
            const category = res.stop_details?.category ? ` (${res.stop_details.category})` : "";
            throw new LlmError(`Claude declined the request${category}.`, { code: "refusal", provider: "anthropic", model: cfg.model });
          }
          if (res.stop_reason === "model_context_window_exceeded") {
            throw new LlmError("Conversation exceeded the model context window.", { code: "truncated", provider: "anthropic", model: cfg.model });
          }
          const content = echoableContent(res.content);
          messages.push({ role: "assistant", content });
          const text = content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          const toolCalls = content
            .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, args: b.input }));
          return {
            text,
            toolCalls,
            usage: {
              inputTokens: res.usage.input_tokens,
              outputTokens: res.usage.output_tokens,
              cacheReadTokens: res.usage.cache_read_input_tokens ?? undefined,
              cacheWriteTokens: res.usage.cache_creation_input_tokens ?? undefined,
            },
            stopReason: res.stop_reason ?? undefined,
          };
        },
        addToolResults(results) {
          messages.push({
            role: "user",
            content: results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.callId,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          });
        },
        addUserText(text) {
          messages.push({ role: "user", content: text });
        },
      };
    },
  };
}
