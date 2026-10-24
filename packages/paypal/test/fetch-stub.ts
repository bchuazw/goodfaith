import { oauthToken } from "./fixtures.js";

export type RecordedCall = {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  /** Body exactly as passed to fetch. */
  body: string | Uint8Array | undefined;
  /** Body decoded as UTF-8 (for JSON / form bodies). */
  text: string;
};

export type Reply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | Error
  | ((call: RecordedCall) => Reply);

type Route = { method: string; path: string | RegExp; replies: Reply[]; hits: number };

/**
 * A fetch double that routes by method + path, records every call, and replays PayPal-shaped
 * fixtures. Replies are used in order; the last one repeats. The OAuth token endpoint answers with
 * the documented sample unless a test overrides it. Unknown routes answer 501 UNMOCKED_ROUTE.
 */
export function fetchStub(routes: Array<[method: string, path: string | RegExp, ...replies: Reply[]]>) {
  const table: Route[] = routes.map(([method, path, ...replies]) => ({ method, path, replies, hits: 0 }));
  if (!table.some((r) => r.path === "/v1/oauth2/token")) {
    table.push({ method: "POST", path: "/v1/oauth2/token", replies: [{ status: 200, json: oauthToken }], hits: 0 });
  }
  const calls: RecordedCall[] = [];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => {
      headers[k] = v;
    });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k as string] = v as string;
    else if (h) Object.assign(headers, h);
    const rawBody = init?.body as string | Uint8Array | undefined;
    const text = rawBody === undefined ? "" : typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
    const call: RecordedCall = { method, url, path: url.pathname, headers, body: rawBody, text };
    calls.push(call);

    const route = table.find(
      (r) => r.method === method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ name: "UNMOCKED_ROUTE", message: `${method} ${url.pathname}`, debug_id: "test" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }
    let reply = route.replies[Math.min(route.hits, route.replies.length - 1)] as Reply;
    route.hits++;
    while (typeof reply === "function") reply = reply(call);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? (method === "POST" ? 201 : 200);
    const bodyText = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(status === 204 ? null : bodyText, {
      status,
      headers: { "content-type": "application/json", "paypal-debug-id": "f00dfeed1234a", ...(reply.headers ?? {}) },
    });
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    to: (method: string, path: string | RegExp) =>
      calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
    apiCalls: () => calls.filter((c) => c.path !== "/v1/oauth2/token"),
  };
}

export type MultipartPartParsed = {
  name: string;
  filename?: string;
  contentType?: string;
  headers: string[];
  data: Uint8Array;
  text: string;
};

/** Independent multipart/form-data parser for assertions (binary safe via latin1). */
export function parseMultipart(body: Uint8Array, contentTypeHeader: string): MultipartPartParsed[] {
  const match = /boundary=([^;]+)/.exec(contentTypeHeader);
  if (!match?.[1]) throw new Error(`no boundary in ${contentTypeHeader}`);
  const boundary = match[1];
  const raw = Buffer.from(body).toString("latin1");
  const delimiter = `--${boundary}`;
  if (!raw.startsWith(delimiter)) throw new Error("body must start with the boundary delimiter");
  if (!raw.endsWith(`--${boundary}--\r\n`)) throw new Error("body must end with the closing delimiter");
  const segments = raw.split(delimiter).slice(1, -1);
  return segments.map((segment) => {
    if (!segment.startsWith("\r\n")) throw new Error("part must start with CRLF");
    const headerEnd = segment.indexOf("\r\n\r\n");
    const headerLines = segment.slice(2, headerEnd).split("\r\n");
    if (!segment.endsWith("\r\n")) throw new Error("part must end with CRLF");
    const content = segment.slice(headerEnd + 4, -2);
    const disposition = headerLines.find((l) => l.toLowerCase().startsWith("content-disposition:")) ?? "";
    const name = /name="([^"]*)"/.exec(disposition)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const contentType = headerLines.find((l) => l.toLowerCase().startsWith("content-type:"))?.split(":")[1]?.trim();
    const data = new Uint8Array(Buffer.from(content, "latin1"));
    return {
      name,
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType ? { contentType } : {}),
      headers: headerLines,
      data,
      text: new TextDecoder().decode(data),
    };
  });
}

export function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
