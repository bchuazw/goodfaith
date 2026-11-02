"use client";

import type { CanaryHit, Finding, ReplayStep, TriageStage, TriageVerdict } from "@goodfaith/core";
import { BotIcon, CheckIcon, CircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { VERDICT_META } from "@/components/status";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { StreamTriageEvent } from "@/lib/view-types";
import { aiLabel, DegradedNotice } from "./ai-status";
import { FindingRow } from "./finding-row";
import { ReplayStepRow } from "./replay-step";

export const STAGES: Array<{ id: TriageStage; label: string; hint: string }> = [
  { id: "claims", label: "Read the claims", hint: "What the report asserts, read as untrusted data" },
  { id: "version", label: "Version in scope", hint: "Does the claimed version exist?" },
  { id: "code_refs", label: "Cited code exists", hint: "Every file and function, checked deterministically" },
  { id: "duplicates", label: "Not a duplicate", hint: "Compared with reports already verified" },
  { id: "replay", label: "Sandbox replay", hint: "The PoC runs against a fresh Lantern with seeded canaries" },
  { id: "assess", label: "Assessment", hint: "Severity and the slop score" },
  { id: "verdict", label: "Verdict", hint: "A fixed, conservative policy decides" },
];

type StageState = {
  status: "pending" | "running" | "done";
  note?: string;
  startedAt?: string;
  finishedAt?: string;
  findings: Finding[];
  steps: ReplayStep[];
};

export type TimelineModel = { stages: Record<TriageStage, StageState>; verdict?: TriageVerdict; current?: TriageStage };

export function buildTimeline(events: StreamTriageEvent[]): TimelineModel {
  const stages = {} as Record<TriageStage, StageState>;
  for (const s of STAGES) stages[s.id] = { status: "pending", findings: [], steps: [] };
  let open: TriageStage | undefined;
  let verdict: TriageVerdict | undefined;
  for (const { event } of events) {
    if (event.type === "stage") {
      const s = stages[event.stage];
      if (event.status === "start") {
        s.status = "running";
        s.startedAt = event.at;
        open = event.stage;
      } else {
        s.status = "done";
        s.finishedAt = event.at;
        if (event.note) s.note = event.note;
        if (open === event.stage) open = undefined;
      }
    } else if (event.type === "finding") {
      stages[open ?? stageForFinding(event.finding)].findings.push(event.finding);
    } else if (event.type === "replay_step") {
      stages.replay.steps.push(event.step);
    } else if (event.type === "verdict") {
      verdict = event.verdict;
    }
  }
  return { stages, ...(verdict ? { verdict } : {}), ...(open ? { current: open } : {}) };
}

function stageForFinding(f: Finding): TriageStage {
  switch (f.kind) {
    case "version":
      return "version";
    case "code_ref":
    case "injection":
      return "code_refs";
    case "duplicate":
      return "duplicates";
    case "poc":
      return "replay";
    default:
      return "assess";
  }
}

/**
 * Reveals a burst of events one by one (the scripted engine emits a whole run in milliseconds), while a
 * page opened on a finished run shows everything at once. Purely presentational: order and content are
 * exactly what was streamed.
 */
function useStaggered(count: number, animate: boolean): number {
  const [shown, setShown] = useState(animate ? 0 : count);
  useEffect(() => {
    if (!animate || shown >= count) return;
    const t = setTimeout(() => setShown((s) => Math.min(count, s + 1)), shown === 0 ? 150 : 170);
    return () => clearTimeout(t);
  }, [count, shown, animate]);
  return animate ? Math.min(shown, count) : count;
}

export function TriageTimeline({
  events,
  running,
  compact,
  failed,
}: {
  events: StreamTriageEvent[];
  /** Triage is in progress (or about to start): animate arrivals and show the active stage. */
  running: boolean;
  compact?: boolean;
  failed?: string;
}) {
  // Stagger arrivals for a run watched live (or one that has not started yet); show a finished run at once.
  const [animate] = useState(running || events.length === 0);
  const shown = useStaggered(events.length, animate);
  const visible = useMemo(() => events.slice(0, shown), [events, shown]);
  const model = useMemo(() => buildTimeline(visible), [visible]);
  const replayHits: CanaryHit[] = model.verdict?.replay?.canaryHits ?? [];
  const catchingUp = shown < events.length;
  const attempt = events.at(-1)?.attempt;
  const pendingIndex = firstPending(model);

  return (
    <ol className="relative space-y-1" aria-live="polite" aria-busy={running || catchingUp}>
      {STAGES.map((stage, i) => {
        const s = model.stages[stage.id];
        // While waiting for the next event, the first unfinished stage is the one being worked on.
        const active = s.status === "running" || (running && !model.verdict && i === pendingIndex);
        const duration = s.startedAt && s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : undefined;
        const last = i === STAGES.length - 1;
        return (
          <li key={stage.id} className="relative flex gap-3 pb-3">
            {!last && <span aria-hidden className={cn("absolute top-7 bottom-0 left-[13px] w-px", s.status === "done" ? "bg-primary/40" : "bg-border")} />}
            <StageDot status={s.status} active={active} index={i + 1} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h4 className={cn("text-sm font-medium", s.status === "pending" && !active && "text-muted-foreground")}>{stage.label}</h4>
                {s.status === "done" && s.note && stage.id !== "verdict" && <span className="text-xs text-muted-foreground">{s.note}</span>}
                {duration !== undefined && <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground tabular">{formatDuration(duration)}</span>}
              </div>
              {!compact && s.status === "pending" && <p className="text-xs text-muted-foreground/80">{stage.hint}</p>}
              {(s.findings.length > 0 || s.steps.length > 0) && (
                <div className="mt-2 space-y-2.5">
                  {stage.id === "replay" &&
                    s.steps.map((step) => (
                      <div key={step.index} className="animate-rise-in">
                        <ReplayStepRow step={step} hits={replayHits} defaultOpen={!compact && replayHits.some((h) => h.stepIndex === step.index)} />
                      </div>
                    ))}
                  {s.findings.map((f, k) => (
                    <FindingRow key={`${f.kind}-${k}`} finding={f} compact={compact} />
                  ))}
                </div>
              )}
              {stage.id === "verdict" && model.verdict && <VerdictStamp verdict={model.verdict} compact={compact} />}
            </div>
          </li>
        );
      })}
      {failed && (
        <li className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-strong" role="alert">
          Triage stopped: {failed}
        </li>
      )}
      {attempt && attempt > 1 && <li className="text-xs text-muted-foreground">Attempt {attempt}</li>}
    </ol>
  );
}

function firstPending(model: TimelineModel): number {
  return STAGES.findIndex((s) => model.stages[s.id].status !== "done");
}

function StageDot({ status, active, index }: { status: StageState["status"]; active: boolean; index: number }) {
  if (status === "done") {
    return (
      <span className="relative z-10 flex size-7 shrink-0 animate-tick-in items-center justify-center rounded-full bg-primary text-primary-foreground">
        <CheckIcon className="size-4" aria-hidden />
        <span className="sr-only">Step {index} done</span>
      </span>
    );
  }
  if (status === "running" || active) {
    return (
      <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-background ring-2 ring-primary animate-pulse-ring">
        <span className="size-2.5 animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="sr-only">Step {index} running</span>
      </span>
    );
  }
  return (
    <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-background font-mono text-[0.7rem] text-muted-foreground ring-1 ring-border">
      <CircleIcon className="sr-only" aria-hidden />
      {index}
    </span>
  );
}

export function VerdictStamp({ verdict, compact }: { verdict: TriageVerdict; compact?: boolean }) {
  const m = VERDICT_META[verdict.verdict];
  const tone = {
    success: "text-success-strong ring-success/50 bg-success-soft",
    info: "text-primary ring-primary/40 bg-accent",
    warning: "text-warning-strong ring-warning/50 bg-warning-soft",
    danger: "text-danger-strong ring-danger/50 bg-danger-soft",
    neutral: "text-muted-foreground ring-border bg-muted",
    seal: "text-seal-strong ring-seal/50",
  }[m.tone];
  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn("stamp inline-flex animate-stamp-in items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-sm font-bold tracking-[0.18em] uppercase ring-2 ring-inset", tone)}>
          <m.icon className="size-4" aria-hidden />
          {m.label}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular">confidence {(verdict.confidence * 100).toFixed(0)}%</span>
        {verdict.suggestedSeverity && <span className="text-xs text-muted-foreground">suggested severity <strong className="font-medium text-foreground capitalize">{verdict.suggestedSeverity.level}</strong></span>}
      </div>
      {!compact && <p className="max-w-prose text-sm leading-relaxed">{verdict.summary}</p>}
      <DegradedNotice verdict={verdict} className="max-w-prose" />
      <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
        <BotIcon className="size-3.5" aria-hidden />
        {aiLabel(verdict.model)}: <span className="font-mono">{verdict.model.model}</span>
        <span aria-hidden>·</span> the AI recommends; only a maintainer moves money.
      </p>
    </div>
  );
}
