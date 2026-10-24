/** The public transparency numbers, computed from the Store on every request (no stored counters to drift). */
import { fromMinor, type Money, toMinor } from "../money";
import type { Services } from "./services";
import { type PoolBalance, poolBalance } from "./sponsor";

export type TransparencyStats = {
  /** Reports that entered triage (bounty claims count once their deposit is held). */
  received: number;
  triaged: number;
  reproduced: number;
  reproducedPct: number | null;
  slop: number;
  duplicates: number;
  needsHuman: number;
  depositsHeld: { count: number; total: Money };
  depositsCaptured: { count: number; total: Money };
  depositsReleased: { count: number; total: Money };
  bountiesPaid: { count: number; total: Money };
  medianTriageMs: number | null;
  hallOfFame: Array<{ handle: string; verified: number; paid: Money }>;
  pool: PoolBalance;
};

const total = (list: Money[]): Money => fromMinor(list.reduce((acc, m) => acc + (m.currency === "USD" ? toMinor(m) : 0), 0), "USD");

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export async function transparencyStats(svc: Services): Promise<TransparencyStats> {
  const [reports, verdicts, deposits, payouts, pool] = await Promise.all([svc.db.reports.list(), svc.db.verdicts.list(), svc.db.deposits.list(), svc.db.payouts.list(), poolBalance(svc)]);
  const mine = reports.filter((r) => r.programId === svc.program.id);
  const ids = new Set(mine.map((r) => r.id));
  const received = mine.filter((r) => r.status !== "awaiting_deposit");
  const v = verdicts.filter((x) => ids.has(x.reportId));
  const count = (verdict: string) => v.filter((x) => x.verdict === verdict).length;
  const deps = deposits.filter((d) => ids.has(d.reportId));
  const paid = payouts.filter((p) => ids.has(p.reportId) && p.status === "SUCCESS");
  const byId = new Map(mine.map((r) => [r.id, r]));

  const triageTimes = v
    .map((x) => {
      const queued = byId.get(x.reportId)?.queuedAt;
      return queued ? Date.parse(x.finishedAt) - Date.parse(queued) : Number.NaN;
    })
    .filter((ms) => Number.isFinite(ms) && ms >= 0);

  const fame = new Map<string, { handle: string; verified: number; paid: Money[] }>();
  for (const p of paid) {
    const handle = byId.get(p.reportId)?.input.reporter.handle;
    if (!handle) continue;
    const row = fame.get(handle.toLowerCase()) ?? { handle, verified: 0, paid: [] };
    row.verified++;
    row.paid.push(p.amount);
    fame.set(handle.toLowerCase(), row);
  }

  const reproduced = count("REPRODUCED");
  return {
    received: received.length,
    triaged: v.length,
    reproduced,
    reproducedPct: v.length ? Math.round((reproduced / v.length) * 100) : null,
    slop: count("SLOP"),
    duplicates: count("DUPLICATE"),
    needsHuman: count("NEEDS_HUMAN"),
    depositsHeld: { count: deps.filter((d) => d.status === "AUTHORIZED").length, total: total(deps.filter((d) => d.status === "AUTHORIZED").map((d) => d.amount)) },
    depositsCaptured: { count: deps.filter((d) => d.status === "CAPTURED").length, total: total(deps.filter((d) => d.status === "CAPTURED").map((d) => d.amount)) },
    depositsReleased: { count: deps.filter((d) => d.status === "VOIDED").length, total: total(deps.filter((d) => d.status === "VOIDED").map((d) => d.amount)) },
    bountiesPaid: { count: paid.length, total: total(paid.map((p) => p.amount)) },
    medianTriageMs: median(triageTimes),
    hallOfFame: [...fame.values()]
      .map((r) => ({ handle: r.handle, verified: r.verified, paid: total(r.paid) }))
      .sort((a, b) => toMinor(b.paid) - toMinor(a.paid) || b.verified - a.verified)
      .slice(0, 10),
    pool,
  };
}
