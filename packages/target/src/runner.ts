// The Lantern PoC runner: a sandboxed, in-process TargetRunner.
//
// Every replay() builds a brand-new Lantern instance (fresh users, notes, a virtual filesystem and
// random per-run canary secrets) and drives the supplied HTTP PoC against it with `app.fetch`. There
// are no sockets and no outbound network: the app is a pure request/response function in memory.

import type { CanaryHit, HttpPoc, HttpPocStep, ReplayResult, ReplayStep, TargetRunner } from "@goodfaith/core";
import { createLanternApp as createApp140 } from "../lantern/1.4.0/src/index.js";
import type { AppConfig, Note, Seed, StoredFile, User } from "../lantern/1.4.1/src/index.js";
import { createLanternApp as createApp141 } from "../lantern/1.4.1/src/index.js";

type LanternApp = { fetch: (req: Request) => Response | Promise<Response> };
type Factory = (config: AppConfig) => LanternApp;

const FACTORIES: Record<string, Factory> = {
  "1.4.0": createApp140,
  "1.4.1": createApp141,
};

export const LANTERN_VERSIONS = ["1.4.0", "1.4.1"] as const;
export type LanternVersion = (typeof LANTERN_VERSIONS)[number];

const RESERVED_HEADERS = new Set(["host", "cookie", "authorization", "content-length", "connection"]);
const BASE_URL = "http://lantern.local";

/** The seeded sandbox accounts, with the session token the runner injects for each. */
const ACCOUNTS: Array<{ id: string; description: string; token: string }> = [
  { id: "alice", description: "Alice — the researcher's own test account (a normal user)", token: "gf_sess_alice" },
  { id: "bob", description: "Bob — a second normal user, the victim in access-control tests", token: "gf_sess_bob" },
  { id: "admin", description: "Admin — the Lantern administrator", token: "gf_sess_admin" },
];
const TOKENS = new Map(ACCOUNTS.map((a) => [a.id, a.token]));

type CanarySpec = { id: string; label: string; owner: string; value: string; entitled: Set<string> };

export interface LanternRunnerLimits {
  maxSteps: number;
  timeoutMs: number;
  maxBodyBytes: number;
}

const DEFAULT_LIMITS: LanternRunnerLimits = { maxSteps: 20, timeoutMs: 5000, maxBodyBytes: 64 * 1024 };

export interface LanternRunnerOptions {
  /** Fixed seed for reproducible canaries (e.g. in tests). Omitted → fresh random canaries per run. */
  seed?: string;
  limits?: Partial<LanternRunnerLimits>;
}

export function createLanternRunner(opts: LanternRunnerOptions = {}): TargetRunner {
  const limits: LanternRunnerLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  let counter = 0;

  function canariesFor(): CanarySpec[] {
    // A fresh random stream per replay (unless a fixed seed was given), so "reproduced" is a fact
    // about *this* run: a canary value cannot have been copied from an earlier report.
    const rng = opts.seed ? mulberry32(hashSeed(`${opts.seed}:${counter++}`)) : undefined;
    const mint = (tag: string) => `CANARY-${tag}-${randomHex(rng, 16)}`;
    return [
      { id: "note", label: "Bob's private note", owner: "bob", value: mint("note"), entitled: new Set(["bob", "admin"]) },
      { id: "env", label: "Server secrets.env", owner: "server", value: mint("env"), entitled: new Set() },
      { id: "admin", label: "Admin-only user directory", owner: "admin", value: mint("adm"), entitled: new Set(["admin"]) },
    ];
  }

  function buildConfig(canaries: CanarySpec[]): AppConfig {
    const canary = (id: string) => canaries.find((c) => c.id === id)?.value ?? "";
    const now = "2026-01-01T00:00:00.000Z";
    const users: User[] = [
      { id: "alice", email: "alice@lantern.test", displayName: "Alice", bio: "Researcher test account.", role: "user", backupCode: "bk_alice_0000", createdAt: now },
      { id: "bob", email: "bob@lantern.test", displayName: "Bob", bio: "Keeps private notes.", role: "user", backupCode: canary("admin"), createdAt: now },
      { id: "admin", email: "admin@lantern.test", displayName: "Admin", bio: "Site administrator.", role: "admin", backupCode: "bk_admin_0000", createdAt: now },
    ];
    const notes: Note[] = [
      { id: "note_1", ownerId: "alice", title: "Shopping list", body: "Milk, eggs, coffee.", visibility: "private", updatedAt: now },
      { id: "note_2", ownerId: "bob", title: "Recovery phrase", body: `Bank recovery phrase: ${canary("note")}`, visibility: "private", updatedAt: now },
      { id: "note_3", ownerId: "bob", title: "Weekend plans", body: "Hiking on Saturday.", visibility: "shared", updatedAt: now },
      { id: "note_4", ownerId: "admin", title: "Runbook", body: "Restart the service nightly.", visibility: "private", updatedAt: now },
    ];
    const seed: Seed = {
      users,
      notes,
      attachments: [
        { id: "att_1", noteId: "note_1", ownerId: "alice", filename: "welcome.txt", storedPath: "/srv/lantern/uploads/welcome.txt", contentType: "text/plain", size: 20 },
      ],
    };
    const files: Record<string, string | StoredFile> = {
      "/srv/lantern/uploads/welcome.txt": "Welcome to Lantern!",
      "/srv/lantern/secrets.env": `SESSION_SECRET=${canary("env")}\nSMTP_PASSWORD=hunter2\n`,
    };
    const sessions = ACCOUNTS.map((a) => ({ token: a.token, userId: a.id }));
    return { seed, files, sessions };
  }

  async function replay(poc: HttpPoc, version: string, options?: { signal?: AbortSignal }): Promise<ReplayResult> {
    const factory = FACTORIES[version];
    if (!factory) {
      return { targetId: "lantern", version, steps: [], canaryHits: [], error: `Unknown Lantern version "${version}". Known: ${LANTERN_VERSIONS.join(", ")}.` };
    }
    const validation = validatePoc(poc, limits);
    if (validation) return { targetId: "lantern", version, steps: [], canaryHits: [], error: validation };

    const canaries = canariesFor();
    const app = factory(buildConfig(canaries));
    const steps: ReplayStep[] = [];
    const canaryHits: CanaryHit[] = [];
    const startedAt = Date.now();
    let error: string | undefined;

    for (let i = 0; i < poc.steps.length; i++) {
      const step = poc.steps[i] as HttpPocStep;
      if (options?.signal?.aborted) {
        error = "Replay aborted.";
        break;
      }
      const remaining = limits.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        error = `Replay exceeded the ${limits.timeoutMs} ms time limit.`;
        break;
      }
      const account = step.as && step.as !== "anonymous" ? step.as : "anonymous";
      const stepStart = Date.now();
      try {
        const res = await withDeadline(app.fetch(buildRequest(step, account)), remaining, limits.timeoutMs);
        const raw = await res.text();
        recordCanaries(raw, account, i, canaries, canaryHits);
        steps.push({
          index: i,
          request: { method: step.method, path: step.path, as: account },
          status: res.status,
          bodyExcerpt: redact(raw, canaries).slice(0, 2048),
          durationMs: Date.now() - stepStart,
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
    }

    return { targetId: "lantern", version, steps, canaryHits, ...(error ? { error } : {}) };
  }

  return {
    id: "lantern",
    versions: () => [...LANTERN_VERSIONS],
    accounts: () => ACCOUNTS.map((a) => ({ id: a.id, description: a.description })),
    replay,
  };
}

function buildRequest(step: HttpPocStep, account: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(step.headers ?? {})) headers.set(k, v);
  const token = TOKENS.get(account);
  if (token) headers.set("cookie", `lantern_session=${token}`);
  if (step.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const init: RequestInit = { method: step.method, headers };
  if (step.body !== undefined && step.method !== "GET") init.body = step.body;
  return new Request(`${BASE_URL}${step.path}`, init);
}

function validatePoc(poc: HttpPoc, limits: LanternRunnerLimits): string | undefined {
  if (poc.steps.length === 0) return "The PoC has no steps.";
  if (poc.steps.length > limits.maxSteps) return `The PoC has ${poc.steps.length} steps; the limit is ${limits.maxSteps}.`;
  for (let i = 0; i < poc.steps.length; i++) {
    const step = poc.steps[i] as HttpPocStep;
    if (!step.path.startsWith("/") || step.path.startsWith("//")) {
      return `Step ${i + 1}: path must be a target-relative path starting with "/" (absolute URLs are rejected).`;
    }
    if (/[\r\n]/.test(step.path)) return `Step ${i + 1}: the path contains a line break.`;
    for (const key of Object.keys(step.headers ?? {})) {
      if (RESERVED_HEADERS.has(key.toLowerCase())) return `Step ${i + 1}: header "${key}" is set by the sandbox and may not be supplied by a PoC.`;
    }
    if (step.body !== undefined && byteLength(step.body) > limits.maxBodyBytes) {
      return `Step ${i + 1}: the body is larger than the ${limits.maxBodyBytes}-byte limit.`;
    }
  }
  return undefined;
}

function recordCanaries(text: string, account: string, stepIndex: number, canaries: CanarySpec[], out: CanaryHit[]): void {
  for (const c of canaries) {
    if (c.value && text.includes(c.value) && !c.entitled.has(account)) {
      out.push({ canaryId: c.id, label: c.label, owner: c.owner, stepIndex });
    }
  }
}

function redact(text: string, canaries: CanarySpec[]): string {
  let out = text;
  for (const c of canaries) if (c.value) out = out.split(c.value).join(`[CANARY:${c.id}]`);
  return out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function withDeadline<T>(promise: Promise<T> | T, remaining: number, total: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Replay exceeded the ${total} ms time limit.`)), Math.max(1, remaining));
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- deterministic RNG (used only when a fixed seed is supplied) -----------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randomHex(rng: (() => number) | undefined, bytes: number): string {
  if (rng) {
    let out = "";
    for (let i = 0; i < bytes; i++) out += Math.floor(rng() * 256).toString(16).padStart(2, "0");
    return out;
  }
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
