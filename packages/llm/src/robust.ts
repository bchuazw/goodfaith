import { LlmError } from "./errors.js";
import type { LlmLogEntry, LlmUsage } from "./types.js";

export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
};

export type CallMeta = {
  provider: string;
  model: string;
  op: "structured" | "toolLoop";
  name?: string;
  step: number;
};

export type Attempt<T> = { value: T; usage?: LlmUsage; stopReason?: string };

export type CallHooks = {
  log?: (e: LlmLogEntry) => void;
  redact: (text: string) => string;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs one model call with a per-attempt timeout (AbortSignal + race), exponential backoff with jitter
 * on retryable failures (408/409/429/5xx, timeouts, network errors; honours retry-after), and one log
 * entry per attempt. Errors are normalised to `LlmError` with redacted messages.
 */
export async function robustCall<T>(
  policy: RetryPolicy,
  meta: CallMeta,
  hooks: CallHooks,
  fn: (signal: AbortSignal) => Promise<Attempt<T>>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new LlmError(`Model call timed out after ${policy.timeoutMs} ms`, {
              code: "timeout",
              provider: meta.provider,
              model: meta.model,
              retryable: true,
            }),
          );
          controller.abort();
        }, policy.timeoutMs);
      });
      const result = await Promise.race([fn(controller.signal), timeout]);
      emit(hooks.log, {
        ...base(meta, attempt),
        ok: true,
        latencyMs: Date.now() - started,
        usage: result.usage,
        stopReason: result.stopReason,
      });
      return result.value;
    } catch (err) {
      const e = toLlmError(err, meta, hooks.redact);
      const willRetry = e.retryable && attempt < policy.maxRetries;
      emit(hooks.log, {
        ...base(meta, attempt),
        ok: false,
        latencyMs: Date.now() - started,
        status: e.status,
        error: e.message,
        willRetry,
      });
      if (!willRetry) throw e;
      await (hooks.sleep ?? sleep)(backoffMs(attempt, policy, e.retryAfterMs));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function base(meta: CallMeta, attempt: number) {
  return {
    ts: new Date().toISOString(),
    provider: meta.provider,
    model: meta.model,
    op: meta.op,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    step: meta.step,
    attempt,
  };
}

function emit(log: ((e: LlmLogEntry) => void) | undefined, entry: LlmLogEntry): void {
  if (!log) return;
  try {
    log(entry);
  } catch {
    // Logging is best effort and must never break a model call.
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function backoffMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jittered = exp / 2 + (Math.random() * exp) / 2;
  return Math.min(policy.maxDelayMs, Math.max(retryAfterMs ?? 0, jittered));
}

/** Normalises SDK / fetch errors. Retryable: 408, 409, 429, >= 500, timeouts and network failures. */
export function toLlmError(err: unknown, meta: Pick<CallMeta, "provider" | "model">, redact: (s: string) => string): LlmError {
  if (err instanceof LlmError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    status?: unknown;
    headers?: unknown;
    name?: unknown;
    code?: unknown;
  };
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redact(rawMessage);
  const common = { provider: meta.provider, model: meta.model };
  if (typeof e.status === "number") {
    const status = e.status;
    return new LlmError(`${meta.provider} API error ${status}: ${message}`, {
      ...common,
      code: "http",
      status,
      retryable: status === 408 || status === 409 || status === 429 || status >= 500,
      retryAfterMs: retryAfterFrom(e.headers),
    });
  }
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.code === "string" ? e.code : "";
  if (/timeout/i.test(name) || name === "AbortError" || /timed? ?out/i.test(rawMessage)) {
    return new LlmError(`${meta.provider} request timed out: ${message}`, { ...common, code: "timeout", retryable: true });
  }
  if (
    name === "APIConnectionError" ||
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_\w+)$/.test(code) ||
    /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection error/i.test(rawMessage)
  ) {
    return new LlmError(`${meta.provider} network error: ${message}`, { ...common, code: "network", retryable: true });
  }
  return new LlmError(message, { ...common, code: "unknown", retryable: false });
}

function retryAfterFrom(headers: unknown): number | undefined {
  const get = (key: string): string | undefined => {
    if (headers && typeof (headers as { get?: unknown }).get === "function") {
      const v = (headers as Headers).get(key);
      return v ?? undefined;
    }
    if (headers && typeof headers === "object") {
      const v = (headers as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    }
    return undefined;
  };
  const ms = get("retry-after-ms");
  if (ms !== undefined && ms.trim() !== "" && Number.isFinite(Number(ms))) return Number(ms);
  const s = get("retry-after");
  if (s === undefined || s.trim() === "") return undefined;
  if (Number.isFinite(Number(s))) return Number(s) * 1000;
  const date = Date.parse(s);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-[REDACTED]"],
  [/\bsk-(?:proj-|or-v1-|live-|svcacct-)?[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]"],
  [/\bgsk_[A-Za-z0-9]{16,}/g, "gsk_[REDACTED]"],
  [/((?:x-api-key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, "$1[REDACTED]"],
  [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, "$1[REDACTED]"],
];

/** Returns a function that removes the given secrets and anything that looks like an API key. */
export function makeRedactor(secrets: Array<string | undefined>): (text: string) => string {
  const list = secrets.filter((s): s is string => typeof s === "string" && s.length >= 6);
  return (text: string) => {
    let out = text;
    for (const secret of list) out = out.split(secret).join("[REDACTED]");
    for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
    return out;
  };
}

/** Races a promise against a timeout (used for tool execution). */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
