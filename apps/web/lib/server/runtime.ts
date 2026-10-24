/**
 * The per-instance services for route handlers and server components, built from the environment on
 * first use. GOODFAITH_MODE=live fails loudly here (and therefore on every request) when PayPal or the
 * LLM is not configured; it never falls back to a mock.
 */
import "server-only";
import { isMockPayPal } from "@goodfaith/paypal";
import { after } from "next/server";
import { appModeFromEnv, llmForMode, paypalForMode } from "./mode";
import { createServices, type Services } from "./services";
import { storeFromEnv } from "./store";
import { createFixtureTriage } from "./temporary-triage-adapter";
import { handleWebhook } from "./webhooks";

const KEY = Symbol.for("goodfaith.web.services");
const MOCK_HOOK = Symbol.for("goodfaith.web.mockWebhookHook");
type Holder = { [KEY]?: Services; [MOCK_HOOK]?: () => void };

/** Work after the response: Next's after() inside a request; fire-and-forget outside one (mock webhooks). */
function deferAfterResponse(task: () => Promise<void>): void {
  const guarded = () =>
    task().catch((e) => {
      console.error(`[goodfaith] background task failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

function listFromEnv(v: string | undefined): string[] | undefined {
  const items = v?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function build(env: Record<string, string | undefined>): Services {
  const app = appModeFromEnv(env);
  const paypal = paypalForMode(app, env);
  const llm = llmForMode(app, env);
  const svc = createServices({
    app,
    store: storeFromEnv(env, app),
    paypal,
    llm,
    triage: createFixtureTriage(),
    config: {
      ...(env.GOODFAITH_PUBLIC_URL?.trim() ? { publicUrl: env.GOODFAITH_PUBLIC_URL.trim().replace(/\/+$/, "") } : {}),
      ...(listFromEnv(env.PAYPAL_CLIENT_TOKEN_DOMAINS) ? { clientTokenDomains: listFromEnv(env.PAYPAL_CLIENT_TOKEN_DOMAINS) as string[] } : {}),
      ...(env.PAYPAL_SANDBOX_VAULT_ID?.trim() ? { sandboxVaultId: env.PAYPAL_SANDBOX_VAULT_ID.trim() } : {}),
      ...(env.PAYPAL_WEBHOOK_ID?.trim() ? { webhookId: env.PAYPAL_WEBHOOK_ID.trim() } : {}),
      ...(env.GOODFAITH_MAINTAINER_TOKEN?.trim() ? { maintainerToken: env.GOODFAITH_MAINTAINER_TOKEN.trim() } : {}),
    },
    defer: deferAfterResponse,
  });

  if (isMockPayPal(paypal)) {
    // The mock delivers its webhooks in-process; run them through the same verified handler a real
    // delivery to POST /api/paypal/webhooks takes. One listener per mock instance, even across reloads.
    const g = globalThis as Holder;
    g[MOCK_HOOK]?.();
    g[MOCK_HOOK] = paypal.onWebhook(async (d) => {
      const current = (globalThis as Holder)[KEY];
      if (current) await handleWebhook(current, { headers: d.headers, body: d.body });
    });
  }
  return svc;
}

export function getServices(): Services {
  const g = globalThis as Holder;
  g[KEY] ??= build(process.env);
  return g[KEY];
}

/** Judge-mode reset in mock mode: a fresh store; the PayPal mock keeps its (random-id) history. */
export async function resetMockData(): Promise<void> {
  const svc = getServices();
  if (svc.mode.app !== "mock") throw new Error("Reset is only available in mock mode");
  await svc.db.store.reset();
}
