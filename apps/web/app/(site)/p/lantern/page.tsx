import type { Severity } from "@goodfaith/core";
import { ArrowRightIcon, GitBranchIcon, LockIcon, LockOpenIcon, HandCoinsIcon, PiggyBankIcon, ShieldCheckIcon, UsersRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Money } from "@/components/money";
import { SponsorFund } from "@/components/program/sponsor-fund";
import { HallOfFame, TransparencyTiles } from "@/components/program/transparency";
import { TransparencyCharts } from "@/components/program/transparency-charts";
import { SeverityLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { servicesOrError } from "@/lib/server/page";
import { transparencyStats } from "@/lib/server/stats";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lantern bug bounty" };

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const EXAMPLES: Record<Severity, string> = {
  critical: "Server secrets or code execution",
  high: "Read or modify other users' data",
  medium: "Limited exposure, needs conditions",
  low: "Hardening, minor information leaks",
};

export default async function ProgramPage() {
  const { svc, error } = servicesOrError();
  if (!svc) return <p className="mx-auto max-w-6xl px-4 py-16 text-danger-strong">{error}</p>;
  const p = svc.program;
  const stats = await transparencyStats(svc);
  const deposit = formatMoney(p.deposit);

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6">
      <header className="relative overflow-hidden rounded-3xl bg-ink px-6 py-10 text-ink-foreground sm:px-10 sm:py-12">
        <div aria-hidden className="absolute inset-0 bg-grid opacity-25 [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl space-y-4">
            <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
              <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden /> Accepting reports
            </p>
            <h1 className="font-display text-5xl tracking-tight sm:text-6xl">{p.name}</h1>
            <p className="text-lg text-ink-foreground/80">{p.tagline} A bug-bounty program run on Good Faith.</p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-foreground/75">
              <span className="inline-flex items-center gap-1.5">
                <GitBranchIcon className="size-4" aria-hidden />
                <span className="font-mono">{p.repo}</span>
              </span>
              <span>
                In scope:{" "}
                {p.versionsInScope.map((v) => (
                  <span key={v} className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-ink-foreground">
                    {v}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="lg" className="h-10 bg-ink-foreground text-ink hover:bg-ink-foreground/90">
              <Link href="/p/lantern/report">
                Report a vulnerability <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-10 border-white/25 bg-transparent text-ink-foreground hover:bg-white/10 hover:text-ink-foreground">
              <a href="#fund">Fund the pool</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Bounties</CardTitle>
            <CardDescription>Paid with PayPal Payouts once a maintainer approves a reproduced report.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {SEVERITIES.map((s) => (
                  <tr key={s} className="border-t first:border-t-0">
                    <td className="py-2.5 pr-2">
                      <SeverityLabel level={s} />
                      <p className="text-xs text-muted-foreground">{EXAMPLES[s]}</p>
                    </td>
                    <td className="py-2.5 text-right align-top">
                      <Money value={p.bounties[s]} className="text-base font-medium" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>The deposit</CardTitle>
            <CardDescription>Free reports need none. A bounty claim posts a refundable {deposit} PayPal hold.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              <li className="flex gap-2.5">
                <LockIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>An authorization hold, not a charge. Triage is promised within PayPal&apos;s 3-day honor period.</span>
              </li>
              <li className="flex gap-2.5">
                <LockOpenIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                <span>Released in full for every honest report: reproduced, duplicate, or out of scope.</span>
              </li>
              <li className="flex gap-2.5">
                <HandCoinsIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                <span>Captured only when triage finds hard evidence of fabrication and a maintainer confirms. It funds the maintainers&apos; time.</span>
              </li>
              <li className="flex gap-2.5">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-seal-strong" aria-hidden />
                <span>After {p.trustAfterVerified} verified reports, a researcher claims bounties with no deposit.</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sandbox test accounts</CardTitle>
            <CardDescription>PoCs run as these seeded users against a fresh, network-isolated Lantern.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {p.accounts.map((a) => (
                <li key={a.id} className="flex gap-2.5">
                  <UsersRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="font-mono font-medium">{a.id}</span>
                    <span className="block text-muted-foreground">{a.description.replace(/^[^—-]+[—-]\s*/, "")}</span>
                  </span>
                </li>
              ))}
              <li className="text-xs text-muted-foreground">Every replay seeds fresh canary secrets. One reaching an account not entitled to it is proof of impact.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <section id="fund" className="mt-6 grid scroll-mt-20 gap-6 lg:grid-cols-[1fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PiggyBankIcon className="size-4 text-muted-foreground" aria-hidden />
              Bounty pool
            </CardTitle>
            <CardDescription>Funded by sponsors through PayPal Checkout. Captured slop deposits are kept apart, for the maintainers.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-muted-foreground">Funded</dt>
                <dd className="mt-1 text-xl font-semibold">
                  <Money value={stats.pool.funded} />
                </dd>
                <dd className="text-xs text-muted-foreground">
                  {stats.pool.sponsors} sponsor{stats.pool.sponsors === 1 ? "" : "s"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Available</dt>
                <dd className="mt-1 text-xl font-semibold">
                  <Money value={stats.pool.available} />
                </dd>
                <dd className="text-xs text-muted-foreground">
                  <Money value={stats.pool.paid} /> paid, <Money value={stats.pool.committed} /> in flight
                </dd>
              </div>
              <div className="col-span-2 rounded-lg bg-muted/60 p-3">
                <dt className="text-xs text-muted-foreground">Maintainers&apos; fund (captured slop deposits)</dt>
                <dd className="mt-1 text-lg font-semibold">
                  <Money value={stats.pool.slopTax} />
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Sponsor Lantern&apos;s bounties</CardTitle>
            <CardDescription>A one-time contribution, captured immediately (Orders v2 CAPTURE).</CardDescription>
          </CardHeader>
          <CardContent>
            <SponsorFund paypalMode={svc.mode.paypal} />
          </CardContent>
        </Card>
      </section>

      <section id="transparency" className="mt-14 scroll-mt-20 space-y-5">
        <div className="space-y-1">
          <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">Transparency</p>
          <h2 className="font-display text-3xl tracking-tight">Every report, counted</h2>
          <p className="text-sm text-muted-foreground">Computed live from the program&apos;s records. Nothing here is seeded.</p>
        </div>
        <TransparencyTiles stats={stats} />
        <TransparencyCharts stats={stats} />
        <HallOfFame stats={stats} />
      </section>
    </div>
  );
}
