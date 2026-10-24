/**
 * Records the web app persists, and the small Store interface every adapter implements.
 *
 * The Store is the only shared state: on serverless hosting each request may land on a different
 * instance, so nothing correctness-critical lives in process memory. Values are plain JSON. Writes that
 * guard money use compare-and-set on a per-document version, and triage events go to an append-only list
 * per report. That is all a hosted adapter (Redis, Postgres) has to provide.
 *
 * Money is always a PayPal-style decimal string ({ currency: "USD", value: "20.00" }), never a float.
 */
import type { ReportInput, Severity, TriageEvent } from "@goodfaith/core";
import type { Money } from "@goodfaith/paypal";

export type { Money };

// ---------------------------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------------------------

export const COLLECTIONS = ["programs", "reports", "deposits", "payouts", "verdicts", "fundings", "webhooks"] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** A stored JSON document and its version (1 after the first write, +1 per write). */
export type Doc<T> = { id: string; version: number; value: T };

/** A compare-and-set write lost a race: re-read and decide again. */
export class StoreConflictError extends Error {
  readonly code = "STORE_CONFLICT";
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${collection}/${id}: expected version ${expected}, found ${actual}`);
    this.name = "StoreConflictError";
  }
}

export interface Store {
  /** "memory" | "file", or the hosted adapter's name. */
  readonly kind: string;
  get<T>(collection: CollectionName, id: string): Promise<Doc<T> | undefined>;
  /** Every document in a collection, in no particular order. */
  list<T>(collection: CollectionName): Promise<Doc<T>[]>;
  /**
   * Writes a JSON document and returns its new version. With `ifVersion` the write is a compare-and-set:
   * it succeeds only when the stored version equals `ifVersion` (0 means "must not exist yet"), and
   * otherwise throws StoreConflictError without writing.
   */
  put<T>(collection: CollectionName, id: string, value: T, opts?: { ifVersion?: number }): Promise<number>;
  delete(collection: CollectionName, id: string): Promise<void>;
  /** Appends to an append-only list and returns the entry's sequence number: 1, 2, 3, ... per list. */
  append<T>(list: string, value: T): Promise<number>;
  /** Entries with seq > afterSeq (default 0), oldest first, at most `limit`. */
  read<T>(list: string, afterSeq?: number, limit?: number): Promise<Array<{ seq: number; value: T }>>;
  /** Drops everything (tests, and the judge-mode reset in mock mode). */
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export type ProgramAccount = { id: string; description: string };

/** A bug-bounty program (the shape of `LANTERN_PROGRAM` from @goodfaith/target). */
export type ProgramRecord = {
  id: string;
  name: string;
  tagline: string;
  repo: string;
  versionsInScope: string[];
  accounts: ProgramAccount[];
  bounties: Record<Severity, Money>;
  deposit: Money;
  trustAfterVerified: number;
};

export type ReportKind = "free" | "bounty";

/**
 * awaiting_deposit: a bounty claim whose deposit is not authorized yet (triage has not started).
 * queued -> triaging -> triaged: the triage run. settled: the maintainer paid, released or captured.
 * triage_failed: the run errored or timed out; a maintainer can re-run it.
 */
export type ReportStatus = "awaiting_deposit" | "queued" | "triaging" | "triaged" | "settled" | "triage_failed";

export type SettlementAction = "pay" | "release" | "capture";

export type SettlementRecord = {
  action: SettlementAction;
  /** in_progress survives a crash between PayPal calls: retrying the same action resumes it idempotently. */
  status: "in_progress" | "done" | "failed";
  actor: string;
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string; debugId?: string };
  /** pay: the severity the bounty was paid at. */
  severity?: Severity;
  /** pay: the bounty. capture: the deposit. */
  amount?: Money;
  /** pay without a REPRODUCED verdict: the maintainer's typed reason. */
  overrideReason?: string;
  /** release: an optional note for the researcher. */
  note?: string;
};

export type TriageRun = {
  /** 1 for the first run; a maintainer re-run increments it. Events carry the attempt they belong to. */
  attempt: number;
  /** Set when an instance claims the run; a claim older than the triage time limit counts as abandoned. */
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  engine?: "triage" | "fixture";
};

export type ReportRecord = {
  id: string;
  programId: string;
  kind: ReportKind;
  /** Exactly what the researcher submitted, validated with @goodfaith/core's reportInputSchema. Untrusted. */
  input: ReportInput;
  /** Where a bounty is paid. Falls back to the PayPal account that posted the deposit. */
  payoutEmail?: string;
  status: ReportStatus;
  createdAt: string;
  updatedAt: string;
  /** When triage became due: submission for free reports, deposit authorization for bounty claims. */
  queuedAt?: string;
  triage?: TriageRun;
  settlement?: SettlementRecord;
  /** The judge-mode (/demo) scenario that created the report, if any. */
  demoScenario?: string;
  /**
   * Judge-mode round. Demo reports dedupe only against reports of the same round (and real reports never
   * against demo ones), so judge mode stays repeatable on a shared deployment.
   */
  demoRound?: string;
};

/**
 * CREATED/APPROVED: the AUTHORIZE order exists and waits for (or has) the researcher's approval.
 * AUTHORIZED: the hold is live. VOIDING/CAPTURING: the single permitted resolution is in flight.
 */
export type DepositStatus = "CREATED" | "APPROVED" | "AUTHORIZED" | "VOIDING" | "VOIDED" | "CAPTURING" | "CAPTURED" | "FAILED";

export type DepositRecord = {
  reportId: string;
  amount: Money;
  status: DepositStatus;
  orderId: string;
  /** Incremented when a fresh order replaces one the researcher never approved. */
  orderAttempt: number;
  /** buyer: approved by the researcher in PayPal. vault: judge mode's saved sandbox wallet (no login needed). */
  source: "buyer" | "vault";
  authorizationId?: string;
  authorizationStatus?: string;
  /** PayPal keeps an authorization for 29 days... */
  authorizationExpiresAt?: string;
  /** ...and honours it for 3, so Good Faith promises triage inside that window. */
  honorUntil?: string;
  payerEmail?: string;
  captureId?: string;
  captureStatus?: string;
  /**
   * The one terminal action this deposit may ever see. It is claimed with a compare-and-set before PayPal
   * is called, with a fixed PayPal-Request-Id, so a retry can only repeat the same action and PayPal
   * dedupes it.
   */
  resolution?: { action: "void" | "capture"; requestId: string; claimedAt: string; completedAt?: string };
  lastError?: { code: string; message: string; debugId?: string; at: string };
  dispute?: { id: string; status: string; reason?: string; updatedAt: string };
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  authorizedAt?: string;
  voidedAt?: string;
  capturedAt?: string;
};

export type PayoutRecord = {
  reportId: string;
  /** "gf-" + reportId: PayPal pays a sender_batch_id at most once. */
  senderBatchId: string;
  receiver: string;
  amount: Money;
  severity: Severity;
  /** CREATING until PayPal answers, then PayPal's item status (PENDING, SUCCESS, UNCLAIMED, ...). */
  status: string;
  batchId?: string;
  batchStatus?: string;
  itemId?: string;
  transactionId?: string;
  fee?: Money;
  error?: { name: string; message?: string };
  /** PayPal answered with the batch first created for this sender_batch_id. */
  replayed?: boolean;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
  completedAt?: string;
};

export type FundingRecord = {
  /** The CAPTURE order id. */
  id: string;
  programId: string;
  sponsor: string;
  amount: Money;
  status: "CREATED" | "COMPLETED" | "FAILED";
  captureId?: string;
  captureStatus?: string;
  payerEmail?: string;
  source: "buyer" | "vault";
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
};

export type LedgerOp =
  | "orders.create"
  | "orders.authorize"
  | "orders.capture"
  | "orders.get"
  | "authorizations.void"
  | "authorizations.capture"
  | "payouts.create"
  | "payouts.get"
  | "webhook";

/** One PayPal call (or verified webhook) as the console shows it. No secrets, no request bodies. */
export type LedgerEntry = {
  at: string;
  op: LedgerOp;
  ok: boolean;
  summary: string;
  reportId?: string;
  fundingId?: string;
  ids?: Record<string, string>;
  status?: string;
  error?: { name: string; issue?: string; debugId?: string; message: string };
};

export type WebhookRecord = {
  /** PayPal's event id: the dedupe key. */
  id: string;
  eventType: string;
  resourceType: string;
  resourceId?: string;
  summary: string;
  receivedAt: string;
  /** What the handler did with it. */
  outcome: string;
};

/** One entry of a report's append-only triage event list. */
export type TriageEventEntry = { attempt: number; event: TriageEvent };
