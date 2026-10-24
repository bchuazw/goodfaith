/** Route-handler plumbing: JSON in and out, stable error bodies, request origin, the maintainer gate. */
import "server-only";
import { AppError } from "./errors";
import type { Services } from "./services";

export type ApiError = { error: { code: string; message: string; details?: Record<string, unknown> } };

const MAX_BODY_BYTES = 256 * 1024;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...(init.headers ?? {}) } });
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new AppError("BODY_TOO_LARGE", "Request body is too large", 413);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be JSON", 400);
  }
}

/** Runs a handler and turns refusals into `{ error: { code, message } }` with the right status. */
export async function api(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AppError) {
      const body: ApiError = { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
      return json(body, { status: e.status });
    }
    // Only our own message text is logged; PayPal errors carry PayPal's message, never credentials.
    console.error(`[goodfaith] unhandled API error: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: { code: "INTERNAL", message: e instanceof Error ? e.message : "Unexpected error" } } satisfies ApiError, { status: 500 });
  }
}

/** The origin PayPal should send buyers back to: GOODFAITH_PUBLIC_URL, else the forwarded host, else the URL. */
export function requestOrigin(req: Request, svc: Services): string {
  if (svc.config.publicUrl) return svc.config.publicUrl;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (host) return `${proto || "https"}://${host}`;
  return new URL(req.url).origin;
}

export const MAINTAINER_COOKIE = "gf_maintainer";

/**
 * Settlement and other maintainer actions. Open by default (the hosted demo lets judges act as the
 * maintainer); GOODFAITH_MAINTAINER_TOKEN locks them to a header or cookie carrying that token.
 */
export function requireMaintainer(req: Request, svc: Services): void {
  const token = svc.config.maintainerToken;
  if (!token) return;
  const header = req.headers.get("x-goodfaith-maintainer");
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${MAINTAINER_COOKIE}=`))
    ?.slice(MAINTAINER_COOKIE.length + 1);
  if (header !== token && decodeURIComponent(cookie ?? "") !== token) throw new AppError("MAINTAINER_ONLY", "Maintainer actions need the maintainer token", 401);
}
