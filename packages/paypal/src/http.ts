/**
 * Transport for the PayPal REST APIs on plain fetch: OAuth2 client-credentials token cache,
 * PayPal headers, bounded retries for idempotent calls, and PayPalError mapping.
 *
 * Secrets never leave this module except inside the Authorization header sent to PayPal: they are
 * not stored on errors, not passed to the log hook, and not included in any message.
 */
import { z } from "zod";
import { LOCAL_ERROR, PayPalError, errorFromResponse } from "./errors.js";
import type { PayPalEnv } from "./types.js";

export const PAYPAL_API_BASE: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export const PAYPAL_WEB_BASE: Record<PayPalEnv, string> = {
  sandbox: "https://www.sandbox.paypal.com",
  live: "https://www.paypal.com",
};

/** One line per HTTP attempt, safe to log or show in a UI (no headers, no bodies, no secrets). */
export type HttpLogEntry = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  attempt: number;
  requestId?: string;
  debugId?: string;
  error?: string;
};

export type HttpConfig = {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  fetch?: typeof fetch;
  baseUrl?: string;
  partnerAttributionId?: string;
  /** Retries after the first attempt for idempotent calls (default 2). */
  maxRetries?: number;
  /** Base backoff in ms, doubled per retry (default 300). */
  retryBaseDelayMs?: number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  onLog?: (entry: HttpLogEntry) => void;
  now?: () => number;
};

export type RequestSpec = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  /** JSON body (serialised with JSON.stringify). */
  json?: unknown;
  /** Pre-serialised JSON body, sent byte for byte (webhook verification). */
  rawJson?: string;
  multipart?: { body: Uint8Array<ArrayBuffer>; contentType: string };
  /** PayPal-Request-Id (idempotency key). */
  requestId?: string;
  prefer?: "return=representation" | "return=minimal";
  authAssertion?: string;
  /** Whether 5xx/429/network failures may be retried. Default: GET, or any call with a requestId. */
  retry?: boolean;
};

export type HttpResponse<T = unknown> = { status: number; data: T; headers: Headers };

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().positive(),
  scope: z.string().optional(),
  app_id: z.string().optional(),
});

type CachedToken = { token: string; expiresAt: number; scopes: string[]; appId?: string };

export type TokenInfo = { scopes: string[]; appId?: string; expiresAt: string };

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function basicAuth(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export class PayPalHttp {
  readonly env: PayPalEnv;
  readonly baseUrl: string;
  private readonly cfg: HttpConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: CachedToken | undefined;
  private inflight: Promise<CachedToken> | undefined;

  constructor(cfg: HttpConfig) {
    this.cfg = cfg;
    this.env = cfg.env;
    this.baseUrl = (cfg.baseUrl ?? PAYPAL_API_BASE[cfg.env]).replace(/\/+$/, "");
    const f = cfg.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("@goodfaith/paypal: no fetch implementation available");
    this.fetchImpl = f;
    this.now = cfg.now ?? (() => Date.now());
  }

  /** Drops the cached access token (the next call fetches a new one). */
  clearToken(): void {
    this.cached = undefined;
  }

  async accessToken(): Promise<string> {
    return (await this.token()).token;
  }

  /** Scopes granted to the app's token: tells you which PayPal features are switched on. */
  async tokenInfo(): Promise<TokenInfo> {
    const t = await this.token();
    return { scopes: t.scopes, ...(t.appId ? { appId: t.appId } : {}), expiresAt: new Date(t.expiresAt).toISOString() };
  }

  private async token(): Promise<CachedToken> {
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetchToken(): Promise<CachedToken> {
    const data = await this.oauthGrant("grant_type=client_credentials");
    const lifetimeMs = data.expires_in * 1000;
    // Refresh early: 5 minutes, or 10% of the lifetime for short-lived tokens.
    const skewMs = Math.min(5 * 60_000, lifetimeMs / 10);
    const token: CachedToken = {
      token: data.access_token,
      expiresAt: this.now() + lifetimeMs - skewMs,
      scopes: (data.scope ?? "").split(/\s+/).filter(Boolean),
      ...(data.app_id ? { appId: data.app_id } : {}),
    };
    this.cached = token;
    return token;
  }

  /**
   * A browser-safe client token for the JS SDK v6 (`paypal.createInstance({ clientToken })`): the same
   * client-credentials grant with `response_type=client_token`, optionally bound to `domains` (sent as
   * one comma-separated `domains[]` field, as PayPal documents it). It is minted fresh on every call and
   * never touches the cached server access token, which must not reach a browser.
   */
  async clientToken(opts: { domains?: string[] } = {}): Promise<{ token: string; expiresIn: number }> {
    const form = new URLSearchParams({ grant_type: "client_credentials", response_type: "client_token" });
    if (opts.domains?.length) form.set("domains[]", opts.domains.join(","));
    const data = await this.oauthGrant(form.toString());
    return { token: data.access_token, expiresIn: data.expires_in };
  }

  /** POST /v1/oauth2/token with Basic auth: bounded retries, PayPalError mapping, secret-free logs. */
  private async oauthGrant(body: string): Promise<z.infer<typeof tokenResponseSchema>> {
    const path = "/v1/oauth2/token";
    const maxRetries = this.cfg.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const started = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: basicAuth(this.cfg.clientId, this.cfg.clientSecret),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        });
      } catch (e) {
        this.log({ method: "POST", path, status: 0, durationMs: this.now() - started, attempt, error: LOCAL_ERROR.network });
        if (attempt < maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw networkError("POST", path, e);
      }
      const text = await res.text();
      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      this.log({ method: "POST", path, status: res.status, durationMs: this.now() - started, attempt, ...(debugId ? { debugId } : {}) });
      if (!res.ok) {
        const err = errorFromResponse({ status: res.status, statusText: res.statusText, bodyText: text, debugIdHeader: debugId ?? null, method: "POST", path });
        if (err.retryable && attempt < maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
      const parsed = tokenResponseSchema.safeParse(safeJson(text));
      if (!parsed.success) {
        throw new PayPalError({ status: res.status, name: LOCAL_ERROR.unexpectedResponse, message: "OAuth token response was not understood", method: "POST", path });
      }
      return parsed.data;
    }
  }

  async request<T = unknown>(spec: RequestSpec): Promise<HttpResponse<T>> {
    const retryAllowed = spec.retry ?? (spec.method === "GET" || spec.requestId !== undefined);
    const maxRetries = retryAllowed ? (this.cfg.maxRetries ?? 2) : 0;
    const url = this.url(spec);
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      let body: string | Uint8Array<ArrayBuffer> | undefined;
      if (spec.multipart) {
        headers["Content-Type"] = spec.multipart.contentType;
        body = spec.multipart.body;
      } else if (spec.rawJson !== undefined) {
        headers["Content-Type"] = "application/json";
        body = spec.rawJson;
      } else if (spec.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(spec.json);
      }
      if (spec.requestId) headers["PayPal-Request-Id"] = spec.requestId;
      if (spec.prefer) headers.Prefer = spec.prefer;
      if (spec.authAssertion) headers["PayPal-Auth-Assertion"] = spec.authAssertion;
      if (this.cfg.partnerAttributionId) headers["PayPal-Partner-Attribution-Id"] = this.cfg.partnerAttributionId;

      const started = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        });
      } catch (e) {
        this.log({
          method: spec.method,
          path: spec.path,
          status: 0,
          durationMs: this.now() - started,
          attempt,
          ...(spec.requestId ? { requestId: spec.requestId } : {}),
          error: LOCAL_ERROR.network,
        });
        if (attempt < maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw networkError(spec.method, spec.path, e);
      }

      const text = await res.text();
      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      this.log({
        method: spec.method,
        path: spec.path,
        status: res.status,
        durationMs: this.now() - started,
        attempt,
        ...(spec.requestId ? { requestId: spec.requestId } : {}),
        ...(debugId ? { debugId } : {}),
      });

      if (res.status === 401 && !refreshedAfter401) {
        // Token expired or was revoked early: fetch a new one and replay once.
        refreshedAfter401 = true;
        this.clearToken();
        continue;
      }

      if (!res.ok) {
        const err = errorFromResponse({
          status: res.status,
          statusText: res.statusText,
          bodyText: text,
          debugIdHeader: debugId ?? null,
          method: spec.method,
          path: spec.path,
        });
        if (err.retryable && attempt < maxRetries) {
          await sleep(this.backoff(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw err;
      }

      return { status: res.status, data: safeJson(text) as T, headers: res.headers };
    }
  }

  private url(spec: RequestSpec): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return `${this.baseUrl}${spec.path}${q ? `?${q}` : ""}`;
  }

  private backoff(attempt: number, retryAfter?: string | null): number {
    const base = this.cfg.retryBaseDelayMs ?? 300;
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    return base * 2 ** attempt;
  }

  private log(entry: HttpLogEntry): void {
    try {
      this.cfg.onLog?.(entry);
    } catch {
      // Logging must never break a payment call.
    }
  }
}

function safeJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function networkError(method: string, path: string, e: unknown): PayPalError {
  const reason =
    e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      ? "request timed out"
      : "could not reach PayPal";
  return new PayPalError({ status: 0, name: LOCAL_ERROR.network, message: reason, method, path });
}

/** base64url without padding, as used in JWT compact serialisation. */
export function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Unsigned PayPal-Auth-Assertion JWT ({"alg":"none"}), as PayPal's REST "API requests" guide
 * recommends. `subject` identifies who the call is made for: { email } or { payer_id }.
 */
export function authAssertion(clientId: string, subject: { email: string } | { payer_id: string }): string {
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify({ iss: clientId, ...subject }))}.`;
}
