import { BanknoteIcon, GavelIcon, HandCoinsIcon, LockIcon, ScanSearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { QueueGrid } from "@/components/console/queue-grid";
import { Money } from "@/components/money";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { servicesOrError } from "@/lib/server/page";
import { transparencyStats } from "@/lib/server/stats";
import { queueRows } from "@/lib/server/views";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Maintainer console" };

export default async function ConsolePage() {
  const { svc, error } = servicesOrError();
  if (!svc) return <p className="mx-auto max-w-6xl px-4 py-16 text-danger-strong">{error}</p>;
  const [rows, stats] = await Promise.all([queueRows(svc), transparencyStats(svc)]);
  const decide = rows.filter((r) => r.status === "triaged" || r.status === "triage_failed").length;
  const inTriage = rows.filter((r) => r.status === "queued" || r.status === "triaging").length;

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="font-mono text-[0.7rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">Lantern · maintainer console</p>
          <h1 className="font-display text-4xl tracking-tight">Triage queue</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Claude recommends; you decide. Every pay, release and capture is a PayPal call you approve, and each deposit can be resolved exactly once.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/demo">Open judge mode</Link>
        </Button>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile icon={GavelIcon} label="Needs a decision" value={decide} sub={decide === 1 ? "report triaged" : "reports triaged"} />
        <StatTile icon={ScanSearchIcon} label="In triage" value={inTriage} sub="streaming now" />
        <StatTile icon={LockIcon} label="Deposits held" mono value={<Money value={stats.depositsHeld.total} />} sub={`${stats.depositsHeld.count} authorization${stats.depositsHeld.count === 1 ? "" : "s"}`} />
        <StatTile icon={HandCoinsIcon} label="Slop captured" mono value={<Money value={stats.depositsCaptured.total} />} sub={`${stats.depositsCaptured.count} deposit${stats.depositsCaptured.count === 1 ? "" : "s"}`} />
        <StatTile icon={BanknoteIcon} label="Bounties paid" mono value={<Money value={stats.bountiesPaid.total} />} sub={`${stats.bountiesPaid.count} payout${stats.bountiesPaid.count === 1 ? "" : "s"}`} className="col-span-2 lg:col-span-1" />
      </div>

      <QueueGrid initial={rows} />
    </div>
  );
}
