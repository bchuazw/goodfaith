/**
 * Report intake. Free reports stay free and go straight to triage. A bounty claim waits for its
 * refundable deposit, unless the researcher is already trusted (enough verified reports).
 */
import { httpPocSchema, type ReportInput, reportInputSchema, SEVERITIES } from "@goodfaith/core";
import { z } from "zod";
import { AppError } from "./errors";
import { composeReportBody } from "../hero-reports";
import { newReportId } from "./ids";
import type { Services } from "./services";
import type { ReportRecord } from "./store";
import { runTriage } from "./triage";

const handleSchema = z
  .string()
  .trim()
  .transform((h) => h.replace(/^@+/, ""))
  .pipe(z.string().min(2, "Handle must be at least 2 characters").max(64).regex(/^[A-Za-z0-9_.-]+$/, "Handle may use letters, digits, _ . and -"));

export const submitReportSchema = z
  .object({
    programId: z.string().trim().min(1).max(64).default("lantern"),
    kind: z.enum(["free", "bounty"]),
    title: z.string().trim().min(8, "Title must be at least 8 characters").max(200),
    claimedVersion: z.string().trim().min(1).max(64).optional(),
    claimedSeverity: z.enum(SEVERITIES).optional(),
    /** Either a ready markdown body, or the form's sections (composed into one). */
    body: z.string().max(50_000).optional(),
    affectedCode: z.string().max(5_000).optional(),
    description: z.string().max(40_000).optional(),
    impact: z.string().max(5_000).optional(),
    pocNotes: z.string().max(10_000).optional(),
    poc: httpPocSchema.optional(),
    reporter: z.object({ handle: handleSchema }),
    payoutEmail: z.email("Enter a valid PayPal email").max(254).optional(),
    demoScenario: z.string().max(32).optional(),
    demoRound: z.string().regex(/^[a-z0-9-]{4,40}$/).optional(),
  })
  .refine((v) => (v.body ?? v.description ?? "").trim().length >= 20, { message: "Describe the issue in at least 20 characters", path: ["description"] });

export type SubmitReportInput = z.input<typeof submitReportSchema>;

/** Researchers with this many paid, reproduced reports claim bounties without a deposit. */
export async function isTrusted(svc: Services, handle: string): Promise<boolean> {
  const needed = svc.program.trustAfterVerified;
  if (needed <= 0) return true;
  const reports = await svc.db.reports.list();
  const mine = reports.filter((r) => r.input.reporter.handle.toLowerCase() === handle.toLowerCase() && r.settlement?.action === "pay" && r.settlement.status === "done");
  let verified = 0;
  for (const r of mine) {
    if ((await svc.db.verdicts.value(r.id))?.verdict === "REPRODUCED") verified++;
  }
  return verified >= needed;
}

export async function submitReport(svc: Services, raw: unknown): Promise<{ report: ReportRecord; depositRequired: boolean }> {
  const parsed = submitReportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("INVALID_REPORT", issue ? `${issue.path.join(".") || "report"}: ${issue.message}` : "Invalid report", 422, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const v = parsed.data;
  if (v.programId !== svc.program.id) throw new AppError("UNKNOWN_PROGRAM", `No program "${v.programId}"`, 404);

  const id = newReportId();
  const now = svc.now().toISOString();
  const trusted = v.kind === "bounty" && (await isTrusted(svc, v.reporter.handle));
  const body = v.body?.trim()
    ? v.body
    : composeReportBody({ description: v.description ?? "", ...(v.affectedCode ? { affectedCode: v.affectedCode } : {}), ...(v.impact ? { impact: v.impact } : {}), ...(v.pocNotes ? { pocNotes: v.pocNotes } : {}) });

  const input: ReportInput = reportInputSchema.parse({
    id,
    programId: v.programId,
    title: v.title,
    body,
    ...(v.claimedVersion ? { claimedVersion: v.claimedVersion } : {}),
    ...(v.claimedSeverity ? { claimedSeverity: v.claimedSeverity } : {}),
    ...(v.poc ? { poc: v.poc } : {}),
    reporter: { handle: v.reporter.handle, ...(trusted ? { trusted: true } : {}) },
    submittedAt: now,
  });

  const depositRequired = v.kind === "bounty" && !trusted;
  const report: ReportRecord = {
    id,
    programId: v.programId,
    kind: v.kind,
    input,
    ...(v.payoutEmail ? { payoutEmail: v.payoutEmail } : {}),
    status: depositRequired ? "awaiting_deposit" : "queued",
    createdAt: now,
    updatedAt: now,
    ...(depositRequired ? {} : { queuedAt: now, triage: { attempt: 1 } }),
    ...(v.demoScenario ? { demoScenario: v.demoScenario } : {}),
    ...(v.demoRound ? { demoRound: v.demoRound } : {}),
  };
  await svc.db.reports.create(id, report);
  if (!depositRequired) svc.defer(() => runTriage(svc, id));
  return { report, depositRequired };
}
