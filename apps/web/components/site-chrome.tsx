import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { ModeBadge } from "@/components/mode-badge";
import { DesktopNav, MobileNav } from "@/components/site-nav";
import { ThemeToggle } from "@/components/theme";
import type { ModeView } from "@/lib/view-types";

export function SiteHeader({ mode }: { mode?: ModeView }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="mr-2 rounded-md" aria-label="Good Faith home">
          <Wordmark />
        </Link>
        <DesktopNav />
        <div className="ml-auto flex items-center gap-1.5">
          {mode && <ModeBadge mode={mode} />}
          <ThemeToggle />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

export const SOURCES = {
  curl: {
    href: "https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/",
    outlet: "The Register",
    date: "21 Jan 2026",
    headline: "Curl shutters bug bounty program to remove incentive for submitting AI slop",
  },
  ibb: {
    href: "https://www.infoworld.com/article/4154210/internet-bug-bounty-program-hits--on-payouts.html",
    outlet: "InfoWorld",
    date: "3 Apr 2026",
    headline: "Internet Bug Bounty program hits pause on payouts",
  },
} as const;

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-3">
          <Wordmark />
          <p className="max-w-sm text-muted-foreground">
            Bug bounties that survive the AI-slop era. Free reports stay free; a bounty claim is backed by a refundable PayPal hold, and Claude reproduces the
            report before anyone pays.
          </p>
          <p className="text-xs text-muted-foreground">Built for the PayPal AI Hackathon. Apache-2.0. Lantern is a demo app written for this project.</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">PayPal, end to end</p>
          <ul className="space-y-1 text-muted-foreground">
            <li>Orders v2: AUTHORIZE deposits, CAPTURE sponsorships</li>
            <li>Payments: void and capture authorizations</li>
            <li>Payouts: one bounty per report id</li>
            <li>Webhooks, verified by PayPal</li>
            <li>JS SDK v6 checkout button</li>
          </ul>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Sources</p>
          <ul className="space-y-1.5 text-muted-foreground">
            <li>
              <a className="underline-offset-4 hover:text-foreground hover:underline" href={SOURCES.curl.href} target="_blank" rel="noreferrer">
                {SOURCES.curl.outlet}, {SOURCES.curl.date}
              </a>
            </li>
            <li>
              <a className="underline-offset-4 hover:text-foreground hover:underline" href={SOURCES.ibb.href} target="_blank" rel="noreferrer">
                {SOURCES.ibb.outlet}, {SOURCES.ibb.date}
              </a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
