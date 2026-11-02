import type { z } from "zod";
import { createEngine, type EngineOptions } from "./engine.js";
import { LlmError } from "./errors.js";
import { withFallback } from "./fallback.js";
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
 *
 * LLM_FALLBACK_PROVIDER (+ optional LLM_FALLBACK_MODEL) adds a second model tried when the first is unusable
 * (auth error, overload, timeout, refusal; see shouldFallBack). The fallback's key must be present, or this
 * throws. With a fallback the primary does not retry: moving on is faster than waiting again. If only the
 * fallback has a key, it is returned on its own.
 */
export function llmFromEnv(env?: Record<string, string | undefined>, overrides: Partial<LlmConfig> = {}): Llm {
  const e = env ?? processEnv();
  const get = (k: string) => {
    const v = e[k]?.trim();
    return v ? v : undefined;
  };
  const keys = {
    anthropic: get("ANTHROPIC_API_KEY"),
    gemini: get("GEMINI_API_KEY") ?? get("GOOGLE_API_KEY"),
  };
  const common: Partial<LlmConfig> = {
    ...(get("LLM_TIMEOUT_MS") ? { timeoutMs: Number(get("LLM_TIMEOUT_MS")) } : {}),
    ...(get("LLM_MAX_RETRIES") ? { maxRetries: Number(get("LLM_MAX_RETRIES")) } : {}),
  };

  /** The config for one provider choice, or undefined when its key is missing. */
  const configFor = (choice: ProviderChoice, model: string | undefined): LlmConfig | undefined => {
    const openaiKey = get("OPENAI_API_KEY") ?? (choice.preset?.keyEnv ? get(choice.preset.keyEnv) : undefined);
    const openaiBaseUrl = get("OPENAI_BASE_URL") ?? choice.preset?.baseUrl;
    switch (choice.provider) {
      case "anthropic":
        return keys.anthropic ? { provider: "anthropic", apiKey: keys.anthropic, model, baseUrl: get("ANTHROPIC_BASE_URL"), ...common } : undefined;
      case "gemini":
        return keys.gemini ? { provider: "gemini", apiKey: keys.gemini, model, baseUrl: get("GEMINI_BASE_URL"), ...common } : undefined;
      case "openai-compatible": {
        const local = openaiBaseUrl !== undefined && !/api\.openai\.com/i.test(openaiBaseUrl);
        return openaiKey || local ? { provider: "openai-compatible", apiKey: openaiKey, model, baseUrl: openaiBaseUrl, ...common } : undefined;
      }
      default:
        return undefined;
    }
  };

  let primaryChoice = parseProviderChoice(get("LLM_PROVIDER"), "LLM_PROVIDER");
  if (!primaryChoice) {
    if (keys.anthropic) primaryChoice = { provider: "anthropic" };
    else if (keys.gemini) primaryChoice = { provider: "gemini" };
    else if (get("OPENAI_API_KEY") || get("OPENAI_BASE_URL")) primaryChoice = { provider: "openai-compatible" };
    else primaryChoice = { provider: "scripted" };
  }
  const primaryCfg = configFor(primaryChoice, get("LLM_MODEL"));

  const fallbackChoice = parseProviderChoice(get("LLM_FALLBACK_PROVIDER"), "LLM_FALLBACK_PROVIDER");
  if (fallbackChoice) {
    if (fallbackChoice.provider === "scripted") {
      throw new LlmError("LLM_FALLBACK_PROVIDER cannot be scripted: triage already falls back to its deterministic checks.", { code: "config", provider: "scripted", model: "" });
    }
    const fallbackCfg = configFor(fallbackChoice, get("LLM_FALLBACK_MODEL"));
    if (!fallbackCfg) {
      throw new LlmError(`LLM_FALLBACK_PROVIDER=${get("LLM_FALLBACK_PROVIDER")} has no API key for ${fallbackChoice.provider}.`, {
        code: "config",
        provider: fallbackChoice.provider,
        model: get("LLM_FALLBACK_MODEL") ?? "",
      });
    }
    const { provider: _p, model: _m, apiKey: _k, baseUrl: _b, script: _s, ...shared } = overrides;
    const fallback = createLlm({ ...fallbackCfg, ...shared });
    if (!primaryCfg) return fallback;
    const primary = createLlm({ ...primaryCfg, ...overrides, maxRetries: 0 });
    if (primary.provider === fallback.provider && primary.model === fallback.model) return createLlm({ ...primaryCfg, ...overrides });
    return withFallback(primary, [fallback]);
  }

  if (primaryCfg) return createLlm({ ...primaryCfg, ...overrides });
  // No usable credentials: deterministic scripted provider (zero-key demo).
  return createLlm({ provider: "scripted", ...common, ...overrides });
}

type ProviderChoice = { provider: LlmProvider; preset?: { baseUrl: string; keyEnv?: string } };

/** Parses an LLM_PROVIDER-style value. Unset gives undefined; an unknown name throws, so a typo never becomes scripted. */
function parseProviderChoice(raw: string | undefined, envName: string): ProviderChoice | undefined {
  const requested = raw?.toLowerCase();
  switch (requested) {
    case undefined:
      return undefined;
    case "anthropic":
    case "claude":
      return { provider: "anthropic" };
    case "gemini":
    case "google":
      return { provider: "gemini" };
    case "openai":
    case "openai-compatible":
      return { provider: "openai-compatible" };
    case "openrouter":
    case "groq":
    case "ollama":
      return { provider: "openai-compatible", preset: OPENAI_COMPATIBLE_PRESETS[requested] };
    case "scripted":
    case "mock":
      return { provider: "scripted" };
    default:
      throw new LlmError(`Unknown ${envName} "${requested}".`, { code: "config", provider: requested, model: "" });
  }
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
