/**
 * GOODFAITH_MODE: "mock" (the default) runs with zero keys: the PayPal mock, the scripted LLM and the
 * bundled Lantern target. "live" uses the real PayPal sandbox and a real LLM, and fails loudly when either
 * is missing instead of silently falling back to a mock.
 */
import { type Llm, llmFromEnv } from "@goodfaith/llm";
import { isMockPayPal, type PayPalClient, paypalFromEnv } from "@goodfaith/paypal";

export type AppMode = "mock" | "live";
type Env = Record<string, string | undefined>;

/** Where the mock's approval links point: the app's own fake approval sheet. */
export const MOCK_PAYPAL_BASE = "/mock-paypal";

export function appModeFromEnv(env: Env): AppMode {
  const raw = env.GOODFAITH_MODE?.trim().toLowerCase();
  if (!raw || raw === "mock") return "mock";
  if (raw === "live") return "live";
  throw new Error(`GOODFAITH_MODE must be "mock" or "live" (got "${raw}")`);
}

export function paypalForMode(mode: AppMode, env: Env): PayPalClient {
  if (mode === "mock") {
    return paypalFromEnv({ ...env, GOODFAITH_MODE: "mock", PAYPAL_MOCK_WEB_BASE_URL: env.PAYPAL_MOCK_WEB_BASE_URL?.trim() || MOCK_PAYPAL_BASE });
  }
  const client = paypalFromEnv({ ...env, GOODFAITH_MODE: "live" }); // throws without PAYPAL_CLIENT_ID/SECRET
  if (isMockPayPal(client)) throw new Error("GOODFAITH_MODE=live, but PAYPAL_MODE=mock forces the PayPal mock: unset one of them");
  return client;
}

/**
 * Per-call LLM limits that fit triage into a 300 s serverless function: 45 s per attempt and one retry,
 * so even a model that never answers costs at most ~90 s per call before triage moves on. LLM_TIMEOUT_MS
 * and LLM_MAX_RETRIES override them.
 */
export const TRIAGE_LLM_DEFAULTS = { LLM_TIMEOUT_MS: "45000", LLM_MAX_RETRIES: "1" } as const;

/** The environment the triage LLM is built from: `env`, with TRIAGE_LLM_DEFAULTS filling unset limits. */
export function triageLlmEnv(env: Env): Env {
  const out: Env = { ...env };
  for (const [k, v] of Object.entries(TRIAGE_LLM_DEFAULTS)) if (!out[k]?.trim()) out[k] = v;
  return out;
}

export function llmForMode(mode: AppMode, env: Env): Llm {
  if (mode === "mock") return llmFromEnv({ LLM_PROVIDER: "scripted" });
  const llm = llmFromEnv(triageLlmEnv(env));
  if (llm.provider === "scripted") {
    throw new Error("GOODFAITH_MODE=live needs a real LLM: set ANTHROPIC_API_KEY (or LLM_PROVIDER and that provider's key)");
  }
  return llm;
}
