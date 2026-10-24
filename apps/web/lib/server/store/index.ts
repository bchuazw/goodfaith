import path from "node:path";
import { createFileStore } from "./file";
import { createMemoryStore } from "./memory";
import type { Store } from "./types";

export * from "./db";
export * from "./types";
export { createFileStore } from "./file";
export { createMemoryStore } from "./memory";

/**
 * GOODFAITH_STORE picks the adapter: `memory` (the default in mock mode, where the PayPal mock is in
 * memory too) or `file` (the default in live mode: `.data/goodfaith-live.json`, or GOODFAITH_DATA_FILE).
 * A hosted adapter (Redis, Postgres) plugs in here; it only has to implement the Store interface.
 */
export function storeFromEnv(env: Record<string, string | undefined>, mode: "mock" | "live"): Store {
  const kind = (env.GOODFAITH_STORE?.trim() || (mode === "live" ? "file" : "memory")).toLowerCase();
  switch (kind) {
    case "memory":
      return createMemoryStore();
    case "file":
      return createFileStore(env.GOODFAITH_DATA_FILE?.trim() || path.join(process.cwd(), ".data", `goodfaith-${mode}.json`));
    default:
      throw new Error(`GOODFAITH_STORE=${kind} is not supported here (use memory or file)`);
  }
}
