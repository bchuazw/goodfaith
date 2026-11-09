import path from "node:path";
import { Redis } from "@upstash/redis";
import { createFileStore } from "./file";
import { createMemoryStore } from "./memory";
import { createRedisStore, upstashCredentials } from "./redis";
import type { Store } from "./types";

export * from "./db";
export * from "./types";
export { createFileStore } from "./file";
export { createMemoryStore } from "./memory";
export { createRedisStore, type RedisLike, upstashCredentials } from "./redis";

const HOSTED_STORE_MISSING =
  "The hosted store is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN) for Upstash Redis. Vercel's filesystem is read-only, so the file store cannot run there.";

/**
 * Picks the Store adapter.
 * - Upstash Redis whenever its REST credentials are set (KV_REST_API_URL + KV_REST_API_TOKEN from Vercel's
 *   integration, or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Keys live under GOODFAITH_REDIS_PREFIX:
 *   "gf:" in live mode and "gf:mock:" in mock mode by default.
 * - Otherwise `memory` in mock mode (the PayPal mock is in memory too) and `file` in live mode
 *   (`.data/goodfaith-live.json`, or GOODFAITH_DATA_FILE).
 * - GOODFAITH_STORE=memory|file|redis forces one.
 * - On Vercel (VERCEL is set) the file store is never used: without Redis credentials, live mode fails fast
 *   with a clear message instead of writing to the read-only filesystem.
 */
export function storeFromEnv(env: Record<string, string | undefined>, mode: "mock" | "live"): Store {
  const creds = upstashCredentials(env);
  const hosted = Boolean(env.VERCEL?.trim());
  const forced = env.GOODFAITH_STORE?.trim().toLowerCase();
  const kind = forced || (creds ? "redis" : mode === "live" ? "file" : "memory");
  switch (kind) {
    case "memory":
      return createMemoryStore();
    case "file":
      if (hosted) throw new Error(HOSTED_STORE_MISSING);
      return createFileStore(env.GOODFAITH_DATA_FILE?.trim() || path.join(process.cwd(), ".data", `goodfaith-${mode}.json`));
    case "redis": {
      if (!creds) throw new Error(HOSTED_STORE_MISSING);
      const redis = new Redis({ url: creds.url, token: creds.token, automaticDeserialization: false, enableTelemetry: false });
      const prefix = env.GOODFAITH_REDIS_PREFIX?.trim() || (mode === "live" ? "gf:" : "gf:mock:");
      return createRedisStore(redis, { prefix });
    }
    default:
      throw new Error(`GOODFAITH_STORE=${kind} is not supported (use memory, file or redis)`);
  }
}
