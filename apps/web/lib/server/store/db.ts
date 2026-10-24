/**
 * Typed access on top of the generic Store: one repository per collection, plus the two append-only
 * lists (triage events and the PayPal ledger). `update` is the only way money-related records change:
 * a compare-and-set read-modify-write that re-reads and re-decides when another instance won the race.
 */
import type { TriageVerdict } from "@goodfaith/core";
import {
  type CollectionName,
  type DepositRecord,
  type Doc,
  type FundingRecord,
  type LedgerEntry,
  type PayoutRecord,
  type ProgramRecord,
  type ReportRecord,
  type Store,
  StoreConflictError,
  type TriageEventEntry,
  type WebhookRecord,
} from "./types";

/** Returned by an update function to leave the document untouched. */
export const KEEP = Symbol("keep");

export type UpdateResult<T> = { value: T | undefined; version: number; changed: boolean };

export type Repo<T> = {
  get(id: string): Promise<Doc<T> | undefined>;
  value(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  /** Creates the document; throws StoreConflictError if it already exists. */
  create(id: string, value: T): Promise<number>;
  /** Unconditional write, for records nobody races on (programs, webhook log). */
  put(id: string, value: T): Promise<number>;
  /**
   * Compare-and-set read-modify-write. `fn` sees the current value (or undefined) and returns the next
   * value, or KEEP. It must be pure: it re-runs after a lost race, with the newer value.
   */
  update(id: string, fn: (current: T | undefined) => T | typeof KEEP): Promise<UpdateResult<T>>;
  delete(id: string): Promise<void>;
};

const MAX_CAS_ATTEMPTS = 40;
/** Jittered backoff after a lost race, so contenders stop colliding in lockstep. */
const backoff = (attempt: number) => new Promise<void>((r) => setTimeout(r, Math.random() * Math.min(40, 2 ** attempt)));

export function repo<T>(store: Store, collection: CollectionName): Repo<T> {
  return {
    get: (id) => store.get<T>(collection, id),
    value: async (id) => (await store.get<T>(collection, id))?.value,
    list: async () => (await store.list<T>(collection)).map((d) => d.value),
    create: (id, value) => store.put(collection, id, value, { ifVersion: 0 }),
    put: (id, value) => store.put(collection, id, value),
    delete: (id) => store.delete(collection, id),
    async update(id, fn) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const current = await store.get<T>(collection, id);
        const next = fn(current?.value);
        if (next === KEEP) return { value: current?.value, version: current?.version ?? 0, changed: false };
        try {
          const version = await store.put(collection, id, next, { ifVersion: current?.version ?? 0 });
          return { value: next, version, changed: true };
        } catch (e) {
          if (!(e instanceof StoreConflictError)) throw e;
          await backoff(attempt);
        }
      }
      throw new Error(`${collection}/${id}: gave up after ${MAX_CAS_ATTEMPTS} conflicting writes`);
    },
  };
}

export const eventsList = (reportId: string) => `events:${reportId}`;
export const ledgerList = (scope: string) => `ledger:${scope}`;

export function openDb(store: Store) {
  return {
    store,
    programs: repo<ProgramRecord>(store, "programs"),
    reports: repo<ReportRecord>(store, "reports"),
    deposits: repo<DepositRecord>(store, "deposits"),
    payouts: repo<PayoutRecord>(store, "payouts"),
    verdicts: repo<TriageVerdict>(store, "verdicts"),
    fundings: repo<FundingRecord>(store, "fundings"),
    webhooks: repo<WebhookRecord>(store, "webhooks"),
    events: {
      append: (reportId: string, entry: TriageEventEntry) => store.append(eventsList(reportId), entry),
      read: (reportId: string, afterSeq = 0, limit?: number) => store.read<TriageEventEntry>(eventsList(reportId), afterSeq, limit),
    },
    ledger: {
      /** Every entry goes to the report's (or funding's) trail and to the program-wide trail. */
      async append(entry: LedgerEntry, programId: string) {
        const scope = entry.reportId ?? (entry.fundingId ? `funding:${entry.fundingId}` : undefined);
        if (scope) await store.append(ledgerList(scope), entry);
        await store.append(ledgerList(`program:${programId}`), entry);
      },
      read: async (scope: string) => (await store.read<LedgerEntry>(ledgerList(scope))).map((e) => e.value),
    },
  };
}

export type Db = ReturnType<typeof openDb>;
