/** Builds the browser-facing views (lib/view-types.ts) from stored records. */
import type { TriageEvent, TriageVerdict } from "@goodfaith/core";
import type { CodeEvidence, DepositView, PayoutView, QueueRow, ReportView } from "../view-types";
import { notFound } from "./errors";
import { maybeRefreshPayout } from "./payouts";
import type { Services } from "./services";
import { settlementOptions } from "./settlement";
import type { DepositRecord, PayoutRecord, ReportRecord } from "./store";
import { reconcileTriage } from "./triage";

export type Audience = "researcher" | "maintainer";

/**
 * Triage events as an audience may see them: the researcher gets the researcher-facing summary in the
 * verdict event, never the maintainer's notes.
 */
export function eventsFor<E extends { event: TriageEvent }>(events: E[], audience: Audience): E[] {
  if (audience === "maintainer") return events;
  return events.map((e) =>
    e.event.type === "verdict" ? { ...e, event: { ...e.event, verdict: { ...e.event.verdict, summary: e.event.verdict.researcherSummary } } } : e,
  );
}

/** "mkdir.p.research@example.com" -> "mk•••@example.com". */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}•••@${domain}`;
}

function depositView(d: DepositRecord, audience: Audience): DepositView {
  return {
    status: d.status,
    amount: d.amount,
    orderId: d.orderId,
    source: d.source,
    ...(d.authorizationId ? { authorizationId: d.authorizationId } : {}),
    ...(d.captureId ? { captureId: d.captureId } : {}),
    ...(d.captureStatus ? { captureStatus: d.captureStatus } : {}),
    ...(d.honorUntil ? { honorUntil: d.honorUntil } : {}),
    ...(d.authorizationExpiresAt ? { authorizationExpiresAt: d.authorizationExpiresAt } : {}),
    ...(d.payerEmail ? { payer: audience === "maintainer" ? d.payerEmail : maskEmail(d.payerEmail) } : {}),
    createdAt: d.createdAt,
    ...(d.approvedAt ? { approvedAt: d.approvedAt } : {}),
    ...(d.authorizedAt ? { authorizedAt: d.authorizedAt } : {}),
    ...(d.voidedAt ? { voidedAt: d.voidedAt } : {}),
    ...(d.capturedAt ? { capturedAt: d.capturedAt } : {}),
    ...(d.lastError ? { lastError: d.lastError } : {}),
    ...(d.dispute ? { dispute: d.dispute } : {}),
  };
}

function payoutView(p: PayoutRecord, audience: Audience): PayoutView {
  return {
    status: p.status,
    amount: p.amount,
    severity: p.severity,
    senderBatchId: p.senderBatchId,
    receiver: audience === "maintainer" ? p.receiver : maskEmail(p.receiver),
    ...(p.batchId ? { batchId: p.batchId } : {}),
    ...(p.batchStatus ? { batchStatus: p.batchStatus } : {}),
    ...(p.itemId ? { itemId: p.itemId } : {}),
    ...(p.transactionId ? { transactionId: p.transactionId } : {}),
    ...(p.fee ? { fee: p.fee } : {}),
    ...(p.error ? { error: p.error } : {}),
    ...(p.replayed ? { replayed: true } : {}),
    createdAt: p.createdAt,
    ...(p.completedAt ? { completedAt: p.completedAt } : {}),
  };
}

export async function reportView(svc: Services, reportId: string, audience: Audience): Promise<ReportView> {
  const stored = await svc.db.reports.value(reportId);
  if (!stored) throw notFound("Report");
  const report = await reconcileTriage(svc, stored);
  const [deposit, payout, verdict] = await Promise.all([svc.db.deposits.value(reportId), svc.db.payouts.value(reportId), svc.db.verdicts.value(reportId)]);
  maybeRefreshPayout(svc, payout);
  const s = report.settlement;
  const view: ReportView = {
    id: report.id,
    programId: report.programId,
    kind: report.kind,
    title: report.input.title,
    body: report.input.body,
    ...(report.input.claimedVersion ? { claimedVersion: report.input.claimedVersion } : {}),
    ...(report.input.claimedSeverity ? { claimedSeverity: report.input.claimedSeverity } : {}),
    ...(report.input.poc ? { poc: report.input.poc } : {}),
    reporter: report.input.reporter,
    submittedAt: report.input.submittedAt,
    status: report.status,
    ...(report.queuedAt ? { queuedAt: report.queuedAt } : {}),
    ...(report.triage ? { triage: { attempt: report.triage.attempt, ...(report.triage.startedAt ? { startedAt: report.triage.startedAt } : {}), ...(report.triage.finishedAt ? { finishedAt: report.triage.finishedAt } : {}), ...(report.triage.error ? { error: report.triage.error } : {}), ...(report.triage.engine ? { engine: report.triage.engine } : {}) } } : {}),
    ...(s
      ? {
          settlement: {
            action: s.action,
            status: s.status,
            actor: s.actor,
            startedAt: s.startedAt,
            ...(s.completedAt ? { completedAt: s.completedAt } : {}),
            ...(s.severity ? { severity: s.severity } : {}),
            ...(s.amount ? { amount: s.amount } : {}),
            ...(s.note ? { note: s.note } : {}),
            ...(audience === "maintainer" && s.overrideReason ? { overrideReason: s.overrideReason } : {}),
            ...(s.error ? { error: s.error } : {}),
          },
        }
      : {}),
    ...(deposit ? { deposit: depositView(deposit, audience) } : {}),
    ...(payout ? { payout: payoutView(payout, audience) } : {}),
    // The researcher sees the researcher-facing summary; the maintainer's notes stay in the console.
    ...(verdict ? { verdict: audience === "maintainer" ? verdict : { ...verdict, summary: verdict.researcherSummary } } : {}),
    ...(report.demoScenario ? { demoScenario: report.demoScenario } : {}),
    audience,
  };
  if (audience === "maintainer") {
    if (report.payoutEmail) view.payoutEmail = report.payoutEmail;
    view.options = settlementOptions({ report, ...(deposit ? { deposit } : {}), ...(payout ? { payout } : {}), ...(verdict ? { verdict } : {}) });
    view.ledger = await svc.db.ledger.read(report.id);
    if (verdict) view.codeEvidence = await codeEvidence(svc, verdict, report.input.claimedVersion);
  }
  return view;
}

/** Each code-reference finding with the lines it points at, read from the program's code source. */
async function codeEvidence(svc: Services, verdict: TriageVerdict, claimedVersion?: string): Promise<CodeEvidence[]> {
  const version = verdict.claims.version ?? claimedVersion;
  const ref = version ? await svc.code.resolveVersion(version).catch(() => undefined) : undefined;
  const out: CodeEvidence[] = [];
  for (const f of verdict.findings.filter((x) => x.kind === "code_ref")) {
    const ev = (f.evidence ?? {}) as { path?: string; symbol?: string; nearMatch?: string; locations?: Array<{ path: string; line?: number }> };
    let path = ev.path ?? ev.locations?.[0]?.path;
    let line = ev.locations?.[0]?.line;
    if (ref && ev.symbol && f.status === "pass") {
      const defs = await svc.code.findSymbol(ev.symbol, ref).catch(() => []);
      const def = defs.find((d) => !path || d.path === path) ?? defs[0];
      if (def) {
        path = def.path;
        line = def.line;
      }
    }
    if (ref && ev.nearMatch && f.status === "inconclusive") {
      const defs = await svc.code.findSymbol(ev.nearMatch, ref).catch(() => []);
      if (defs[0]) {
        path = path ?? defs[0].path;
        line = defs[0].line;
      }
    }
    let snippet: CodeEvidence["snippet"];
    if (ref && path && f.status !== "fail") {
      const text = await svc.code.readFile(path, ref).catch(() => undefined);
      if (text) {
        const lines = text.split(/\r?\n/);
        const at = line ?? 1;
        const start = Math.max(1, at - 3);
        snippet = { startLine: start, lines: lines.slice(start - 1, start + 9), ...(line ? { highlight: line } : {}) };
      }
    }
    out.push({
      status: f.status,
      title: f.title,
      detail: f.detail,
      ...(ref ? { version: ref } : {}),
      ...(path ? { path } : {}),
      ...(ev.symbol ? { symbol: ev.symbol } : {}),
      ...(line ? { line } : {}),
      ...(ev.nearMatch ? { nearMatch: ev.nearMatch } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return out;
}

export async function queueRows(svc: Services): Promise<QueueRow[]> {
  const [reports, deposits, payouts, verdicts] = await Promise.all([svc.db.reports.list(), svc.db.deposits.list(), svc.db.payouts.list(), svc.db.verdicts.list()]);
  const dep = new Map(deposits.map((d) => [d.reportId, d]));
  const pay = new Map(payouts.map((p) => [p.reportId, p]));
  const ver = new Map(verdicts.map((v) => [v.reportId, v]));
  return reports
    .filter((r: ReportRecord) => r.programId === svc.program.id)
    .map((r): QueueRow => {
      const d = dep.get(r.id);
      const p = pay.get(r.id);
      const v = ver.get(r.id);
      const triageMs = v && r.queuedAt ? Date.parse(v.finishedAt) - Date.parse(r.queuedAt) : undefined;
      return {
        id: r.id,
        title: r.input.title,
        handle: r.input.reporter.handle,
        kind: r.kind,
        status: r.status,
        ...(v ? { verdict: v.verdict, confidence: v.confidence } : {}),
        ...(v?.model.mode === "degraded" ? { aiUnavailable: true } : {}),
        ...(v?.suggestedSeverity ? { severity: v.suggestedSeverity.level } : {}),
        ...(r.input.claimedSeverity ? { claimedSeverity: r.input.claimedSeverity } : {}),
        submittedAt: r.input.submittedAt,
        ...(triageMs !== undefined && Number.isFinite(triageMs) ? { triageMs } : {}),
        ...(d ? { depositStatus: d.status, depositAmount: d.amount } : {}),
        ...(p ? { payoutStatus: p.status, payoutAmount: p.amount } : {}),
        ...(r.settlement ? { settlement: { action: r.settlement.action, status: r.settlement.status } } : {}),
        ...(r.demoScenario ? { demoScenario: r.demoScenario } : {}),
      };
    })
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
