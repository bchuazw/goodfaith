"use client";

import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { injectionQuotes } from "@/components/triage/finding-row";
import { FindingIcon } from "@/components/status";
import { PocTable, ReportBody } from "@/components/report/report-body";
import { ReplayStepRow } from "@/components/triage/replay-step";
import { TriageTimeline } from "@/components/triage/timeline";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CodeEvidence, LedgerLine, ReportView, StreamTriageEvent } from "@/lib/view-types";

export function EvidenceTabs({ view, events, running }: { view: ReportView; events: StreamTriageEvent[]; running: boolean }) {
  const v = view.verdict;
  const injections = v?.findings.filter((f) => f.kind === "injection") ?? [];
  const hiddenComments = /<!--[\s\S]*?-->/.test(view.body);
  return (
    <Tabs defaultValue="timeline" className="gap-4">
      <div className="-mx-1 overflow-x-auto px-1">
        <TabsList variant="line" className="w-max">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="code">Code references{view.codeEvidence?.length ? ` · ${view.codeEvidence.length}` : ""}</TabsTrigger>
          <TabsTrigger value="replay">Replay{v?.replay ? ` · ${v.replay.steps.length}` : ""}</TabsTrigger>
          <TabsTrigger value="injection">Injection{injections.length ? " · found" : ""}</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="paypal">PayPal trail{view.ledger?.length ? ` · ${view.ledger.length}` : ""}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="timeline">
        <TriageTimeline events={events} running={running} failed={view.status === "triage_failed" ? view.triage?.error : undefined} />
      </TabsContent>

      <TabsContent value="code" className="space-y-3">
        {!view.codeEvidence?.length ? (
          <Empty>{v ? "The report cites no specific file or function." : "Available once triage has run."}</Empty>
        ) : (
          view.codeEvidence.map((c, i) => <CodeRef key={i} c={c} />)
        )}
      </TabsContent>

      <TabsContent value="replay" className="space-y-3">
        {!v?.replay ? (
          <Empty>{v ? (v.findings.find((f) => f.kind === "poc")?.title ?? "Nothing was replayed.") : "Available once triage has run."}</Empty>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              A fresh Lantern <span className="font-mono text-foreground">{v.replay.version}</span> with canaries seeded for this run only. No sockets, no network.
            </p>
            {v.replay.steps.map((s) => (
              <ReplayStepRow key={s.index} step={s} hits={v.replay?.canaryHits ?? []} defaultOpen />
            ))}
            {v.replay.canaryHits.length === 0 && <p className="text-sm text-muted-foreground">No canary reached an account that was not entitled to it.</p>}
            {v.replay.error && <p className="text-sm text-warning-strong">Replay stopped: {v.replay.error}</p>}
          </>
        )}
      </TabsContent>

      <TabsContent value="injection" className="space-y-3">
        {injections.length === 0 && !hiddenComments ? (
          <Empty>No instructions aimed at the AI triager were found.</Empty>
        ) : (
          <>
            {injections.map((f, i) => (
              <div key={i} className="space-y-2 rounded-xl bg-danger-soft/60 p-4 ring-1 ring-danger/30">
                <p className="text-sm font-medium text-danger-strong">{f.title}</p>
                <p className="text-sm text-muted-foreground">{f.detail}</p>
                {injectionQuotes(f).map((q) => (
                  <blockquote key={q} className="rounded-md bg-background/70 px-3 py-2 font-mono text-xs text-danger-strong">
                    {q}
                  </blockquote>
                ))}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">The report is passed to Claude as quarantined, untrusted data. An instruction inside it is evidence against the report, never a command.</p>
          </>
        )}
      </TabsContent>

      <TabsContent value="report" className="space-y-4">
        <ReportBody body={view.body} />
        {view.poc && <PocTable poc={view.poc} />}
      </TabsContent>

      <TabsContent value="paypal">
        {!view.ledger?.length ? <Empty>No PayPal calls yet.</Empty> : <Ledger lines={view.ledger} />}
      </TabsContent>
    </Tabs>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function CodeRef({ c }: { c: CodeEvidence }) {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <FindingIcon status={c.status} />
        <p className="min-w-0 flex-1 text-sm font-medium">{c.title}</p>
        {c.path && (
          <code className="font-mono text-xs text-muted-foreground">
            {c.path}
            {c.line ? `:${c.line}` : ""}
            {c.version ? ` @ ${c.version}` : ""}
          </code>
        )}
      </div>
      <p className="px-3.5 pb-2.5 text-xs text-muted-foreground">{c.detail}</p>
      {c.snippet && (
        <pre className="overflow-x-auto border-t bg-muted/40 py-2 font-mono text-[0.72rem] leading-relaxed">
          {c.snippet.lines.map((l, i) => {
            const n = c.snippet!.startLine + i;
            const hl = n === c.snippet!.highlight;
            return (
              <div key={n} className={cn("flex px-3", hl && "bg-accent")}>
                <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground/70 tabular select-none">{n}</span>
                <span className={cn("whitespace-pre", hl && "font-semibold")}>{l || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

function Ledger({ lines }: { lines: LedgerLine[] }) {
  return (
    <ol className="space-y-2">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-3 rounded-lg px-3 py-2 ring-1 ring-foreground/10">
          {l.ok ? <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-label="OK" /> : <CircleXIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <code className="font-mono text-xs font-medium">{l.op}</code>
              <span className="text-sm">{l.summary}</span>
              <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground tabular">{formatClock(l.at)}</span>
            </div>
            {(l.ids || l.status) && (
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.7rem] text-muted-foreground">
                {Object.entries(l.ids ?? {}).map(([k, v]) => (
                  <span key={k}>
                    {k} <span className="text-foreground">{v}</span>
                  </span>
                ))}
                {l.status && (
                  <span>
                    status <span className="text-foreground">{l.status}</span>
                  </span>
                )}
              </p>
            )}
            {l.error && (
              <p className="font-mono text-[0.7rem] text-danger-strong">
                {l.error.name}
                {l.error.issue ? ` / ${l.error.issue}` : ""}
                {l.error.debugId ? ` · debug id ${l.error.debugId}` : ""}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
