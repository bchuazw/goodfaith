/**
 * The triage stream: Server-Sent Events that tail the Store, so the instance serving the stream does not
 * have to be the one running triage. It polls every ~500 ms (woken early by same-instance signals),
 * resumes from Last-Event-ID, sends heartbeat comments, and closes once triage has spoken or after ~280 s.
 *
 * Frames: `event: triage` (id = the event's sequence number) carries a TriageEvent; `event: report`
 * carries the report view whenever it changes; `event: end` says why the stream closed.
 */
import type { ReportView } from "../view-types";
import type { Services } from "./services";
import { triageEvents } from "./triage";
import { type Audience, reportView } from "./views";

export type StreamOptions = { afterSeq?: number; audience?: Audience; signal?: AbortSignal; pollMs?: number; maxMs?: number; heartbeatMs?: number };

const QUIET: ReadonlyArray<ReportView["status"]> = ["triaged", "settled", "triage_failed"];

function frame(event: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function reportEventStream(svc: Services, reportId: string, opts: StreamOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = opts.pollMs ?? 500;
  const maxMs = opts.maxMs ?? 280_000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const audience = opts.audience ?? "researcher";
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const finish = (reason: string) => {
        if (closed) return;
        send(frame("end", { reason }));
        closed = true;
        controller.close();
      };
      opts.signal?.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      });

      let cursor = opts.afterSeq ?? 0;
      let lastView = "";
      let lastBeat = Date.now();
      const started = Date.now();
      const flushEvents = async () => {
        for (const e of await triageEvents(svc, reportId, cursor)) {
          send(frame("triage", e, e.seq));
          cursor = e.seq;
        }
      };

      send("retry: 2000\n\n");
      try {
        while (!closed) {
          await flushEvents();
          const view = await reportView(svc, reportId, audience);
          const snapshot = JSON.stringify(view);
          if (snapshot !== lastView) {
            send(frame("report", view));
            lastView = snapshot;
          }
          if (QUIET.includes(view.status)) {
            await flushEvents(); // anything appended between the two reads
            return finish("done");
          }
          if (Date.now() - started > maxMs) return finish("timeout");
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(": keep-alive\n\n");
            lastBeat = Date.now();
          }
          await svc.signals.wait(reportId, pollMs, opts.signal);
        }
      } catch (e) {
        if (!closed) {
          send(frame("error", { message: e instanceof Error ? e.message : "stream failed" }));
          finish("error");
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
}
