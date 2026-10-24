/**
 * Everything a request needs, wired once per instance: the Store, PayPal, the LLM, the triage engine,
 * the Lantern target and the program. It holds no state of its own beyond caches; the Store is the
 * only shared truth, so any instance can serve any request.
 */
import type { CodeSource, TargetRunner } from "@goodfaith/core";
import type { Llm } from "@goodfaith/llm";
import { isMockPayPal, type PayPalClient } from "@goodfaith/paypal";
import { createLanternRunner, LANTERN_PROGRAM, lanternCodeSource } from "@goodfaith/target";
import type { AppMode } from "./mode";
import { createReportSignals, type ReportSignals } from "./signals";
import { type Db, openDb, type ProgramRecord, type Store } from "./store";
import type { TriageEngine } from "./triage-engine";

export type ModeInfo = {
  app: AppMode;
  paypal: "mock" | "sandbox" | "live";
  llm: { provider: string; model: string };
  triage: TriageEngine["kind"];
  store: string;
  /** What is simulated right now, for the MOCK badge. Empty means nothing is. */
  mocks: string[];
};

export type ServicesConfig = {
  /** Origin used in PayPal return URLs when a request cannot tell (GOODFAITH_PUBLIC_URL). */
  publicUrl?: string;
  /** Hostnames bound to JS SDK v6 client tokens (PAYPAL_CLIENT_TOKEN_DOMAINS). */
  clientTokenDomains?: string[];
  /** Judge mode in live mode posts deposits from this vaulted sandbox wallet (PAYPAL_SANDBOX_VAULT_ID). */
  sandboxVaultId?: string;
  /** Live webhooks verify against this id (PAYPAL_WEBHOOK_ID); the mock signs for its own. */
  webhookId?: string;
  /** Hard limit for one triage run, inside the 300 s function budget. */
  triageTimeoutMs: number;
  /** A triage claim older than this is treated as abandoned (its instance died). */
  triageStaleMs: number;
  /** Optional maintainer token: when set, settlement needs it (GOODFAITH_MAINTAINER_TOKEN). */
  maintainerToken?: string;
};

export type Services = {
  mode: ModeInfo;
  db: Db;
  paypal: PayPalClient;
  llm: Llm;
  triage: TriageEngine;
  code: CodeSource;
  target: TargetRunner;
  program: ProgramRecord;
  config: ServicesConfig;
  now: () => Date;
  /** Runs work after the response is sent (Next's `after()` in routes; tests run or collect it). */
  defer: (task: () => Promise<void>) => void;
  /** Same-instance wake-ups for SSE; an optimization over polling the Store. */
  signals: ReportSignals;
};

export const DEFAULT_CONFIG: ServicesConfig = { triageTimeoutMs: 240_000, triageStaleMs: 290_000 };

export function lanternProgram(): ProgramRecord {
  return {
    ...LANTERN_PROGRAM,
    versionsInScope: [...LANTERN_PROGRAM.versionsInScope],
    accounts: LANTERN_PROGRAM.accounts.map((a) => ({ ...a })),
    bounties: { ...LANTERN_PROGRAM.bounties },
    deposit: { ...LANTERN_PROGRAM.deposit },
  };
}

export function createServices(opts: {
  app: AppMode;
  store: Store;
  paypal: PayPalClient;
  llm: Llm;
  triage: TriageEngine;
  code?: CodeSource;
  target?: TargetRunner;
  program?: ProgramRecord;
  config?: Partial<ServicesConfig>;
  now?: () => Date;
  defer?: (task: () => Promise<void>) => void;
  signals?: ReportSignals;
}): Services {
  const paypalMode = isMockPayPal(opts.paypal) ? "mock" : ((opts.paypal as { env?: "sandbox" | "live" }).env ?? "sandbox");
  const mocks: string[] = [];
  if (paypalMode === "mock") mocks.push("PayPal: in-memory mock with a simulated approval sheet");
  if (opts.llm.provider === "scripted") mocks.push("LLM: scripted, deterministic heuristics");
  if (opts.triage.kind === "fixture") mocks.push("Triage: a test fixture engine");
  return {
    mode: { app: opts.app, paypal: paypalMode, llm: { provider: opts.llm.provider, model: opts.llm.model }, triage: opts.triage.kind, store: opts.store.kind, mocks },
    db: openDb(opts.store),
    paypal: opts.paypal,
    llm: opts.llm,
    triage: opts.triage,
    code: opts.code ?? lanternCodeSource(),
    target: opts.target ?? createLanternRunner(),
    program: opts.program ?? lanternProgram(),
    config: { ...DEFAULT_CONFIG, ...opts.config },
    now: opts.now ?? (() => new Date()),
    defer:
      opts.defer ??
      ((task) => {
        void task().catch((e) => console.error(`[goodfaith] background task failed: ${e instanceof Error ? e.message : String(e)}`));
      }),
    signals: opts.signals ?? createReportSignals(),
  };
}
