"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportView, StreamTriageEvent } from "../view-types";
import { api } from "./api";

const TERMINAL_PAYOUT = new Set(["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "CANCELED"]);
const STREAMING = new Set(["awaiting_deposit", "queued", "triaging"]);

/** Nothing more will change without a person acting (or a payout that is still settling). */
function isSettledForGood(v: ReportView): boolean {
  if (v.status !== "settled") return false;
  return !v.payout || TERMINAL_PAYOUT.has(v.payout.status);
}

export type ReportStream = {
  view: ReportView;
  /** Events of the latest triage attempt, in order. */
  events: StreamTriageEvent[];
  live: boolean;
  /** Re-read the report now (after a settlement action); re-opens the stream if triage restarted. */
  refresh: () => Promise<void>;
  setView: (v: ReportView) => void;
};

/**
 * Live report state: the SSE stream while triage runs (it tails the Store, so it works on any instance),
 * then light polling while a decision or a payout is still pending.
 */
export function useReportStream(initial: ReportView, initialEvents: StreamTriageEvent[] = []): ReportStream {
  const [view, setView] = useState(initial);
  const [events, setEvents] = useState<StreamTriageEvent[]>(initialEvents);
  const [live, setLive] = useState(false);
  const [generation, setGeneration] = useState(0);
  const cursor = useRef(initialEvents.at(-1)?.seq ?? 0);
  const viewRef = useRef(initial);
  const liveRef = useRef(false);
  const audience = initial.audience;
  const id = initial.id;

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const refresh = useCallback(async () => {
    const next = await api<ReportView>(`/api/reports/${id}${audience === "maintainer" ? "?view=maintainer" : ""}`);
    viewRef.current = next;
    setView(next);
    if (STREAMING.has(next.status) && !liveRef.current) setGeneration((g) => g + 1);
  }, [id, audience]);

  useEffect(() => {
    let source: EventSource | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const setLiveBoth = (v: boolean) => {
      liveRef.current = v;
      setLive(v);
    };

    const startPolling = () => {
      if (poll || stopped) return;
      poll = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (isSettledForGood(viewRef.current)) {
          clearInterval(poll);
          poll = undefined;
          return;
        }
        void refresh().catch(() => undefined);
      }, 4000);
    };

    const open = () => {
      if (stopped) return;
      const params = new URLSearchParams();
      if (audience === "maintainer") params.set("view", "maintainer");
      if (cursor.current) params.set("after", String(cursor.current));
      source = new EventSource(`/api/reports/${id}/events?${params.toString()}`);
      setLiveBoth(true);
      source.addEventListener("triage", (e) => {
        const data = JSON.parse((e as MessageEvent<string>).data) as StreamTriageEvent;
        if (data.seq <= cursor.current) return;
        cursor.current = data.seq;
        setEvents((prev) => {
          const latest = prev.at(-1)?.attempt ?? 0;
          if (data.attempt > latest) return [data]; // a re-run starts a fresh timeline
          if (data.attempt < latest) return prev;
          return [...prev, data];
        });
      });
      source.addEventListener("report", (e) => {
        const next = JSON.parse((e as MessageEvent<string>).data) as ReportView;
        viewRef.current = next;
        setView(next);
      });
      source.addEventListener("end", (e) => {
        source?.close();
        setLiveBoth(false);
        const reason = (JSON.parse((e as MessageEvent<string>).data) as { reason?: string }).reason;
        if (reason === "timeout") setTimeout(open, 500); // the server's ~280 s cap: reconnect from the cursor
        else startPolling();
      });
      source.onerror = () => {
        // EventSource reconnects by itself (with Last-Event-ID); polling covers the gap meanwhile.
        setLiveBoth(false);
        startPolling();
      };
    };

    if (!isSettledForGood(viewRef.current)) {
      if (STREAMING.has(viewRef.current.status)) open();
      else startPolling();
    }
    return () => {
      stopped = true;
      source?.close();
      if (poll) clearInterval(poll);
      liveRef.current = false;
    };
  }, [id, audience, refresh, generation]);

  return { view, events, live, refresh, setView };
}
