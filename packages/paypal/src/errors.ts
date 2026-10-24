/**
 * Typed errors. Messages are built only from PayPal's response fields (name, message, issue,
 * description, debug_id) or from our own validation text, never from credentials, tokens or
 * request headers, so they are safe to log and to show in the demo UI.
 */

export type PayPalErrorDetail = {
  issue: string;
  description?: string;
  field?: string;
  value?: string;
  location?: string;
};

/** A HATEOAS link from an error body (e.g. the original payout batch for a duplicate sender_batch_id). */
export type PayPalErrorLink = { href: string; rel: string; method?: string };

export type PayPalErrorInit = {
  /** HTTP status. 0 means the request never got a PayPal response (validation or network failure). */
  status: number;
  /** PayPal error name, e.g. UNPROCESSABLE_ENTITY, or invalid_client for OAuth errors. */
  name: string;
  message: string;
  debugId?: string;
  details?: PayPalErrorDetail[];
  informationLink?: string;
  /** Every HATEOAS link in the error body. */
  links?: PayPalErrorLink[];
  method?: string;
  path?: string;
};

/** Error names for failures that happen on our side of the wire. */
export const LOCAL_ERROR = {
  validation: "CLIENT_VALIDATION_ERROR",
  network: "NETWORK_ERROR",
  unexpectedResponse: "UNEXPECTED_RESPONSE",
  sandboxOnly: "SANDBOX_ONLY",
} as const;

export class PayPalError extends Error {
  readonly status: number;
  override readonly name: string;
  readonly debugId?: string;
  readonly details: PayPalErrorDetail[];
  readonly informationLink?: string;
  /** HATEOAS links from the error body (empty when there were none). */
  readonly links: PayPalErrorLink[];
  readonly method?: string;
  readonly path?: string;
  /** The PayPal message without the decorations added to `message`. */
  readonly paypalMessage: string;

  constructor(init: PayPalErrorInit) {
    super(formatMessage(init));
    this.status = init.status;
    this.name = init.name;
    this.paypalMessage = init.message;
    this.details = init.details ?? [];
    this.links = init.links ?? [];
    if (init.debugId !== undefined) this.debugId = init.debugId;
    if (init.informationLink !== undefined) this.informationLink = init.informationLink;
    if (init.method !== undefined) this.method = init.method;
    if (init.path !== undefined) this.path = init.path;
  }

  /** snake_case alias matching PayPal's field name. */
  get debug_id(): string | undefined {
    return this.debugId;
  }

  /** The first detail's issue code, e.g. PAYMENT_DENIED, ORDER_NOT_APPROVED. */
  get issue(): string | undefined {
    return this.details[0]?.issue;
  }

  /** True for failures that are safe to retry with the same PayPal-Request-Id. */
  get retryable(): boolean {
    if (this.status === 0) return this.name === LOCAL_ERROR.network;
    if (this.status === 429 || this.status >= 500) return true;
    return this.status === 409 && this.details.some((d) => d.issue === "PREVIOUS_REQUEST_IN_PROGRESS");
  }

  /** True when `issue` (or the error name) matches. */
  is(issueOrName: string): boolean {
    return this.name === issueOrName || this.details.some((d) => d.issue === issueOrName);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      message: this.paypalMessage,
      debug_id: this.debugId,
      details: this.details,
      information_link: this.informationLink,
      ...(this.links.length ? { links: this.links } : {}),
      method: this.method,
      path: this.path,
    };
  }
}

export function isPayPalError(e: unknown): e is PayPalError {
  return e instanceof PayPalError;
}

export function validationError(message: string, details?: PayPalErrorDetail[]): PayPalError {
  return new PayPalError({
    status: 0,
    name: LOCAL_ERROR.validation,
    message,
    ...(details ? { details } : {}),
  });
}

function formatMessage(init: PayPalErrorInit): string {
  const first = init.details?.[0];
  let text = `${init.name}: ${init.message}`;
  if (first) text += ` [${first.issue}${first.description ? `: ${first.description}` : ""}]`;
  if (init.method && init.path) text += ` (${init.method} ${init.path})`;
  if (init.debugId) text += ` debug_id=${init.debugId}`;
  return text;
}

type RawError = {
  name?: unknown;
  message?: unknown;
  debug_id?: unknown;
  details?: unknown;
  links?: unknown;
  /** v1 APIs (Payouts, Disputes) send it as a top-level string; v2 puts it in links. */
  information_link?: unknown;
  error?: unknown;
  error_description?: unknown;
};

/**
 * Maps a non-2xx PayPal response body into a PayPalError. Handles both the REST error shape
 * ({ name, message, debug_id, details }) and the identity/OAuth shape ({ error, error_description }).
 * Non-JSON bodies (proxies, HTML error pages) are summarised, not echoed.
 */
export function errorFromResponse(input: {
  status: number;
  statusText?: string;
  bodyText: string;
  debugIdHeader?: string | null;
  method?: string;
  path?: string;
}): PayPalError {
  let parsed: RawError | undefined;
  if (input.bodyText.trim().length > 0) {
    try {
      const value: unknown = JSON.parse(input.bodyText);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as RawError;
    } catch {
      parsed = undefined;
    }
  }

  const base = {
    status: input.status,
    ...(input.method ? { method: input.method } : {}),
    ...(input.path ? { path: input.path } : {}),
  };
  const headerDebugId = input.debugIdHeader ?? undefined;

  if (!parsed) {
    return new PayPalError({
      ...base,
      name: `HTTP_${input.status}`,
      message: input.statusText?.trim() || "PayPal returned a non-JSON error response",
      ...(headerDebugId ? { debugId: headerDebugId } : {}),
    });
  }

  if (typeof parsed.error === "string" && parsed.name === undefined) {
    return new PayPalError({
      ...base,
      name: parsed.error,
      message: typeof parsed.error_description === "string" ? parsed.error_description : parsed.error,
      ...(headerDebugId ? { debugId: headerDebugId } : {}),
    });
  }

  const details: PayPalErrorDetail[] = Array.isArray(parsed.details)
    ? parsed.details.flatMap((d): PayPalErrorDetail[] => {
        if (!d || typeof d !== "object") return [];
        const r = d as Record<string, unknown>;
        const issue = typeof r.issue === "string" ? r.issue : typeof r.name === "string" ? r.name : undefined;
        if (!issue) return [];
        const detail: PayPalErrorDetail = { issue };
        if (typeof r.description === "string") detail.description = r.description;
        if (typeof r.field === "string") detail.field = r.field;
        if (typeof r.value === "string") detail.value = r.value;
        if (typeof r.location === "string") detail.location = r.location;
        return [detail];
      })
    : [];

  let informationLink: string | undefined;
  const links: PayPalErrorLink[] = [];
  const collectLinks = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const l of list) {
      if (!l || typeof l !== "object") continue;
      const r = l as Record<string, unknown>;
      if (typeof r.href !== "string" || typeof r.rel !== "string") continue;
      links.push({ href: r.href, rel: r.rel, ...(typeof r.method === "string" ? { method: r.method } : {}) });
      if (r.rel === "information_link") informationLink = r.href;
    }
  };
  if (typeof parsed.information_link === "string") informationLink = parsed.information_link;
  collectLinks(parsed.links);
  // Some APIs (Payouts' duplicate sender_batch_id) put the link to the existing resource on the detail.
  if (Array.isArray(parsed.details)) {
    for (const d of parsed.details) {
      if (d && typeof d === "object") {
        collectLinks((d as Record<string, unknown>).link);
        collectLinks((d as Record<string, unknown>).links);
      }
    }
  }

  const debugId = typeof parsed.debug_id === "string" ? parsed.debug_id : headerDebugId;
  return new PayPalError({
    ...base,
    name: typeof parsed.name === "string" ? parsed.name : `HTTP_${input.status}`,
    message: typeof parsed.message === "string" ? parsed.message : input.statusText?.trim() || "PayPal request failed",
    details,
    ...(debugId ? { debugId } : {}),
    ...(informationLink ? { informationLink } : {}),
    ...(links.length ? { links } : {}),
  });
}
