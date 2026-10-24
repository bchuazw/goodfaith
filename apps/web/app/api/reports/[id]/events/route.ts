import type { NextRequest } from "next/server";
import { json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { reportEventStream } from "@/lib/server/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Live triage timeline over SSE (see lib/server/sse.ts). Resumes from Last-Event-ID or `?after=`. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/reports/[id]/events">) {
  const { id } = await ctx.params;
  const svc = getServices();
  if (!(await svc.db.reports.value(id))) return json({ error: { code: "NOT_FOUND", message: "Report not found" } }, { status: 404 });
  const after = Number(req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("after") ?? 0);
  const stream = reportEventStream(svc, id, {
    afterSeq: Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
    audience: req.nextUrl.searchParams.get("view") === "maintainer" ? "maintainer" : "researcher",
    signal: req.signal,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform keeps compression proxies from buffering the stream.
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
