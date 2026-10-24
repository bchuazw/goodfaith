"use client";

import { HandshakeIcon, RadioIcon, ScrollTextIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { IdChip } from "@/components/id-chip";
import { PayPalCheckout } from "@/components/paypal/paypal-checkout";
import { DepositCard, PayoutCard } from "@/components/report/money-cards";
import { NextStep } from "@/components/report/next-step";
import { PocTable, ReportBody } from "@/components/report/report-body";
import { ReportStatusBadge, StatusPill, VerdictBadge } from "@/components/status";
import { TriageTimeline } from "@/components/triage/timeline";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/client/api";
import { useReportStream } from "@/lib/client/use-report-stream";
import { formatDateTime, formatDuration } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { ReportView, StreamTriageEvent } from "@/lib/view-types";

export function ReportStatus({ initial, initialEvents, paypalMode }: { initial: ReportView; initialEvents: StreamTriageEvent[]; paypalMode: "mock" | "sandbox" | "live" }) {
  const { view, events, live, refresh, setView } = useReportStream(initial, initialEvents);
  const search = useSearchParams();
  const router = useRouter();
  const handledReturn = useRef(false);
  const running = view.status === "queued" || view.status === "triaging" || view.status === "awaiting_deposit";

  // PayPal's redirect flow (a popup blocker can force it) comes back here with ?token=<order id>.
  useEffect(() => {
    if (handledReturn.current) return;
    const outcome = search.get("deposit");
    const token = search.get("token");
    if (!outcome) return;
    handledReturn.current = true;
    if (outcome === "approved" && token && view.status === "awaiting_deposit") {
      api<ReportView>(`/api/reports/${view.id}/deposit/approve`, { body: { orderId: token } })
        .then((v) => {
          setView(v);
          toast.success("Deposit held. Triage has started.");
        })
        .catch((e) => toast.error(errorMessage(e)));
    } else if (outcome === "cancelled") {
      toast.info("Deposit not posted. Your report is saved; post the deposit whenever you are ready.");
    }
    router.replace(`/r/${view.id}`, { scroll: false });
  }, [search, router, view.id, view.status, setView]);

  const triageMs = view.verdict && view.queuedAt ? Date.parse(view.verdict.finishedAt) - Date.parse(view.queuedAt) : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
        <Link href="/p/lantern" className="hover:text-foreground">
          Lantern
        </Link>
        <span aria-hidden className="px-1.5">/</span>
        <span>Report</span>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={view.kind === "bounty" ? "seal" : "neutral"} icon={view.kind === "bounty" ? HandshakeIcon : ScrollTextIcon}>
            {view.kind === "bounty" ? "Bounty claim" : "Free report"}
          </StatusPill>
          <ReportStatusBadge status={view.status} />
          {(view.verdict || running) && view.status !== "awaiting_deposit" && <VerdictBadge verdict={view.verdict?.verdict} pending={running} />}
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
            by <span className="font-medium text-foreground">@{view.reporter.handle}</span>
            {view.reporter.trusted && <span className="ml-1 text-xs">(trusted)</span>}
          </span>
          <span>{formatDateTime(view.submittedAt)}</span>
          {view.claimedVersion && (
            <span>
              Lantern <span className="font-mono text-foreground">{view.claimedVersion}</span>
            </span>
          )}
          {view.claimedSeverity && (
            <span>
              claimed <span className="text-foreground capitalize">{view.claimedSeverity}</span>
            </span>
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {view.status === "awaiting_deposit" && view.kind === "bounty" && (
            <Card className="ring-seal/40">
              <CardHeader>
                <CardTitle className="text-lg">Post the refundable {view.deposit ? formatMoney(view.deposit.amount) : "$20.00"} deposit</CardTitle>
                <CardDescription>
                  PayPal places an authorization hold, not a charge. Triage starts the moment it is held. Honest reports, duplicates included, get every cent back; only
                  a report a maintainer confirms as fabricated loses it.
                </CardDescription>
              </CardHeader>
              <CardContent className="max-w-sm">
                <PayPalCheckout
                  paypalMode={paypalMode}
                  createOrder={() => api<{ orderId: string; approveUrl?: string }>(`/api/reports/${view.id}/deposit`, { body: {} })}
                  onApproved={async (orderId) => {
                    const v = await api<ReportView>(`/api/reports/${view.id}/deposit/approve`, { body: { orderId } });
                    setView(v);
                    toast.success("Deposit held. Triage has started.");
                    await refresh();
                  }}
                  onCancelled={() => toast.info("Deposit not posted. Your report is saved.")}
                  onFailed={(m) => toast.error(m)}
                  mockLabel="Post the deposit with PayPal"
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b">
              <div>
                <CardTitle className="text-base">Triage</CardTitle>
                <CardDescription>
                  {view.status === "awaiting_deposit"
                    ? "Starts when the deposit is held."
                    : view.verdict
                      ? `Finished in ${formatDuration(triageMs)}.`
                      : "Every step streams here as it happens."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <TriageTimeline events={events} running={view.status === "queued" || view.status === "triaging"} failed={view.status === "triage_failed" ? view.triage?.error : undefined} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-base">Your report</CardTitle>
              <CardDescription>Shown exactly as submitted. Triage reads it as untrusted data.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <ReportBody body={view.body} />
              {view.poc && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Structured PoC</h4>
                  <PocTable poc={view.poc} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card size="sm">
            <CardHeader>
              <CardTitle>What happens next</CardTitle>
            </CardHeader>
            <CardContent>
              <NextStep view={view} />
            </CardContent>
          </Card>
          <DepositCard deposit={view.deposit} report={view} />
          {view.payout && <PayoutCard payout={view.payout} />}
        </aside>
      </div>
    </div>
  );
}
