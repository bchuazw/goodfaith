import { LlmError, LlmValidationError } from "./errors.js";
import type { Llm } from "./types.js";

export type ModelRef = { provider: string; model: string };

/** One failed model in a fallback chain. Messages are already redacted. */
export type FallbackAttempt = ModelRef & { code: LlmError["code"]; status?: number; message: string };

/**
 * A call failed after moving past at least one model. `code`, `provider`, `model` and `status` are the last
 * model's (so callers classify it as before), `attempts` lists every model tried, and `cause` is the last error.
 */
export class LlmFallbackError extends LlmError {
  readonly attempts: FallbackAttempt[];

  constructor(attempts: FallbackAttempt[], last: LlmError) {
    const trail = attempts.map((a) => `${a.provider} ${a.model}: ${a.message}`).join("; then ");
    super(`Every model failed: ${trail}`, {
      code: last.code,
      provider: last.provider,
      model: last.model,
      ...(last.status !== undefined ? { status: last.status } : {}),
      retryable: last.retryable,
      ...(last.retryAfterMs !== undefined ? { retryAfterMs: last.retryAfterMs } : {}),
      cause: last,
    });
    this.name = "LlmFallbackError";
    this.attempts = attempts;
  }
}

/**
 * Should a failure move on to the next model? Yes when the provider is unusable right now: auth errors
 * (401/403), rate limits and overloads (408/429/5xx/529), timeouts, network failures and refusals. Never for
 * errors that are ours: a 400/404/422 request, a schema mismatch (LlmValidationError), configuration, a
 * truncated tool call, or the caller cancelling (`aborted`). Another model would fail those the same way,
 * or the caller asked us to stop.
 */
export function shouldFallBack(err: unknown): boolean {
  if (!(err instanceof LlmError) || err instanceof LlmValidationError) return false;
  switch (err.code) {
    case "timeout":
    case "network":
    case "refusal":
      return true;
    case "http": {
      const s = err.status ?? 0;
      return s === 401 || s === 403 || s === 408 || s === 429 || s >= 500;
    }
    default:
      return false;
  }
}

export type FallbackOptions = {
  /** How long a model that failed with an outage-type error is skipped (it is still tried last). Default 60 s. */
  cooldownMs?: number;
  /** The same after an auth error (401/403): a bad key will not fix itself soon. Default 10 min. */
  authCooldownMs?: number;
  /** Told whenever a call moves on to the next model. Must not throw (errors are swallowed). */
  onFallback?: (e: { from: ModelRef; to: ModelRef; error: LlmError }) => void;
  now?: () => number;
};

/**
 * An Llm that tries `primary`, then each fallback in order, moving on only when shouldFallBack() says the
 * model is unusable. A model that just failed is tried last for a cooldown, so a dead primary costs one
 * call's time, not one per call. `provider`/`model` are the primary's; the model that actually answered a
 * call is reported through the call's `onAnswer`.
 */
export function withFallback(primary: Llm, fallbacks: Llm[], opts: FallbackOptions = {}): Llm & { fallbacks: ModelRef[] } {
  const chain = [primary, ...fallbacks];
  const now = opts.now ?? Date.now;
  const downUntil = new Map<Llm, number>();
  const ref = (l: Llm): ModelRef => ({ provider: l.provider, model: l.model });

  async function run<T>(call: (llm: Llm) => Promise<T>, signal: AbortSignal | undefined, canFallBack: () => boolean = () => true): Promise<T> {
    const t = now();
    const order = [...chain.filter((l) => (downUntil.get(l) ?? 0) <= t), ...chain.filter((l) => (downUntil.get(l) ?? 0) > t)];
    const attempts: FallbackAttempt[] = [];
    for (let i = 0; i < order.length; i++) {
      const llm = order[i] as Llm;
      try {
        const value = await call(llm);
        downUntil.delete(llm);
        return value;
      } catch (e) {
        const last = i === order.length - 1;
        if (!shouldFallBack(e) || signal?.aborted || last || !canFallBack()) {
          if (attempts.length === 0 || !(e instanceof LlmError)) throw e;
          attempts.push(attemptOf(e));
          throw new LlmFallbackError(attempts, e);
        }
        const err = e as LlmError;
        const auth = err.code === "http" && (err.status === 401 || err.status === 403);
        downUntil.set(llm, now() + (auth ? (opts.authCooldownMs ?? 600_000) : (opts.cooldownMs ?? 60_000)));
        attempts.push(attemptOf(err));
        try {
          opts.onFallback?.({ from: ref(llm), to: ref(order[i + 1] as Llm), error: err });
        } catch {
          // A logging hook must never change the outcome.
        }
      }
    }
    throw new LlmError("No model to call", { code: "config", provider: primary.provider, model: primary.model });
  }

  return {
    provider: primary.provider,
    model: primary.model,
    fallbacks: fallbacks.map(ref),
    structured: (i) => run((llm) => llm.structured(i), i.signal),
    // A tool loop moves to the next model only while no tool has run: tools may have side effects, and
    // replaying them on another model could repeat them.
    toolLoop: (i) => {
      let toolsRan = false;
      const tracked = {
        ...i,
        onEvent: (e: Parameters<NonNullable<typeof i.onEvent>>[0]) => {
          if (e.type === "tool_call") toolsRan = true;
          i.onEvent?.(e);
        },
      };
      return run((llm) => llm.toolLoop(tracked), i.signal, () => !toolsRan);
    },
  };
}

function attemptOf(e: LlmError): FallbackAttempt {
  return { provider: e.provider, model: e.model, code: e.code, ...(e.status !== undefined ? { status: e.status } : {}), message: e.message.slice(0, 300) };
}
