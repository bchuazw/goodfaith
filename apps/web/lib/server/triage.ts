/**
 * Runs triage for one report inside the request that made it due (Next's `after()`), appending every
 * TriageEvent to the Store as it happens so any instance can stream it. A compare-and-set claim makes
 * sure exactly one run happens per attempt, even when two instances try to start it.
 */
import { type PriorReport, type TriageEvent, triageVerdictSchema } from "@goodfaith/core";
import { AppError, notFound } from "./errors";
import type { Services } from "./services";
import { KEEP, type ReportRecord, type TriageEventEntry } from "./store";

/** Moves a report to `queued` for the next attempt (deposit authorized, or a maintainer re-run). */
export function queuedForTriage(r: ReportRecord, nowIso: string, nextAttempt = false): ReportRecord {
  const attempt = nextAttempt ? (r.triage?.attempt ?? 0) + 1 : (r.triage?.attempt ?? 1);
  return { ...r, status: "queued", queuedAt: r.queuedAt ?? nowIso, triage: { attempt }, updatedAt: nowIso };
}

function isStale(svc: Services, r: ReportRecord): boolean {
  const claimed = r.triage?.claimedAt ? Date.parse(r.triage.claimedAt) : Number.NaN;
  return r.status === "triaging" && Number.isFinite(claimed) && svc.now().getTime() - claimed > svc.config.triageStaleMs;
}

/** Claims the queued attempt for this instance. Returns undefined when there is nothing to run or another instance has it. */
async function claimTriage(svc: Services, reportId: string): Promise<{ report: ReportRecord; attempt: number } | undefined> {
  const nowIso = svc.now().toISOString();
  const res = await svc.db.reports.update(reportId, (r) => {
    if (!r || r.status !== "queued") return KEEP;
    const attempt = r.triage?.attempt ?? 1;
    return { ...r, status: "triaging", triage: { attempt, claimedAt: nowIso, startedAt: nowIso, engine: svc.triage.kind }, updatedAt: nowIso };
  });
  if (!res.changed || !res.value) return undefined;
  return { report: res.value, attempt: res.value.triage?.attempt ?? 1 };
}

/** Earlier reports in the same program with a verdict: what the engine dedupes against. */
async function priorReports(svc: Services, report: ReportRecord): Promise<PriorReport[]> {
  const out: PriorReport[] = [];
  for (const r of await svc.db.reports.list()) {
    if (r.id === report.id || r.programId !== report.programId || r.input.submittedAt > report.input.submittedAt) continue;
    if ((r.demoRound ?? "") !== (report.demoRound ?? "")) continue; // judge-mode rounds are isolated
    const v = await svc.db.verdicts.value(r.id);
    if (!v) continue;
    out.push({
      id: r.id,
      title: r.input.title,
      summary: v.summary,
      ...(v.claims.vulnClass ? { vulnClass: v.claims.vulnClass } : {}),
      components: v.claims.components,
      verdict: v.verdict,
      reportedAt: r.input.submittedAt,
    });
  }
  return out.sort((a, b) => a.reportedAt.localeCompare(b.reportedAt));
}

export async function runTriage(svc: Services, reportId: string): Promise<void> {
  const claim = await claimTriage(svc, reportId);
  if (!claim) return;
  const { report, attempt } = claim;
  svc.signals.notify(reportId);

  const controller = new AbortController();
  const limitS = Math.round(svc.config.triageTimeoutMs / 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The hard limit does not trust the engine to honour the abort: the run is raced against it, so a
  // hung model or tool can never keep the attempt "triaging" until the platform kills the function.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`Triage stopped after ${limitS} s`);
      reason.name = "AbortError";
      controller.abort(reason);
      reject(reason);
    }, svc.config.triageTimeoutMs);
  });
  // onEvent is synchronous; appends are chained so the stored order is the emitted order.
  let chain: Promise<void> = Promise.resolve();
  let appendError: unknown;
  const onEvent = (event: TriageEvent) => {
    if (controller.signal.aborted) return; // a run past its limit must not keep writing to the attempt
    const entry: TriageEventEntry = { attempt, event };
    chain = chain
      .then(async () => {
        await svc.db.events.append(reportId, entry);
        svc.signals.notify(reportId);
      })
      .catch((e) => {
        appendError ??= e;
      });
  };

  try {
    const verdict = await Promise.race([
      svc.triage.run(
        report.input,
        { llm: svc.llm, code: svc.code, target: svc.target, priorReports: await priorReports(svc, report), now: svc.now },
        { onEvent, signal: controller.signal, llmBudgetMs: svc.config.triageLlmBudgetMs },
      ),
      deadline,
    ]);
    await chain;
    if (appendError) throw appendError;
    const checked = triageVerdictSchema.parse({ ...verdict, reportId });
    await svc.db.verdicts.put(reportId, checked);
    const finishedAt = svc.now().toISOString();
    await svc.db.reports.update(reportId, (r) => {
      if (!r || r.triage?.attempt !== attempt) return KEEP;
      return { ...r, status: r.status === "triaging" ? "triaged" : r.status, triage: { ...r.triage, finishedAt }, updatedAt: finishedAt };
    });
  } catch (e) {
    await chain;
    const message = controller.signal.aborted
      ? `Triage stopped after ${limitS} s; re-run it to try again`
      : e instanceof Error
        ? e.message.slice(0, 500)
        : String(e).slice(0, 500);
    console.error(`[goodfaith] triage ${reportId} attempt ${attempt} failed: ${message}`);
    const at = svc.now().toISOString();
    await svc.db.reports.update(reportId, (r) => {
      if (!r || r.triage?.attempt !== attempt || r.status !== "triaging") return KEEP;
      return { ...r, status: "triage_failed", triage: { ...r.triage, finishedAt: at, error: message }, updatedAt: at };
    });
  } finally {
    clearTimeout(timer);
    svc.signals.notify(reportId);
  }
}

/** A run whose instance died mid-way never finishes: mark it failed so a maintainer can re-run it. */
export async function reconcileTriage(svc: Services, report: ReportRecord): Promise<ReportRecord> {
  if (!isStale(svc, report)) return report;
  const at = svc.now().toISOString();
  const res = await svc.db.reports.update(report.id, (r) => {
    if (!r || !isStale(svc, r)) return KEEP;
    return { ...r, status: "triage_failed", triage: { ...(r.triage ?? { attempt: 1 }), finishedAt: at, error: "Triage was interrupted before it finished" }, updatedAt: at };
  });
  return res.value ?? report;
}

/** Maintainer action: run triage again (after a failure, or to re-check a verdict before settling). */
export async function rerunTriage(svc: Services, reportId: string): Promise<ReportRecord> {
  const nowIso = svc.now().toISOString();
  const res = await svc.db.reports.update(reportId, (r) => {
    if (!r) throw notFound("Report");
    if (r.status === "awaiting_deposit") throw new AppError("DEPOSIT_PENDING", "Triage starts once the deposit is authorized", 409);
    if (r.status === "queued" || (r.status === "triaging" && !isStale(svc, r))) return KEEP;
    if (r.status === "settled" || r.settlement) throw new AppError("ALREADY_SETTLED", "This report is already settled", 409);
    return queuedForTriage(r, nowIso, true);
  });
  if (res.changed) svc.defer(() => runTriage(svc, reportId));
  return res.value as ReportRecord;
}

/** The events of the report's current attempt, after `afterSeq`. */
export async function triageEvents(svc: Services, reportId: string, afterSeq = 0): Promise<Array<{ seq: number; attempt: number; event: TriageEvent }>> {
  return (await svc.db.events.read(reportId, afterSeq)).map((e) => ({ seq: e.seq, attempt: e.value.attempt, event: e.value.event }));
}
