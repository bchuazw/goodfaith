import type { z } from "zod";
import { createEngine, type EngineOptions } from "./engine.js";
import { LlmError } from "./errors.js";
import { ANTHROPIC_DEFAULT_MODEL, anthropicAdapter } from "./providers/anthropic.js";
import { GEMINI_DEFAULT_MODEL, geminiAdapter } from "./providers/gemini.js";
import { OPENAI_DEFAULT_MODEL, openaiAdapter } from "./providers/openai.js";
import { SCRIPTED_MODEL, scriptedAdapter } from "./providers/scripted.js";
import { makeRedactor } from "./robust.js";
import type { Llm, LlmConfig, LlmProvider, ScriptedTurn, ToolDef } from "./types.js";

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  gemini: GEMINI_DEFAULT_MODEL,
  "openai-compatible": OPENAI_DEFAULT_MODEL,
  scripted: SCRIPTED_MODEL,
};

/** OpenAI-compatible presets selectable with LLM_PROVIDER. */
const OPENAI_COMPATIBLE_PRESETS: Record<string, { baseUrl: string; keyEnv?: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
};

const scriptedConfigs = new WeakMap<Llm, LlmConfig>();

export function createLlm(cfg: LlmConfig): Llm {
  const timeoutMs = positive(cfg.timeoutMs, 120_000);
  const engineOpts: EngineOptions = {
    policy: {
      maxRetries: Math.floor(nonNegative(cfg.maxRetries, 2)),
      baseDelayMs: nonNegative(cfg.retryBaseDelayMs, 500),
      maxDelayMs: nonNegative(cfg.retryMaxDelayMs, 8_000),
      timeoutMs,
    },
    onLog: cfg.onLog,
    redact: makeRedactor([cfg.apiKey]),
    untrustedMode: cfg.untrusted?.mode ?? "datamark",
    untrustedMaxChars: positive(cfg.untrusted?.maxChars, 12_000),
    toolTimeoutMs: positive(cfg.toolTimeoutMs, 120_000),
  };

  switch (cfg.provider) {
    case "scripted": {
      const llm = createEngine(
        scriptedAdapter({ model: cfg.model ?? SCRIPTED_MODEL, script: cfg.script, mode: cfg.scriptMode ?? "replay" }),
        engineOpts,
      );
      scriptedConfigs.set(llm, cfg);
      return llm;
    }
    case "anthropic":
      return createEngine(
        anthropicAdapter({
          apiKey: requireKey(cfg),
          model: cfg.model ?? ANTHROPIC_DEFAULT_MODEL,
          baseUrl: cfg.baseUrl,
          maxTokens: positive(cfg.maxTokens, 16_000),
          effort: cfg.effort,
          serverSideFallbacks: cfg.serverSideFallbacks,
          timeoutMs,
          fetch: cfg.fetch,
        }),
        engineOpts,
      );
    case "gemini":
      return createEngine(
        geminiAdapter({
          apiKey: requireKey(cfg),
          model: cfg.model ?? GEMINI_DEFAULT_MODEL,
          baseUrl: cfg.baseUrl,
          maxTokens: cfg.maxTokens,
          timeoutMs,
          fetch: cfg.fetch,
        }),
        engineOpts,
      );
    case "openai-compatible": {
      const isOpenAI = !cfg.baseUrl || /(^|\/\/|\.)api\.openai\.com/i.test(cfg.baseUrl);
      if (!cfg.model && !isOpenAI) {
        throw configError(cfg, "model is required when baseUrl points to a non-OpenAI endpoint (set LLM_MODEL).");
      }
      // Local servers such as Ollama accept any key.
      const apiKey = cfg.apiKey ?? (isOpenAI ? undefined : "not-needed");
      return createEngine(
        openaiAdapter({
          apiKey: apiKey ?? requireKey(cfg),
          model: cfg.model ?? OPENAI_DEFAULT_MODEL,
          baseUrl: cfg.baseUrl,
          maxTokens: cfg.maxTokens,
          strict: cfg.openaiStrict ?? isOpenAI,
          timeoutMs,
          fetch: cfg.fetch,
        }),
        engineOpts,
      );
    }
    default:
      throw configError(cfg, `Unknown LLM provider "${String((cfg as { provider: unknown }).provider)}".`);
  }
}

/**
 * Builds an Llm from environment variables: LLM_PROVIDER (anthropic | gemini | openai-compatible |
 * openrouter | groq | ollama | scripted), LLM_MODEL, ANTHROPIC_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY),
 * OPENAI_API_KEY, OPENAI_BASE_URL, optional LLM_TIMEOUT_MS / LLM_MAX_RETRIES. With no provider set, the first
 * available key wins; with no usable key it returns the scripted provider.
 */
export function llmFromEnv(env?: Record<string, string | undefined>, overrides: Partial<LlmConfig> = {}): Llm {
  const e = env ?? processEnv();
  const get = (k: string) => {
    const v = e[k]?.trim();
    return v ? v : undefined;
  };
  const requested = get("LLM_PROVIDER")?.toLowerCase();
  const preset = requested ? OPENAI_COMPATIBLE_PRESETS[requested] : undefined;
  let provider: LlmProvider | undefined;
  switch (requested) {
    case undefined:
      break;
    case "anthropic":
    case "claude":
      provider = "anthropic";
      break;
    case "gemini":
    case "google":
      provider = "gemini";
      break;
    case "openai":
    case "openai-compatible":
    case "openrouter":
    case "groq":
    case "ollama":
      provider = "openai-compatible";
      break;
    case "scripted":
    case "mock":
      provider = "scripted";
      break;
    default:
      throw new LlmError(`Unknown LLM_PROVIDER "${requested}".`, { code: "config", provider: requested, model: "" });
  }

  const keys = {
    anthropic: get("ANTHROPIC_API_KEY"),
    gemini: get("GEMINI_API_KEY") ?? get("GOOGLE_API_KEY"),
    openai: get("OPENAI_API_KEY") ?? (preset?.keyEnv ? get(preset.keyEnv) : undefined),
  };
  const openaiBaseUrl = get("OPENAI_BASE_URL") ?? preset?.baseUrl;
  if (!provider) {
    if (keys.anthropic) provider = "anthropic";
    else if (keys.gemini) provider = "gemini";
    else if (keys.openai || openaiBaseUrl) provider = "openai-compatible";
    else provider = "scripted";
  }

  const model = get("LLM_MODEL");
  const common: Partial<LlmConfig> = {
    ...(get("LLM_TIMEOUT_MS") ? { timeoutMs: Number(get("LLM_TIMEOUT_MS")) } : {}),
    ...(get("LLM_MAX_RETRIES") ? { maxRetries: Number(get("LLM_MAX_RETRIES")) } : {}),
  };

  if (provider === "anthropic" && keys.anthropic) {
    return createLlm({ provider, apiKey: keys.anthropic, model, baseUrl: get("ANTHROPIC_BASE_URL"), ...common, ...overrides });
  }
  if (provider === "gemini" && keys.gemini) {
    return createLlm({ provider, apiKey: keys.gemini, model, baseUrl: get("GEMINI_BASE_URL"), ...common, ...overrides });
  }
  const localOpenAICompatible = openaiBaseUrl !== undefined && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (provider === "openai-compatible" && (keys.openai || localOpenAICompatible)) {
    return createLlm({ provider, apiKey: keys.openai, model, baseUrl: openaiBaseUrl, ...common, ...overrides });
  }
  // No usable credentials: deterministic scripted provider (zero-key demo).
  return createLlm({ provider: "scripted", ...common, ...overrides });
}

/**
 * Returns a scripted Llm with the same settings and a different script. Real providers are returned
 * unchanged, so callers can write `withScript(llm, compromised ? scripts.shoppingCompromised : scripts.shoppingHappyPath)`.
 */
export function withScript(llm: Llm, script: readonly ScriptedTurn[], mode?: "replay" | "queue"): Llm {
  const cfg = scriptedConfigs.get(llm);
  if (!cfg) return llm;
  return createLlm({ ...cfg, script, scriptMode: mode ?? cfg.scriptMode });
}

/** Typed helper for tool definitions: `execute` receives the parsed arguments. */
export function defineTool<P extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  parameters: P;
  untrusted?: boolean;
  execute: (args: z.output<P>) => Promise<unknown>;
}): ToolDef {
  return def;
}

function requireKey(cfg: LlmConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  throw configError(cfg, `apiKey is required for provider "${cfg.provider}" (or use llmFromEnv(), which falls back to the scripted provider).`);
}

function configError(cfg: LlmConfig, message: string): LlmError {
  return new LlmError(message, { code: "config", provider: String(cfg.provider), model: cfg.model ?? "" });
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegative(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function processEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}
