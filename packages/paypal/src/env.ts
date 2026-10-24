import { createPayPalClient } from "./client.js";
import { createMockPayPal } from "./mock.js";
import type { PayPalClient, PayPalEnv } from "./types.js";

export type PayPalFromEnvOptions = {
  /**
   * Reuse one instance per configuration for the whole process (default true). The mock keeps its
   * state in memory, so every route handler must talk to the same instance; the real client reuses
   * its cached OAuth token. Instances live on globalThis, which also survives Next.js dev reloads.
   */
  shared?: boolean;
};

const REGISTRY = Symbol.for("@goodfaith/paypal/instances");

function registry(): Map<string, PayPalClient> {
  const g = globalThis as unknown as Record<symbol, Map<string, PayPalClient> | undefined>;
  let map = g[REGISTRY];
  if (!map) {
    map = new Map();
    g[REGISTRY] = map;
  }
  return map;
}

function processEnv(): Record<string, string | undefined> {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env ?? {};
}

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/**
 * Chooses the PayPal implementation from environment variables:
 * - PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET present => real client (PAYPAL_ENV: sandbox (default) | live).
 *   Live additionally requires PAYPAL_ALLOW_LIVE=true, so a stray variable can never move real money.
 * - otherwise, or when GOODFAITH_MODE=mock / PAYPAL_MODE=mock => in-memory mock (PAYPAL_MOCK_SEED for
 *   deterministic ids; PAYPAL_MOCK_FAIL_VAULT=true to simulate declined merchant-initiated charges).
 *   GOODFAITH_MODE=live without credentials throws instead of falling back to the mock.
 * Optional: PAYPAL_SANDBOX_BUYER_EMAIL, PAYPAL_PARTNER_ATTRIBUTION_ID, PAYPAL_BRAND_NAME (default "Good Faith": the
 * name on PayPal's vault consent page),
 * PAYPAL_VAULT_STORED_CREDENTIAL=true, PAYPAL_MOCK_WEB_BASE_URL.
 */
/** The brand PayPal shows the buyer when PAYPAL_BRAND_NAME is not set. */
export const DEFAULT_BRAND_NAME = "Good Faith";

export function paypalFromEnv(env?: Record<string, string | undefined>, opts: PayPalFromEnvOptions = {}): PayPalClient {
  const e = env ?? processEnv();
  const shared = opts.shared ?? true;
  const clientId = clean(e.PAYPAL_CLIENT_ID);
  const clientSecret = clean(e.PAYPAL_CLIENT_SECRET);
  const appMode = clean(e.GOODFAITH_MODE)?.toLowerCase();
  const forceMock = appMode === "mock" || clean(e.PAYPAL_MODE)?.toLowerCase() === "mock";
  if (appMode === "live" && !(clientId && clientSecret)) {
    // Never fall back to the mock silently when the app claims to be live (SCOPE: real vs mocked gate).
    throw new Error("GOODFAITH_MODE=live needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  }

  if (clientId && clientSecret && !forceMock) {
    const rawEnv = clean(e.PAYPAL_ENV)?.toLowerCase() ?? "sandbox";
    const paypalEnv: PayPalEnv = rawEnv === "live" || rawEnv === "production" ? "live" : "sandbox";
    if (paypalEnv === "live" && !truthy(e.PAYPAL_ALLOW_LIVE)) {
      throw new Error("PAYPAL_ENV=live needs PAYPAL_ALLOW_LIVE=true: refusing to use live PayPal by accident");
    }
    const brandName = clean(e.PAYPAL_BRAND_NAME) ?? DEFAULT_BRAND_NAME;
    const sandboxBuyerEmail = clean(e.PAYPAL_SANDBOX_BUYER_EMAIL);
    const partnerAttributionId = clean(e.PAYPAL_PARTNER_ATTRIBUTION_ID);
    const vaultStoredCredential = truthy(e.PAYPAL_VAULT_STORED_CREDENTIAL);
    // The secret is deliberately not part of the key (keys could end up in debug output).
    const key = `paypal:${JSON.stringify([paypalEnv, clientId, brandName, sandboxBuyerEmail, partnerAttributionId, vaultStoredCredential])}`;
    const existing = shared ? registry().get(key) : undefined;
    if (existing) return existing;
    const client = createPayPalClient({
      clientId,
      clientSecret,
      env: paypalEnv,
      brandName,
      ...(sandboxBuyerEmail ? { sandboxBuyerEmail } : {}),
      ...(partnerAttributionId ? { partnerAttributionId } : {}),
      vaultStoredCredential,
    });
    if (shared) registry().set(key, client);
    return client;
  }

  const seed = clean(e.PAYPAL_MOCK_SEED);
  const failVaultCharges = truthy(e.PAYPAL_MOCK_FAIL_VAULT);
  const webBaseUrl = clean(e.PAYPAL_MOCK_WEB_BASE_URL);
  const key = `mock:${seed ?? "random"}:${failVaultCharges}:${webBaseUrl ?? ""}`;
  const existing = shared ? registry().get(key) : undefined;
  if (existing) return existing;
  const mock = createMockPayPal({
    ...(seed ? { seed } : {}),
    failVaultCharges,
    ...(webBaseUrl ? { webBaseUrl } : {}),
  });
  if (shared) registry().set(key, mock);
  return mock;
}
