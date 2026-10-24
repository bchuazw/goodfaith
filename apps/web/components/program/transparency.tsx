import { BanknoteIcon, FileSearchIcon, HandCoinsIcon, ShieldCheckIcon, ShieldXIcon, TimerIcon, TrophyIcon } from "lucide-react";
import { Money } from "@/components/money";
import { StatTile } from "@/components/stat-tile";
import { formatDuration, pct } from "@/lib/format";
import type { TransparencyStats } from "@/lib/server/stats";

export function TransparencyTiles({ stats, className }: { stats: TransparencyStats; className?: string }) {
  return (
    <div className={className ?? "grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"}>
      <StatTile icon={FileSearchIcon} label="Reports triaged" value={stats.triaged} sub={`${stats.received} received`} />
      <StatTile icon={ShieldCheckIcon} label="Reproduced" value={pct(stats.reproducedPct)} sub={`${stats.reproduced} with proof`} />
      <StatTile icon={ShieldXIcon} label="Slop caught" value={stats.slop} sub={`${stats.duplicates} duplicates, ${stats.needsHuman} for humans`} />
      <StatTile icon={HandCoinsIcon} label="Deposits captured" mono value={<Money value={stats.depositsCaptured.total} />} sub={`${stats.depositsCaptured.count} · ${stats.depositsReleased.count} released`} />
      <StatTile icon={BanknoteIcon} label="Bounties paid" mono value={<Money value={stats.bountiesPaid.total} />} sub={`${stats.bountiesPaid.count} payout${stats.bountiesPaid.count === 1 ? "" : "s"}`} />
      <StatTile icon={TimerIcon} label="Median time to triage" value={formatDuration(stats.medianTriageMs)} sub="deposit held to verdict" />
    </div>
  );
}

export function HallOfFame({ stats }: { stats: TransparencyStats }) {
  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <TrophyIcon className="size-4 text-seal-strong" aria-hidden />
        <h3 className="text-sm font-medium">Hall of fame</h3>
      </div>
      {stats.hallOfFame.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No bounties paid yet. The first reproduced report lands here.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Researcher</th>
              <th className="px-4 py-2 font-medium">Verified</th>
              <th className="px-4 py-2 text-right font-medium">Paid</th>
            </tr>
          </thead>
          <tbody>
            {stats.hallOfFame.map((r, i) => (
              <tr key={r.handle} className="border-t">
                <td className="px-4 py-2.5">
                  <span className="mr-2 font-mono text-xs text-muted-foreground tabular">{i + 1}</span>@{r.handle}
                </td>
                <td className="px-4 py-2.5 tabular">{r.verified}</td>
                <td className="px-4 py-2.5 text-right">
                  <Money value={r.paid} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
