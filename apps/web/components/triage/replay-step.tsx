"use client";

import type { CanaryHit, ReplayStep } from "@goodfaith/core";
import { ChevronDownIcon, SirenIcon } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const METHOD_TONE: Record<string, string> = {
  GET: "text-primary bg-accent",
  POST: "text-success-strong bg-success-soft",
  PUT: "text-warning-strong bg-warning-soft",
  PATCH: "text-warning-strong bg-warning-soft",
  DELETE: "text-danger-strong bg-danger-soft",
};

function statusTone(code: number) {
  if (code >= 500) return "text-danger-strong";
  if (code >= 400) return "text-warning-strong";
  if (code >= 200 && code < 300) return "text-success-strong";
  return "text-muted-foreground";
}

/** Pretty-prints JSON when it is JSON, and turns "[CANARY:id]" redactions into visible markers. */
export function Excerpt({ text, hits }: { text: string; hits?: CanaryHit[] }) {
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: show as is
  }
  const parts = pretty.split(/(\[CANARY:[a-z0-9_-]+\])/gi);
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap break-all">
      {parts.map((p, i) => {
        const m = /^\[CANARY:([a-z0-9_-]+)\]$/i.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const hit = hits?.find((h) => h.canaryId === m[1]);
        return (
          <mark key={i} className="rounded bg-danger-soft px-1 font-semibold text-danger-strong ring-1 ring-danger/40" title={hit ? `${hit.label} (owner: ${hit.owner})` : "Canary"}>
            {p}
          </mark>
        );
      })}
    </pre>
  );
}

export function ReplayStepRow({ step, hits, defaultOpen }: { step: ReplayStep; hits: CanaryHit[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? hits.length > 0);
  const leaked = hits.filter((h) => h.stepIndex === step.index);
  return (
    <div className={cn("rounded-lg ring-1 ring-foreground/10", leaked.length > 0 && "ring-danger/40")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm"
      >
        <span className="font-mono text-xs text-muted-foreground tabular">#{step.index + 1}</span>
        <span className={cn("rounded px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold", METHOD_TONE[step.request.method] ?? "bg-muted")}>{step.request.method}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">{step.request.path}</code>
        <span className="text-xs text-muted-foreground">
          as <span className="font-mono text-foreground">{step.request.as}</span>
        </span>
        <span className={cn("font-mono text-sm font-semibold tabular", statusTone(step.status))}>{step.status}</span>
        <span className="font-mono text-xs text-muted-foreground tabular">{formatDuration(step.durationMs)}</span>
        <ChevronDownIcon aria-hidden className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {leaked.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {leaked.map((h) => (
            <span key={h.canaryId} className="inline-flex items-center gap-1.5 rounded-md bg-danger-soft px-2 py-1 text-xs font-medium text-danger-strong">
              <SirenIcon className="size-3.5" aria-hidden />
              Canary hit: {h.label} reached <span className="font-mono">{step.request.as}</span>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="px-3 pb-3">
          <Excerpt text={step.bodyExcerpt || "(empty body)"} hits={hits} />
        </div>
      )}
    </div>
  );
}
