import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BanknoteIcon,
  CopyCheckIcon,
  GavelIcon,
  HandCoinsIcon,
  LockIcon,
  LockOpenIcon,
  ScanSearchIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SirenIcon,
} from "lucide-react";
import Link from "next/link";
import { SealMark } from "@/components/brand";
import { TransparencyTiles } from "@/components/program/transparency";
import { SOURCES } from "@/components/site-chrome";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { servicesOrError } from "@/lib/server/page";
import { transparencyStats } from "@/lib/server/stats";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { svc } = servicesOrError();
  const stats = svc ? await transparencyStats(svc) : undefined;
  const deposit = svc ? formatMoney(svc.program.deposit) : "$20.00";
  const high = svc ? formatMoney(svc.program.bounties.high) : "$500.00";

  return (
    <>
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="absolute inset-0 bg-grid opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:pt-24">
          <div className="space-y-7">
            <p className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1 text-xs font-medium text-muted-foreground ring-1 ring-foreground/10">
              <SealMark className="size-4" /> Open-source bug bounties for the AI era
            </p>
            <h1 className="font-display text-5xl leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
              AI slop killed open-source bug bounties. <em className="text-primary">Good Faith</em> brings them back.
            </h1>
            <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
              Free reports stay free. Claiming a bounty takes a refundable {deposit} PayPal hold. Claude reproduces the report against a sandboxed copy of the project
              before anyone pays: real finds are paid in minutes, and fabricated ones pay for the maintainers&apos; time.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-11 px-4 text-[0.95rem]">
                <Link href="/demo">
                  Watch three claims settle <ArrowRightIcon />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 px-4 text-[0.95rem]">
                <Link href="/p/lantern/report">Report a bug in Lantern</Link>
              </Button>
            </div>
          </div>
          <SettlementDiagram deposit={deposit} high={high} />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mb-10 max-w-2xl space-y-3">
          <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">What broke</p>
          <h2 className="font-display text-4xl tracking-tight">Two of open source&apos;s best-known bounties stopped in 2026.</h2>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <Citation
            date={SOURCES.curl.date}
            title="curl ended its bug bounty"
            quote="Remove the incentive for people to submit crap and non-well researched reports to us. AI generated or not."
            who="Daniel Stenberg, curl maintainer"
            href={SOURCES.curl.href}
            source={`${SOURCES.curl.outlet}: “${SOURCES.curl.headline}”`}
          />
          <Citation
            date={SOURCES.ibb.date}
            title="The Internet Bug Bounty paused new submissions"
            quote="The balance between findings and remediation capacity in open source has substantively shifted."
            who="HackerOne, which runs the IBB"
            href={SOURCES.ibb.href}
            source={`${SOURCES.ibb.outlet}: “${SOURCES.ibb.headline}”`}
          />
        </div>
        <p className="mt-8 max-w-3xl text-lg leading-relaxed">
          AI-assisted research finds real bugs too. What broke bounties is the cost of <em className="font-display text-xl">claims nobody can verify</em>. Good Faith makes
          every claim checkable, and every fabricated one costly.
        </p>
      </section>

      <section className="border-y bg-surface-raised/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mb-12 max-w-2xl space-y-3">
            <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">How it works</p>
            <h2 className="font-display text-4xl tracking-tight">Proof first, then money. And only a person moves the money.</h2>
          </div>
          <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            <Step n={1} icon={ScrollTextIcon} title="Report, or claim a bounty">
              Anyone can report for free. A bounty claim posts a {deposit} authorization hold with PayPal: a hold, never a charge, unless a human confirms slop.
            </Step>
            <Step n={2} icon={ScanSearchIcon} title="Claude triages, as untrusted data">
              It checks every cited file and function exists at the claimed version, dedupes against verified reports, and flags instructions aimed at itself.
            </Step>
            <Step n={3} icon={SirenIcon} title="The PoC runs in a sandbox">
              A fresh, network-isolated Lantern seeded with canary secrets. A canary reaching the wrong account is proof, not an opinion.
            </Step>
            <Step n={4} icon={GavelIcon} title="A maintainer settles">
              Pay (the hold is voided, the bounty sent with PayPal Payouts), release, or capture. Each deposit resolves exactly once.
            </Step>
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl space-y-3">
            <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">Live from the Lantern program</p>
            <h2 className="font-display text-4xl tracking-tight">Every report, verdict and dollar, counted.</h2>
          </div>
          <Button asChild variant="outline">
            <Link href="/p/lantern#transparency">
              Transparency page <ArrowRightIcon />
            </Link>
          </Button>
        </div>
        {stats ? <TransparencyTiles stats={stats} /> : <p className="text-sm text-muted-foreground">Unavailable until the app is configured.</p>}
      </section>

      <section className="border-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.3fr]">
          <div className="space-y-3">
            <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">Built on PayPal</p>
            <h2 className="font-display text-4xl tracking-tight">Each step is a PayPal primitive, used for what it is good at.</h2>
            <p className="text-muted-foreground">Idempotent by construction: every money call carries a fixed PayPal-Request-Id, and the payout&apos;s sender batch id is the report id.</p>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            {[
              { api: "Orders v2 · AUTHORIZE", use: "The bounty-claim deposit: a hold the researcher approves." },
              { api: "JS SDK v6", use: "The PayPal button, with a browser-safe client token." },
              { api: "Payments v2 · void", use: "Release: honest reports get every cent back." },
              { api: "Payments v2 · capture", use: "Slop: the hold becomes the maintainers' fund." },
              { api: "Payouts", use: "The bounty, paid once per report id." },
              { api: "Orders v2 · CAPTURE", use: "Sponsors fund the bounty pool." },
              { api: "Webhooks, verified", use: "Holds, voids, captures and payouts reconcile." },
              { api: "Claude", use: "Triage with tools; deterministic policy decides." },
            ].map((row) => (
              <div key={row.api} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <dt className="font-mono text-xs font-medium text-primary">{row.api}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">{row.use}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-ink px-6 py-12 text-ink-foreground sm:px-12">
          <div aria-hidden className="absolute inset-0 bg-grid opacity-20 [mask-image:radial-gradient(ellipse_at_bottom_right,black,transparent_70%)]" />
          <div className="relative flex flex-wrap items-center justify-between gap-6">
            <p className="max-w-2xl font-display text-3xl leading-tight sm:text-4xl">Free reports stay free. Good-faith research gets paid. Slop pays for itself.</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="lg" className="h-11 bg-ink-foreground text-ink hover:bg-ink-foreground/90">
                <Link href="/demo">Open judge mode</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 border-white/25 bg-transparent text-ink-foreground hover:bg-white/10 hover:text-ink-foreground">
                <Link href="/console">Maintainer console</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Citation({ date, title, quote, who, href, source }: { date: string; title: string; quote: string; who: string; href: string; source: string }) {
  return (
    <figure className="flex flex-col justify-between gap-6 rounded-2xl bg-card p-6 ring-1 ring-foreground/10">
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="font-mono">{date}</span>
          <span aria-hidden>·</span>
          {title}
        </p>
        <blockquote className="font-display text-2xl leading-snug">&ldquo;{quote}&rdquo;</blockquote>
      </div>
      <figcaption className="space-y-1 text-sm">
        <p className="font-medium">{who}</p>
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {source}
          <ArrowUpRightIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        </a>
      </figcaption>
    </figure>
  );
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: typeof LockIcon; title: string; children: React.ReactNode }) {
  return (
    <li className="space-y-3 rounded-2xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between">
        <Icon className="size-5 text-primary" aria-hidden />
        <span className="font-mono text-xs text-muted-foreground">0{n}</span>
      </div>
      <h3 className="font-medium">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

/** How one bounty claim can settle. An explanatory diagram (no live data). */
function SettlementDiagram({ deposit, high }: { deposit: string; high: string }) {
  const outcomes = [
    { icon: ShieldCheckIcon, verdict: "Reproduced", tone: "text-success-strong", money: `Hold voided · ${high} paid`, moneyIcon: BanknoteIcon },
    { icon: CopyCheckIcon, verdict: "Duplicate", tone: "text-primary", money: "Hold voided · nothing charged", moneyIcon: LockOpenIcon },
    { icon: ShieldXIcon, verdict: "Slop", tone: "text-danger-strong", money: `${deposit} captured, after review`, moneyIcon: HandCoinsIcon },
  ];
  return (
    <figure aria-label="How a bounty claim settles" className="relative mx-auto w-full max-w-md">
      <div className="rounded-2xl bg-card p-5 shadow-lift ring-1 ring-foreground/10">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent">
            <LockIcon className="size-4 text-primary" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Bounty claim</p>
            <p className="text-xs text-muted-foreground">{deposit} PayPal authorization hold</p>
          </div>
          <span className="ml-auto rounded-full bg-accent px-2 py-0.5 font-mono text-[0.65rem] text-accent-foreground">AUTHORIZE</span>
        </div>
        <div className="my-4 ml-[18px] h-6 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
          <ScanSearchIcon className="size-4 text-primary" aria-hidden />
          <p className="text-xs leading-relaxed text-muted-foreground">Claims · version · cited code · duplicates · sandbox replay · verdict</p>
        </div>
        <div className="mt-4 space-y-2">
          {outcomes.map((o, i) => (
            <div key={o.verdict} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-foreground/10 animate-rise-in")} style={{ animationDelay: `${300 + i * 140}ms` }}>
              <o.icon className={cn("size-4 shrink-0", o.tone)} aria-hidden />
              <span className={cn("w-24 shrink-0 text-sm font-medium", o.tone)}>{o.verdict}</span>
              <o.moneyIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">{o.money}</span>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">How a claim settles. A maintainer approves every outcome.</figcaption>
    </figure>
  );
}
