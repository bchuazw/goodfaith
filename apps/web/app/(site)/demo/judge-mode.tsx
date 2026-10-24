"use client";

import type { Severity } from "@goodfaith/core";
import { ArrowRightIcon, FlaskConicalIcon, LoaderCircleIcon, PlayIcon, RotateCcwIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SettlePanel } from "@/components/console/settle-panel";
import { DepositCard, PayoutCard } from "@/components/report/money-cards";
import { VERDICT_META, VerdictBadge } from "@/components/status";
import { TriageTimeline } from "@/components/triage/timeline";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/client/api";
import { useReportStream } from "@/lib/client/use-report-stream";
import { HERO_REPORTS, type HeroKey } from "@/lib/hero-reports";
import { formatMoney, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ReportView, StreamTriageEvent } from "@/lib/view-types";

type Run = { view: ReportView; events: StreamTriageEvent[] };
type Mode = { app: "mock" | "live"; paypal: "mock" | "sandbox" | "live"; vault: boolean; model: string };

const ORDER: HeroKey[] = ["slop", "idor", "duplicate"];
const SETTLE_LABEL = { capture: "capture the deposit", pay: "pay the bounty", release: "release the deposit" } as const;

const newRound = () => `round-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function JudgeMode({ runs, round: initialRound, bounties, deposit, mode }: { runs: Partial<Record<HeroKey, Run>>; round?: string; bounties: Record<Severity, Money>; deposit: Money; mode: Mode }) {
  const router = useRouter();
  const [state, setState] = useState(runs);
  // Reports in one round dedupe only against each other, so every round can replay the same story.
  const [round, setRound] = useState(() => initialRound ?? newRound());
  const [busy, setBusy] = useState<string>();
  const idorReproduced = state.idor?.view.verdict?.verdict === "REPRODUCED";

  const run = async (key: HeroKey) => {
    setBusy(key);
    try {
      const { reportId } = await api<{ reportId: string }>("/api/demo", { body: { action: "run", scenario: key, round } });
      const view = await api<ReportView>(`/api/reports/${reportId}?view=maintainer`);
      setState((s) => ({ ...s, [key]: { view, events: [] } }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      await api("/api/demo", { body: { action: "reset" } });
      setState({});
      router.refresh();
      toast.success("Mock data cleared");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const fund = async () => {
    setBusy("fund");
    try {
      await api("/api/demo", { body: { action: "fund", amount: "1000" } });
      toast.success("A simulated sponsor funded the pool with $1,000.00");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <header className="space-y-4">
        <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">Judge mode</p>
        <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Three bounty claims. Watch each one settle.</h1>
        <p className="max-w-2xl text-muted-foreground">
          Each run submits a real bounty claim against Lantern 1.4.0, posts its {formatMoney(deposit)} deposit, and streams the triage. Then you settle it as the
          maintainer. The buttons call the same API the product uses: nothing on this page is staged.
        </p>
        <ModeNote mode={mode} />
      </header>

      <ol className="mt-10 space-y-6">
        {ORDER.map((key, i) => {
          const hero = HERO_REPORTS[key];
          const current = state[key];
          const locked = key === "duplicate" && !idorReproduced;
          return (
            <li key={key} className="rounded-2xl bg-card ring-1 ring-foreground/10">
              <div className="flex flex-wrap items-start gap-4 p-5 sm:p-6">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-sm font-semibold text-primary-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold tracking-tight">{hero.label}</h2>
                    <span className="text-xs text-muted-foreground">
                      expect <span className="font-medium text-foreground">{VERDICT_META[hero.expected.verdict].label}</span>, then {SETTLE_LABEL[hero.expected.settle]}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">&ldquo;{hero.title}&rdquo;</span> by @{hero.handle}
                  </p>
                </div>
                <Button onClick={() => run(key)} disabled={!!busy || locked} variant={current ? "outline" : "default"} className="gap-2">
                  {busy === key ? <LoaderCircleIcon className="animate-spin" /> : current ? <RotateCcwIcon /> : <PlayIcon />}
                  {current ? "Submit again" : "Submit and post the deposit"}
                </Button>
              </div>
              {locked && !current && <p className="px-5 pb-5 text-sm text-muted-foreground sm:px-6">Unlocks once the real IDOR (run 2) has reproduced: a duplicate needs an original to match.</p>}
              {current && <ScenarioRun key={current.view.id} run={current} bounties={bounties} expected={hero.expected.settle} onView={(view) => setState((s) => ({ ...s, [key]: { ...(s[key] as Run), view } }))} />}
            </li>
          );
        })}
      </ol>

      <footer className="mt-10 flex flex-wrap items-center gap-3 border-t pt-6">
        <Button
          variant="outline"
          onClick={() => {
            setRound(newRound());
            setState({});
          }}
          disabled={!!busy || Object.keys(state).length === 0}
        >
          <RotateCcwIcon /> Start a new round
        </Button>
        <Button asChild variant="outline">
          <Link href="/console">
            Open the maintainer console <ArrowRightIcon />
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/p/lantern#transparency">Transparency numbers</Link>
        </Button>
        {mode.app === "mock" && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={fund} disabled={!!busy}>
              {busy === "fund" && <LoaderCircleIcon className="animate-spin" />}Fund the pool (mock sponsor)
            </Button>
            <Button variant="ghost" onClick={reset} disabled={!!busy}>
              {busy === "reset" && <LoaderCircleIcon className="animate-spin" />}Reset mock data
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

function ModeNote({ mode }: { mode: Mode }) {
  if (mode.paypal === "mock") {
    return (
      <div className="flex gap-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-strong ring-1 ring-warning/30">
        <FlaskConicalIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          <strong className="font-semibold">MOCK.</strong> PayPal is an in-memory simulator with PayPal-shaped ids and webhooks, and the researcher&apos;s approval is
          simulated. Triage is the real engine with the scripted (zero-key) model. Set GOODFAITH_MODE=live for the PayPal sandbox and Claude.
        </p>
      </div>
    );
  }
  return (
    <div className="flex gap-3 rounded-xl bg-accent p-4 text-sm text-accent-foreground ring-1 ring-primary/20">
      <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong className="font-semibold">PayPal {mode.paypal}.</strong>{" "}
        {mode.vault
          ? "Deposits are real sandbox authorization holds on the demo researcher's saved sandbox wallet, so no login is needed. Payouts land in that account's sandbox inbox."
          : "Deposits need a PayPal sandbox login: use the button on each report's page."}{" "}
        Triage runs on <span className="font-mono">{mode.model}</span>. The report form uses the PayPal JS SDK v6 button.
      </p>
    </div>
  );
}

function ScenarioRun({ run, bounties, expected, onView }: { run: Run; bounties: Record<Severity, Money>; expected: "capture" | "pay" | "release"; onView: (v: ReportView) => void }) {
  const { view, events, setView } = useReportStream(run.view, run.events);
  const running = view.status === "queued" || view.status === "triaging" || view.status === "awaiting_deposit";
  const triaged = !!view.verdict;
  const update = (v: ReportView) => {
    setView(v);
    onView(v);
  };
  return (
    <div className="grid gap-6 border-t p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <VerdictBadge verdict={view.verdict?.verdict} pending={running} />
          <Link href={`/console/r/${view.id}`} className="font-mono text-xs text-muted-foreground hover:text-foreground">
            {view.id}
          </Link>
          <Link href={`/r/${view.id}`} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            Researcher view
          </Link>
          <Link href={`/console/r/${view.id}`} className="text-xs text-muted-foreground hover:text-foreground">
            Full evidence
          </Link>
        </div>
        <TriageTimeline events={events} running={view.status === "queued" || view.status === "triaging"} compact failed={view.status === "triage_failed" ? view.triage?.error : undefined} />
      </div>
      <div className="space-y-4">
        <div className={cn("space-y-3 rounded-xl p-4 ring-1 ring-foreground/10", triaged && !view.settlement && "ring-2 ring-primary/50")}>
          <p className="text-sm font-medium">
            {view.settlement?.status === "done" ? "Settled" : triaged ? `Your move: ${SETTLE_LABEL[expected]}` : "Waiting for triage"}
          </p>
          <SettlePanel view={view} bounties={bounties} onUpdated={update} />
        </div>
        <DepositCard deposit={view.deposit} report={view} />
        {view.payout && <PayoutCard payout={view.payout} />}
      </div>
    </div>
  );
}
