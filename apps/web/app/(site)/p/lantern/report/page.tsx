import type { Metadata } from "next";
import Link from "next/link";
import { servicesOrError } from "@/lib/server/page";
import { ReportForm } from "./report-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report a vulnerability in Lantern" };

export default function ReportPage() {
  const { svc, error } = servicesOrError();
  if (!svc) return <p className="mx-auto max-w-6xl px-4 py-16 text-danger-strong">{error}</p>;
  const p = svc.program;
  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 pb-16 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
        <Link href="/p/lantern" className="hover:text-foreground">
          Lantern
        </Link>
        <span aria-hidden className="px-1.5">/</span>
        <span>Report</span>
      </nav>
      <header className="mb-10 space-y-3">
        <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Report a vulnerability in {p.name}</h1>
        <p className="max-w-prose text-muted-foreground">
          Everything you submit is treated as untrusted data. Claude checks the code you cite and replays your proof of concept against a sandboxed copy of Lantern;
          a maintainer makes every money decision. Read the{" "}
          <Link href="/p/lantern" className="text-foreground underline underline-offset-4">
            program rules
          </Link>{" "}
          first.
        </p>
      </header>
      <ReportForm
        paypalMode={svc.mode.paypal}
        program={{ id: p.id, name: p.name, versionsInScope: p.versionsInScope, accounts: p.accounts, bounties: p.bounties, deposit: p.deposit }}
      />
    </div>
  );
}
