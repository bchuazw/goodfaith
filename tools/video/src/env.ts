/**
 * Paths and secrets for the video pipeline. Secrets come from the monorepo root's .env.local (gitignored)
 * and are only ever passed to the services that need them: nothing here logs a value.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(VIDEO_DIR, "../..");
export const OUT = path.join(VIDEO_DIR, "out");
export const CACHE = path.join(OUT, "cache");
export const RAW = path.join(OUT, "raw");
export const CARDS = path.join(OUT, "cards");
export const SHOTS = path.join(OUT, "screenshots");

let loaded: Record<string, string> | undefined;

/** Root .env.local merged under process.env (process.env wins). */
export function env(): Record<string, string | undefined> {
  if (!loaded) {
    loaded = {};
    for (const name of [".env.local", ".env"]) {
      const file = path.join(REPO_ROOT, name);
      if (!fs.existsSync(file)) continue;
      for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) if (v !== undefined && !(k in loaded)) loaded[k] = v;
    }
  }
  return { ...loaded, ...process.env };
}

/** A required secret; the error names the variable, never its value. */
export function secret(name: string): string {
  const v = env()[name]?.trim();
  if (!v) throw new Error(`${name} is not set (root .env.local or the environment)`);
  return v;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Simple --flag value / --flag parsing. */
export function args(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export const BASE_URL = (): string => {
  const a = args();
  const v = (typeof a.base === "string" ? a.base : undefined) ?? env().VIDEO_BASE_URL ?? "http://localhost:3100";
  return v.replace(/\/+$/, "");
};
