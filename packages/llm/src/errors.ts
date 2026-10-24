export type LlmErrorCode =
  | "config"
  | "http"
  | "network"
  | "timeout"
  | "refusal"
  | "truncated"
  | "validation"
  | "script"
  | "unknown";

/** Base error for everything thrown by @goodfaith/llm. Messages are redacted (no API keys). */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly provider: string;
  readonly model: string;
  readonly status?: number;
  readonly retryable: boolean;
  /** Server-suggested wait before retrying, in ms (from retry-after headers). */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    o: {
      code: LlmErrorCode;
      provider: string;
      model: string;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "LlmError";
    this.code = o.code;
    this.provider = o.provider;
    this.model = o.model;
    this.status = o.status;
    this.retryable = o.retryable ?? false;
    this.retryAfterMs = o.retryAfterMs;
  }
}

/** structured() output failed schema validation after the repair retry. */
export class LlmValidationError extends LlmError {
  readonly issues: string[];
  /** The last raw model output (truncated to 2000 chars). */
  readonly raw: string;

  constructor(message: string, o: { provider: string; model: string; issues: string[]; raw: string }) {
    super(message, { code: "validation", provider: o.provider, model: o.model });
    this.name = "LlmValidationError";
    this.issues = o.issues;
    this.raw = o.raw.length > 2000 ? `${o.raw.slice(0, 2000)}…` : o.raw;
  }
}
