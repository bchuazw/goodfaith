"use client";

import type { Severity } from "@goodfaith/core";
import { ArrowLeftIcon, ExternalLinkIcon, RadioIcon } from "lucide-react";
import Link from "next/link";
import { SettlePanel } from "@/components/console/settle-panel";
import { EvidenceTabs } from "@/components/console/evidence";
import { IdChip } from "@/components/id-chip";
import { DepositCard, PayoutCard } from "@/components/report/money-cards";
import { ReportStatusBadge, SeverityLabel, VERDICT_META, VerdictBadge } from "@/components/status";
import { DegradedNotice, recommendationHeading } from "@/components/triage/ai-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useReportStream } from "@/lib/client/use-report-stream";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { Money } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ReportView, StreamTriageEvent } from "@/lib/view-types";

export function ConsoleReport({ initial, initialEvents, bounties }: { initial: ReportView; initialEvents: StreamTriageEvent[]; bounties: Record<Severity, Money> }) {
  const { view, events, live, setView } = useReportStream(initial, initialEvents);
  const v = view.verdict;
  const running = view.status === "queued" || view.status === "triaging";
  const triageMs = v && view.queuedAt ? Date.parse(v.finishedAt) - Date.parse(view.queuedAt) : undefined;
  const meta = v ? VERDICT_META[v.verdict] : undefined;

  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6">
      <Link href="/console" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" aria-hidden /> Queue
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={v?.verdict} pending={running} size="md" />
          <ReportStatusBadge status={view.status} size="md" />
          <span className="text-sm text-muted-foreground">{view.kind === "bounty" ? "Bounty claim" : "Free report"}</span>
          {live && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <RadioIcon className="size-3.5 animate-pulse text-primary" aria-hidden /> live
            </span>
          )}
        </div>
        <h1 className="max-w-4xl font-display text-3xl leading-tight tracking-tight sm:text-4xl">{view.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          <IdChip value={view.id} label="Report" />
          <span>
            @{view.reporter.handle}
            {view.reporter.trusted && " (trusted)"}
          </span>
          <span>{formatDateTime(view.submittedAt)}</span>
          {view.claimedVersion && <span className="font-mono">Lantern {view.claimedVersion}</span>}
          <Link href={`/r/${view.id}`} className="inline-flex items-center gap-1 hover:text-foreground">
            Researcher view <ExternalLinkIcon className="size-3.5" aria-hidden />
          </Link>
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-6">
          {v && meta && (
            <Card className={cn("ring-1", { success: "ring-success/35", info: "ring-primary/30", warning: "ring-warning/40", danger: "ring-danger/35", neutral: "", seal: "" }[meta.tone])}>
              <CardHeader className="gap-2">
                <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                  <meta.icon className="size-5" aria-hidden />
                  {recommendationHeading(v.model)}: {meta.label}
                  <span className="font-mono text-xs font-normal text-muted-foreground tabular">confidence {(v.confidence * 100).toFixed(0)}%</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="max-w-prose text-sm leading-relaxed">{v.summary}</p>
                <DegradedNotice verdict={v} />
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Suggested severity</dt>
                    <dd className="mt-0.5">
                      <SeverityLabel level={v.suggestedSeverity?.level} />
                      {v.suggestedSeverity?.cvss && <p className="mt-0.5 font-mono text-[0.7rem] break-all text-muted-foreground">{v.suggestedSeverity.cvss}</p>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Claimed severity</dt>
                    <dd className="mt-0.5">
                      <SeverityLabel level={view.claimedSeverity} muted />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Vulnerability class</dt>
                    <dd className="mt-0.5">{v.claims.vulnClass ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Triage</dt>
                    <dd className="mt-0.5">
                      {formatDuration(triageMs)} · <span className="font-mono text-xs">{v.model.model}</span> ({v.model.mode})
                    </dd>
                  </div>
                </dl>
                {v.slopSignals.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Slop signals</p>
                    <ul className="space-y-1 text-sm">
                      {v.slopSignals.map((s) => (
                        <li key={s} className="flex gap-2">
                          <span aria-hidden className="text-danger">•</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {v.duplicateOf && (
                  <p className="text-sm">
                    Duplicate of{" "}
                    <Link href={`/console/r/${v.duplicateOf}`} className="font-mono text-primary underline underline-offset-4">
                      {v.duplicateOf}
                    </Link>
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-1">
              <EvidenceTabs view={view} events={events} running={running} />
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Decision</CardTitle>
            </CardHeader>
            <CardContent>
              <SettlePanel view={view} bounties={bounties} onUpdated={setView} />
            </CardContent>
          </Card>
          <DepositCard deposit={view.deposit} report={view} />
          {view.payout && <PayoutCard payout={view.payout} />}
        </aside>
      </div>
    </div>
  );
}
