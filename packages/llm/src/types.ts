import type { z } from "zod";

/** A JSON Schema document (draft 2020-12 subset), as produced by `zodToJsonSchema`. */
export type JsonSchema = Record<string, unknown>;

/** A tool the model may call inside `toolLoop`. Contract: docs/CONTRACTS.md (@goodfaith/llm). */
export type ToolDef = {
  name: string;
  description: string;
  /** Converted to JSON Schema per provider; also used to validate the model's arguments before `execute`. */
  parameters: z.ZodTypeAny;
  /** Output is wrapped as quarantined data (spotlighting) before the model sees it. */
  untrusted?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: contract signature; args are validated with `parameters` first.
  execute(args: any): Promise<unknown>;
};

export type ToolEvent =
  | { type: "thought"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown; untrusted: boolean }
  | { type: "final"; text: string };

/** Reasoning effort (Anthropic output_config.effort). Claude Opus 5.5 defaults to "medium", so callers set it per role. */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type StructuredInput<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Short identifier for the output, e.g. "permission_slip" or "risk_verdict". */
  name: string;
  /** Extension: per-call effort (Anthropic only; overrides LlmConfig.effort). */
  effort?: LlmEffort;
  /** Extension: cancels the call (including retries and backoff). Rejects with LlmError code "aborted". */
  signal?: AbortSignal;
  /** Extension: told which model produced the result (with a fallback chain, not always the primary). */
  onAnswer?: (by: { provider: string; model: string }) => void;
};

export type ToolLoopInput = {
  system: string;
  user: string;
  tools: ToolDef[];
  /** Maximum number of model turns. */
  maxSteps: number;
  onEvent?: (e: ToolEvent) => void;
  /** Extension: per-call effort (Anthropic only; overrides LlmConfig.effort). */
  effort?: LlmEffort;
  /** Extension: cancels the loop (model calls, retries, backoff and running tools). Rejects with LlmError code "aborted". */
  signal?: AbortSignal;
  /** Extension: told which model produced the result (with a fallback chain, not always the primary). */
  onAnswer?: (by: { provider: string; model: string }) => void;
};

export type ToolLoopResult = {
  finalText: string;
  events: ToolEvent[];
  /** Extension: why the loop ended. "max_steps" means the model never produced a final answer. */
  stopReason?: "final" | "max_steps";
  /** Extension: number of model turns used. */
  steps?: number;
};

export interface Llm {
  provider: string;
  model: string;
  /** Extension: the models tried after this one when it is unusable (llmFromEnv with LLM_FALLBACK_PROVIDER). */
  fallbacks?: ReadonlyArray<{ provider: string; model: string }>;
  structured<T>(i: StructuredInput<T>): Promise<T>;
  toolLoop(i: ToolLoopInput): Promise<ToolLoopResult>;
}

export type LlmProvider = "anthropic" | "gemini" | "openai-compatible" | "scripted";

export type QuarantineMode = "datamark" | "delimit" | "base64";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

/** One entry per model call attempt. Never contains API keys or prompt text. */
export type LlmLogEntry = {
  ts: string;
  provider: string;
  model: string;
  op: "structured" | "toolLoop";
  /** structured(): the output name. */
  name?: string;
  /** Model turn index within the call (structured: 0 = first try, 1 = repair). */
  step: number;
  /** Retry attempt, 0-based. */
  attempt: number;
  ok: boolean;
  latencyMs: number;
  usage?: LlmUsage;
  stopReason?: string;
  status?: number;
  error?: string;
  willRetry?: boolean;
};

export type LlmConfig = {
  provider: LlmProvider;
  model?: string;
  apiKey?: string;
  /** Anthropic / OpenAI-compatible / Gemini endpoint override (e.g. https://openrouter.ai/api/v1, http://localhost:11434/v1). */
  baseUrl?: string;
  /** Scripted provider: turns to replay. Without a script it falls back to the deterministic demo defaults. */
  script?: readonly ScriptedTurn[];

  // ---- Extensions beyond the contract (all optional) ----
  /** "replay" (default): every call replays the script from the start. "queue": turns are consumed across calls. */
  scriptMode?: "replay" | "queue";
  /** Per model call timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** Retries on 408/409/429/5xx, timeouts and network errors. Default 2. */
  maxRetries?: number;
  /** Backoff base delay in ms (exponential with jitter). Default 500. */
  retryBaseDelayMs?: number;
  /** Backoff cap in ms. Default 8000. */
  retryMaxDelayMs?: number;
  /** Per tool execution timeout in ms. Default 60000. */
  toolTimeoutMs?: number;
  /** Output token cap. Anthropic default 16000; others use the provider default unless set. */
  maxTokens?: number;
  /** Anthropic only: default output_config.effort for calls that do not set their own. */
  effort?: LlmEffort;
  /** Anthropic only: server-side refusal fallbacks (`fallbacks: "default"`) on models that support them. Default true. */
  serverSideFallbacks?: boolean;
  /** OpenAI-compatible only: send `strict: true` schemas. Default: true for api.openai.com, false for other base URLs. */
  openaiStrict?: boolean;
  /** Token/latency hook, called once per model call attempt. */
  onLog?: (e: LlmLogEntry) => void;
  /** How untrusted tool output is quarantined. */
  untrusted?: { mode?: QuarantineMode; maxChars?: number };
  /** Custom fetch (tests, proxies). Passed to the provider SDK. */
  fetch?: typeof fetch;
};

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

export type ScriptedToolCall = { name: string; args: unknown };

/**
 * One scripted model turn.
 * - `tool_calls`: the model calls tools (optionally with a visible `thought`).
 * - `final`: the model answers; ends a toolLoop.
 * - `structured`: the model's reply to structured(); `output` is JSON-serialised, or `raw` is sent verbatim
 *   (use `raw` to simulate malformed JSON). `name`, if set, only matches structured() calls with that name.
 * - `dynamic`: computed at replay time from the call context; return `null` to skip the turn.
 *   `op` says which call kind it serves (default "toolLoop").
 */
export type ScriptedTurn =
  | { type: "tool_calls"; calls: ScriptedToolCall[]; thought?: string }
  | { type: "final"; text: string }
  | { type: "structured"; output?: unknown; raw?: string; name?: string }
  | {
      type: "dynamic";
      op?: "toolLoop" | "structured";
      label?: string;
      resolve: (ctx: ScriptContext) => ScriptedTurn | null | Promise<ScriptedTurn | null>;
    };

export type ScriptToolInfo = { name: string; description: string; untrusted: boolean; jsonSchema: JsonSchema };

export type ScriptToolResult = {
  name: string;
  args: unknown;
  /** What `execute` returned (or `{ error }`). */
  result: unknown;
  untrusted: boolean;
  isError: boolean;
  /** Exactly what the model was sent for this result (quarantined when untrusted). */
  modelContent: string;
};

/** What a dynamic scripted turn can see. */
export type ScriptContext = {
  op: "toolLoop" | "structured";
  system: string;
  user: string;
  /** structured(): output name and target JSON Schema. */
  name?: string;
  jsonSchema?: JsonSchema;
  tools: ScriptToolInfo[];
  /** Events emitted so far in this call. */
  events: ToolEvent[];
  /** Tool results so far in this call, oldest first. */
  results: ScriptToolResult[];
  /** Model turn index within this call. */
  step: number;
  /** Set when structured() is asking for a repair. */
  repair?: { feedback: string; previous: string };
};
