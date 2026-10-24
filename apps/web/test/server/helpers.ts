import { createLlm } from "@goodfaith/llm";
import { createMockPayPal, type MockPayPal } from "@goodfaith/paypal";
import { triageReport } from "@goodfaith/triage";
import { approveDeposit, createDepositOrder } from "@/lib/server/deposits";
import { HERO_REPORTS, type HeroKey } from "@/lib/hero-reports";
import { submitReport } from "@/lib/server/reports";
import { createServices, type Services } from "@/lib/server/services";
import { createMemoryStore, type Store } from "@/lib/server/store";
import { handleWebhook } from "@/lib/server/webhooks";

export const ORIGIN = "http://localhost:3000";

export type TestEnv = {
  svc: Services;
  paypal: MockPayPal;
  store: Store;
  /** Runs every deferred task (triage, payout polling) until none are left. */
  drain(): Promise<void>;
};

/**
 * Services over a memory store and a seeded PayPal mock. Two TestEnvs built on the same store and mock
 * behave like two serverless instances: shared Store, no shared process state.
 */
export function testEnv(opts: { store?: Store; paypal?: MockPayPal; webhooks?: boolean; now?: () => Date } = {}): TestEnv {
  const store = opts.store ?? createMemoryStore();
  const paypal = opts.paypal ?? createMockPayPal({ seed: `web-${Math.random()}` });
  const pending: Array<() => Promise<void>> = [];
  const svc = createServices({
    app: "mock",
    store,
    paypal,
    llm: createLlm({ provider: "scripted" }),
    triage: { kind: "triage", run: triageReport },
    defer: (task) => {
      pending.push(task);
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (opts.webhooks) paypal.onWebhook((d) => handleWebhook(svc, { headers: d.headers, body: d.body }).then(() => undefined));
  return {
    svc,
    paypal,
    store,
    async drain() {
      for (let guard = 0; pending.length > 0 && guard < 50; guard++) {
        const batch = pending.splice(0);
        await Promise.all(batch.map((t) => t()));
      }
    },
  };
}

export function heroInput(key: HeroKey, kind: "free" | "bounty" = "bounty") {
  const h = HERO_REPORTS[key];
  return {
    programId: "lantern",
    kind,
    title: h.title,
    claimedVersion: h.claimedVersion,
    ...(h.claimedSeverity ? { claimedSeverity: h.claimedSeverity } : {}),
    body: h.body,
    ...(h.poc ? { poc: h.poc } : {}),
    reporter: { handle: h.handle },
  };
}

/** Submits a hero bounty claim, approves its deposit in the mock and runs triage to a verdict. */
export async function triagedClaim(env: TestEnv, key: HeroKey): Promise<string> {
  const { report } = await submitReport(env.svc, heroInput(key));
  const { deposit } = await createDepositOrder(env.svc, report.id, { origin: ORIGIN });
  env.paypal.simulateBuyerApproval(deposit.orderId, { email: HERO_REPORTS[key].payoutEmail });
  await approveDeposit(env.svc, report.id, { orderId: deposit.orderId });
  await env.drain();
  return report.id;
}

export const apiCalls = (paypal: MockPayPal, action: string) => paypal.events().filter((e) => e.kind === "api" && e.action === action);
