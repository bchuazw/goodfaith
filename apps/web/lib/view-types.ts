/**
 * What the API and the pages send to the browser. Built server-side from the stored records
 * (lib/server/views.ts); the researcher's view masks the payout address and drops maintainer-only notes.
 */
import type { HttpPoc, Severity, TriageEvent, TriageVerdict } from "@goodfaith/core";
import type { Money } from "./money";

export type DepositStatus = "CREATED" | "APPROVED" | "AUTHORIZED" | "VOIDING" | "VOIDED" | "CAPTURING" | "CAPTURED" | "FAILED";
export type ReportStatus = "awaiting_deposit" | "queued" | "triaging" | "triaged" | "settled" | "triage_failed";
export type SettlementAction = "pay" | "release" | "capture";

export type DepositView = {
  status: DepositStatus;
  amount: Money;
  orderId: string;
  source: "buyer" | "vault";
  authorizationId?: string;
  captureId?: string;
  captureStatus?: string;
  honorUntil?: string;
  authorizationExpiresAt?: string;
  payer?: string;
  createdAt: string;
  approvedAt?: string;
  authorizedAt?: string;
  voidedAt?: string;
  capturedAt?: string;
  lastError?: { code: string; message: string; debugId?: string; at: string };
  dispute?: { id: string; status: string; reason?: string; updatedAt: string };
};

export type PayoutView = {
  status: string;
  amount: Money;
  severity: Severity;
  senderBatchId: string;
  receiver: string;
  batchId?: string;
  batchStatus?: string;
  itemId?: string;
  transactionId?: string;
  fee?: Money;
  error?: { name: string; message?: string };
  replayed?: boolean;
  createdAt: string;
  completedAt?: string;
};

export type SettlementView = {
  action: SettlementAction;
  status: "in_progress" | "done" | "failed";
  actor: string;
  startedAt: string;
  completedAt?: string;
  severity?: Severity;
  amount?: Money;
  overrideReason?: string;
  note?: string;
  error?: { code: string; message: string; debugId?: string };
};

export type ActionOption = { allowed: boolean; reason?: string; needs?: "override" | "confirm" };

export type LedgerLine = {
  at: string;
  op: string;
  ok: boolean;
  summary: string;
  ids?: Record<string, string>;
  status?: string;
  error?: { name: string; issue?: string; debugId?: string; message: string };
};

export type ReportView = {
  id: string;
  programId: string;
  kind: "free" | "bounty";
  title: string;
  body: string;
  claimedVersion?: string;
  claimedSeverity?: Severity;
  poc?: HttpPoc;
  reporter: { handle: string; trusted?: boolean };
  submittedAt: string;
  status: ReportStatus;
  queuedAt?: string;
  triage?: { attempt: number; startedAt?: string; finishedAt?: string; error?: string; engine?: "triage" | "fixture" };
  settlement?: SettlementView;
  deposit?: DepositView;
  payout?: PayoutView;
  verdict?: TriageVerdict;
  demoScenario?: string;
  audience: "researcher" | "maintainer";
  /** Maintainer view only. */
  payoutEmail?: string;
  options?: Record<SettlementAction, ActionOption>;
  ledger?: LedgerLine[];
  codeEvidence?: CodeEvidence[];
};

/** A code-reference check with the source it points at (maintainer view). */
export type CodeEvidence = {
  status: "pass" | "fail" | "inconclusive";
  title: string;
  detail: string;
  version?: string;
  path?: string;
  symbol?: string;
  line?: number;
  nearMatch?: string;
  snippet?: { startLine: number; lines: string[]; highlight?: number };
};

export type QueueRow = {
  id: string;
  title: string;
  handle: string;
  kind: "free" | "bounty";
  status: ReportStatus;
  verdict?: TriageVerdict["verdict"];
  confidence?: number;
  /** The verdict came from the deterministic checks alone: the AI was unavailable. */
  aiUnavailable?: boolean;
  severity?: Severity;
  claimedSeverity?: Severity;
  submittedAt: string;
  triageMs?: number;
  depositStatus?: DepositStatus;
  depositAmount?: Money;
  payoutStatus?: string;
  payoutAmount?: Money;
  settlement?: { action: SettlementAction; status: string };
  demoScenario?: string;
};

/** One SSE frame's payload, as the status page and console consume it. */
export type StreamTriageEvent = { seq: number; attempt: number; event: TriageEvent };

export type ModeView = {
  app: "mock" | "live";
  paypal: "mock" | "sandbox" | "live";
  llm: { provider: string; model: string; fallbacks?: Array<{ provider: string; model: string }> };
  triage: "triage" | "fixture";
  store: string;
  mocks: string[];
};
