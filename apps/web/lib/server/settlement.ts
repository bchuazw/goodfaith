/**
 * Settlement: the only place money moves, and only on a maintainer's action. The AI never settles.
 *
 * Money rules (docs/CONTRACTS.md), enforced here and covered by tests:
 * - A deposit is voided or captured at most once. The resolution is claimed with a compare-and-set
 *   on the deposit before PayPal is called, with a fixed PayPal-Request-Id, so a retry can only repeat
 *   the same action (and PayPal dedupes it). A report-level compare-and-set on `settlement` means two
 *   instances racing "release" and "capture" cannot both proceed.
 * - A payout uses senderBatchId "gf-" + reportId, and its record is created once, so it pays once.
 * - "pay" needs a REPRODUCED verdict, or a maintainer override with a typed reason.
 * - "capture" needs a SLOP verdict and explicit confirmation.
 */
import { SEVERITIES, type Severity, type TriageVerdict } from "@goodfaith/core";
import { z } from "zod";
import { formatMoney } from "../money";
import { AppError, notFound, paypalErrorInfo, paypalFailure, paypalIssue } from "./errors";
import { requestIds, senderBatchIdFor } from "./ids";
import { paypalCall } from "./ledger";
import { pollPayout } from "./payouts";
import type { Services } from "./services";
import { type DepositRecord, KEEP, type PayoutRecord, type ReportRecord, type SettlementAction, type SettlementRecord } from "./store";

export const MIN_OVERRIDE_REASON = 12;

export const settleRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pay"), severity: z.enum(SEVERITIES).optional(), overrideReason: z.string().trim().max(1000).optional(), actor: z.string().trim().max(64).optional() }),
  z.object({ action: z.literal("release"), note: z.string().trim().max(1000).optional(), actor: z.string().trim().max(64).optional() }),
  z.object({ action: z.literal("capture"), confirm: z.boolean().optional(), actor: z.string().trim().max(64).optional() }),
]);
export type SettleRequest = z.infer<typeof settleRequestSchema>;

export type ActionOption = { allowed: boolean; reason?: string; needs?: "override" | "confirm" };
export type SettlementOptions = Record<SettlementAction, ActionOption>;

export type SettlementContext = { report: ReportRecord; deposit?: DepositRecord; payout?: PayoutRecord; verdict?: TriageVerdict };

const ACTION_LABEL: Record<SettlementAction, string> = { pay: "bounty paid", release: "deposit released", capture: "deposit captured" };
const no = (reason: string): ActionOption => ({ allowed: false, reason });

/** What a maintainer may do right now, and why not. The API enforces exactly this. */
export function settlementOptions(ctx: SettlementContext): SettlementOptions {
  const { report, deposit, verdict } = ctx;
  const s = report.settlement;
  if (s?.status === "done") {
    const done = no(`Settled: ${ACTION_LABEL[s.action]}`);
    return { pay: done, release: done, capture: done };
  }
  if (report.kind === "free") {
    const free = no("Free report: there is no deposit and no bounty");
    return { pay: free, release: free, capture: free };
  }
  if (report.status === "awaiting_deposit") {
    const waiting = no("Waiting for the researcher's deposit");
    return { pay: waiting, release: waiting, capture: waiting };
  }
  const busy = (a: SettlementAction) => (s && s.action !== a ? no(`A ${s.action} is already ${s.status === "failed" ? "started (retry it)" : "in progress"}`) : undefined);
  const triageDone = report.status === "triaged" || report.status === "triage_failed" || !!verdict;
  const held = deposit?.status === "AUTHORIZED";
  const resuming = (a: SettlementAction, inflight: DepositRecord["status"]) => s?.action === a && deposit?.status === inflight;

  let pay: ActionOption;
  if (busy("pay")) pay = busy("pay") as ActionOption;
  else if (!triageDone) pay = no("Triage is still running");
  else if (!deposit && !report.input.reporter.trusted) pay = no("There is no deposit on this claim");
  else if (deposit && !held && !resuming("pay", "VOIDING") && !(s?.action === "pay" && deposit.status === "VOIDED")) pay = no(`The deposit is ${deposit.status.toLowerCase()}`);
  else if (verdict?.verdict === "REPRODUCED") pay = { allowed: true };
  else pay = { allowed: true, needs: "override", reason: `The verdict is ${verdict?.verdict ?? "missing"}: paying needs a typed override reason` };

  let release: ActionOption;
  if (busy("release")) release = busy("release") as ActionOption;
  else if (!deposit) release = no("There is no deposit to release");
  else if (!held && !resuming("release", "VOIDING")) release = no(`The deposit is ${deposit.status.toLowerCase()}`);
  else release = { allowed: true };

  let capture: ActionOption;
  if (busy("capture")) capture = busy("capture") as ActionOption;
  else if (!deposit) capture = no("There is no deposit to capture");
  else if (verdict?.verdict !== "SLOP") capture = no(`Capture needs a SLOP verdict (this one is ${verdict?.verdict ?? "pending"})`);
  else if (!held && !resuming("capture", "CAPTURING")) capture = no(`The deposit is ${deposit.status.toLowerCase()}`);
  else capture = { allowed: true, needs: "confirm" };

  return { pay, release, capture };
}

export async function settlementContext(svc: Services, reportId: string): Promise<SettlementContext> {
  const report = await svc.db.reports.value(reportId);
  if (!report) throw notFound("Report");
  const [deposit, payout, verdict] = await Promise.all([svc.db.deposits.value(reportId), svc.db.payouts.value(reportId), svc.db.verdicts.value(reportId)]);
  return { report, ...(deposit ? { deposit } : {}), ...(payout ? { payout } : {}), ...(verdict ? { verdict } : {}) };
}

/** Runs a maintainer's settlement action. Repeating a completed action is a no-op; a failed one resumes. */
export async function settle(svc: Services, reportId: string, raw: unknown): Promise<SettlementContext> {
  const parsed = settleRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_ACTION", parsed.error.issues[0]?.message ?? "Invalid settlement request", 422);
  const req = parsed.data;
  const ctx = await settlementContext(svc, reportId);
  if (ctx.report.settlement?.status === "done" && ctx.report.settlement.action === req.action) return ctx;

  const option = settlementOptions(ctx)[req.action];
  if (!option.allowed) throw new AppError("ACTION_NOT_ALLOWED", option.reason ?? "Not allowed", 409);
  const actor = req.actor || "maintainer";
  const fields: Partial<SettlementRecord> = {};

  if (req.action === "pay") {
    // Resuming a failed pay keeps the reason typed the first time.
    const reason = req.overrideReason?.trim() || ctx.report.settlement?.overrideReason || "";
    if (option.needs === "override" && reason.length < MIN_OVERRIDE_REASON) {
      throw new AppError("OVERRIDE_REASON_REQUIRED", `Paying a ${ctx.verdict?.verdict ?? "untriaged"} report needs a typed reason of at least ${MIN_OVERRIDE_REASON} characters`, 422);
    }
    // Once a payout exists its severity and amount are fixed: PayPal would replay the original batch anyway.
    const severity: Severity | undefined = ctx.payout?.severity ?? ctx.report.settlement?.severity ?? req.severity ?? ctx.verdict?.suggestedSeverity?.level ?? ctx.report.input.claimedSeverity;
    if (!severity) throw new AppError("SEVERITY_REQUIRED", "Choose the severity to pay", 422);
    if (!(ctx.report.payoutEmail ?? ctx.deposit?.payerEmail)) throw new AppError("NO_PAYOUT_RECEIVER", "There is no PayPal account to pay: the claim has no payout email and no deposit payer", 409);
    fields.severity = severity;
    fields.amount = ctx.payout?.amount ?? svc.program.bounties[severity];
    if (option.needs === "override") fields.overrideReason = reason;
  } else if (req.action === "capture") {
    if (req.confirm !== true) throw new AppError("CONFIRMATION_REQUIRED", "Capturing a deposit needs explicit confirmation", 422);
    fields.amount = ctx.deposit?.amount as NonNullable<SettlementRecord["amount"]>;
  } else if (req.note) {
    fields.note = req.note;
  }

  // Claim the settlement for this action (compare-and-set): a different action can never start after this.
  const nowIso = svc.now().toISOString();
  const claimed = await svc.db.reports.update(reportId, (r) => {
    if (!r) throw notFound("Report");
    const s = r.settlement;
    if (s && s.action !== req.action) throw new AppError("ALREADY_SETTLING", `This report is already being settled (${s.action})`, 409);
    if (s?.status === "done") return KEEP;
    return {
      ...r,
      settlement: { ...s, ...fields, action: req.action, status: "in_progress", actor, startedAt: s?.startedAt ?? nowIso },
      updatedAt: nowIso,
    } as ReportRecord;
  });
  svc.signals.notify(reportId);
  if (claimed.value?.settlement?.status === "done") return settlementContext(svc, reportId);

  try {
    if (req.action === "pay") {
      if (ctx.deposit) await resolveDeposit(svc, reportId, "void");
      const s = claimed.value?.settlement as SettlementRecord;
      const receiver = (ctx.report.payoutEmail ?? ctx.deposit?.payerEmail) as string;
      await ensurePayout(svc, reportId, { receiver, severity: s.severity as Severity, amount: s.amount as NonNullable<SettlementRecord["amount"]> });
    } else {
      await resolveDeposit(svc, reportId, req.action === "release" ? "void" : "capture");
    }
    await finishSettlement(svc, reportId, req.action);
    if (req.action === "pay") svc.defer(() => pollPayout(svc, reportId));
  } catch (e) {
    const info = e instanceof AppError ? { code: e.code, message: e.message } : { code: "ERROR", message: paypalErrorInfo(e).message };
    const debugId = (e instanceof AppError ? (e.details?.paypal as { debugId?: string } | undefined)?.debugId : undefined) ?? paypalErrorInfo(e).debugId;
    await failSettlement(svc, reportId, req.action, { ...info, ...(debugId ? { debugId } : {}) });
    throw e;
  } finally {
    svc.signals.notify(reportId);
  }
  return settlementContext(svc, reportId);
}

async function finishSettlement(svc: Services, reportId: string, action: SettlementAction): Promise<void> {
  const at = svc.now().toISOString();
  await svc.db.reports.update(reportId, (r) => {
    if (!r?.settlement || r.settlement.action !== action || r.settlement.status === "done") return KEEP;
    const { error: _cleared, ...rest } = r.settlement;
    return { ...r, status: "settled", settlement: { ...rest, status: "done", completedAt: at }, updatedAt: at };
  });
}

async function failSettlement(svc: Services, reportId: string, action: SettlementAction, error: NonNullable<SettlementRecord["error"]>): Promise<void> {
  const at = svc.now().toISOString();
  await svc.db.reports.update(reportId, (r) => {
    if (!r?.settlement || r.settlement.action !== action || r.settlement.status === "done") return KEEP;
    return { ...r, settlement: { ...r.settlement, status: "failed", error }, updatedAt: at };
  });
}

/**
 * Voids or captures the deposit's authorization, at most once. The claim (VOIDING/CAPTURING plus
 * `resolution`) is written first; after a crash only the same action can resume, with the same request id.
 */
export async function resolveDeposit(svc: Services, reportId: string, action: "void" | "capture"): Promise<DepositRecord> {
  const requestId = action === "void" ? requestIds.void(reportId) : requestIds.capture(reportId);
  const target: DepositRecord["status"] = action === "void" ? "VOIDED" : "CAPTURED";
  const inflight: DepositRecord["status"] = action === "void" ? "VOIDING" : "CAPTURING";
  const nowIso = svc.now().toISOString();
  const claim = await svc.db.deposits.update(reportId, (d) => {
    if (!d) throw new AppError("NO_DEPOSIT", "There is no deposit on this report", 409);
    if (d.resolution && d.resolution.action !== action) {
      throw new AppError("DEPOSIT_ALREADY_RESOLVED", `The deposit was already ${d.resolution.action === "void" ? "released" : "captured"}; it can be resolved only once`, 409);
    }
    if (d.status === target || d.status === inflight) return KEEP;
    if (d.status !== "AUTHORIZED" || !d.authorizationId) throw new AppError("DEPOSIT_NOT_HELD", `The deposit is ${d.status.toLowerCase()}, not held`, 409);
    return { ...d, status: inflight, resolution: { action, requestId, claimedAt: nowIso }, updatedAt: nowIso };
  });
  const dep = claim.value as DepositRecord;
  if (dep.status === target) return dep;
  const authorizationId = dep.authorizationId as string;
  const amount = formatMoney(dep.amount);

  let captureId: string | undefined;
  let captureStatus: string | undefined;
  try {
    if (action === "void") {
      await paypalCall(
        svc,
        "authorizations.void",
        { reportId },
        () => svc.paypal.voidAuthorization(authorizationId, { requestId }),
        (r) => ({ summary: `Voided the ${amount} hold: the deposit is released in full`, ids: { authorizationId }, status: r.status }),
        "Could not void the deposit hold",
      );
    } else {
      const r = await paypalCall(
        svc,
        "authorizations.capture",
        { reportId },
        () => svc.paypal.captureAuthorization(authorizationId, requestId),
        (c) => ({ summary: `Captured the ${amount} deposit into the maintainer fund`, ids: { authorizationId, captureId: c.captureId }, status: c.status }),
        "Could not capture the deposit",
      );
      captureId = r.captureId;
      captureStatus = r.status;
    }
  } catch (e) {
    const issue = paypalIssue(e);
    const alreadyDone =
      (action === "void" && (issue === "PREVIOUSLY_VOIDED" || issue === "AUTHORIZATION_VOIDED" || issue === "AUTHORIZATION_EXPIRED")) ||
      (action === "capture" && issue === "AUTHORIZATION_ALREADY_CAPTURED");
    if (!alreadyDone) {
      const info = paypalErrorInfo(e);
      const at = svc.now().toISOString();
      await svc.db.deposits.update(reportId, (d) =>
        d && d.status === inflight ? { ...d, lastError: { code: info.issue ?? info.name, message: info.message, ...(info.debugId ? { debugId: info.debugId } : {}), at }, updatedAt: at } : KEEP,
      );
      throw paypalFailure(action === "void" ? "void the deposit hold" : "capture the deposit", e);
    }
  }

  const doneAt = svc.now().toISOString();
  const res = await svc.db.deposits.update(reportId, (d) => {
    if (!d || d.status !== inflight) return KEEP;
    const { lastError: _cleared, ...rest } = d;
    return {
      ...rest,
      status: target,
      ...(action === "void" ? { voidedAt: doneAt } : { capturedAt: doneAt, ...(captureId ? { captureId } : {}), ...(captureStatus ? { captureStatus } : {}) }),
      resolution: { ...(d.resolution as NonNullable<DepositRecord["resolution"]>), completedAt: doneAt },
      updatedAt: doneAt,
    };
  });
  svc.signals.notify(reportId);
  return (res.value ?? dep) as DepositRecord;
}

/** Creates the payout once: the record is created with a compare-and-set, the batch id is "gf-" + reportId. */
async function ensurePayout(svc: Services, reportId: string, p: { receiver: string; severity: Severity; amount: NonNullable<SettlementRecord["amount"]> }): Promise<PayoutRecord> {
  const createPayout = svc.paypal.createPayout?.bind(svc.paypal);
  if (!createPayout) throw new AppError("PAYOUTS_UNAVAILABLE", "This PayPal client has no Payouts support", 500);
  const nowIso = svc.now().toISOString();
  const senderBatchId = senderBatchIdFor(reportId);
  const created = await svc.db.payouts.update(reportId, (cur) =>
    cur ? KEEP : { reportId, senderBatchId, receiver: p.receiver, amount: p.amount, severity: p.severity, status: "CREATING", createdAt: nowIso, updatedAt: nowIso },
  );
  const payout = created.value as PayoutRecord;
  if (payout.batchId) return payout;

  const amount = formatMoney(payout.amount);
  const batch = await paypalCall(
    svc,
    "payouts.create",
    { reportId },
    () =>
      createPayout({
        senderBatchId,
        items: [
          {
            receiver: payout.receiver,
            amount: payout.amount,
            senderItemId: reportId,
            note: `Good Faith bounty for report ${reportId} (${payout.severity} severity), reproduced in the ${svc.program.name} sandbox.`,
          },
        ],
        emailSubject: `Your ${svc.program.name} bug bounty: ${amount}`,
        emailMessage: `Thanks for reporting in good faith. Your report reproduced, so the ${payout.severity} bounty is on its way.`,
      }),
    (b) => ({
      summary: b.replayed ? `PayPal returned the batch already created for ${senderBatchId}: nothing was paid twice` : `Sent the ${amount} bounty with PayPal Payouts`,
      ids: { batchId: b.batchId, senderBatchId },
      status: b.status,
    }),
    "Could not create the payout",
  ).catch((e) => {
    throw paypalFailure("create the payout", e);
  });

  const at = svc.now().toISOString();
  const res = await svc.db.payouts.update(reportId, (cur) =>
    cur && !cur.batchId ? { ...cur, batchId: batch.batchId, batchStatus: batch.status, status: "PENDING", ...(batch.replayed ? { replayed: true } : {}), updatedAt: at } : KEEP,
  );
  return (res.value ?? payout) as PayoutRecord;
}
