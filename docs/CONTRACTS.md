# Good Faith: package contracts

These are the interfaces between the packages, written so that people working in parallel never need each other's internals. If a contract changes, update this file in the same commit.

## Rules
- **Packages:**
  - Each package exports TypeScript source from `src/index.ts`: ESM, strict, `noUncheckedIndexedAccess`.
  - Tests use vitest. Lint is biome (`pnpm lint` at the root).
- **No real services:** no package calls a real service in `pnpm test`. Live checks live in `*.live.test.ts`, skipped without credentials.
- **Env access:** only `fromEnv()`-style helpers read `process.env`.
- **Logs:** secrets (PayPal secret, API keys, buyer passwords) never appear in logs, errors or test output.
- **Untrusted input:** everything a researcher submits is untrusted. It is never treated as instructions: prompts use `@goodfaith/llm`'s untrusted-content spotlighting.
- **Dependencies:** add them sparingly, run `pnpm install` at the root, and commit `pnpm-lock.yaml` in the same commit.

## Packages
| Package | Owns |
|---|---|
| `@goodfaith/core` | Domain types and zod schemas shared by everything below. No logic beyond validation. |
| `@goodfaith/paypal` | The PayPal REST client and its mock (copied from the earlier project, verified live). See `docs/PAYPAL_NOTES.md`. |
| `@goodfaith/llm` | Provider-agnostic structured output and tool loops: Anthropic (default `claude-opus-5-5`), Gemini, OpenAI-compatible, and scripted, with an optional fallback chain (`LLM_FALLBACK_PROVIDER`). Calls take `signal` and `onAnswer`. See `docs/LLM_NOTES.md`. |
| `@goodfaith/target` | **Lantern**, the demo target app (versions 1.4.0 vulnerable, 1.4.1 fixed), its `CodeSource`, and the sandboxed in-process `TargetRunner`. |
| `@goodfaith/triage` | The triage engine (`triageReport`), the verdict policy, the GitHub code source, and evals. |
| `apps/web` | The Next.js app: program, report and deposit flow, status page, maintainer console (AG Grid), settlement, webhooks, transparency, judge mode. |

## `@goodfaith/core`

```ts
export type Severity = "low" | "medium" | "high" | "critical";

/** One HTTP request against the sandboxed target. Paths are target-relative: absolute URLs are rejected. */
export type HttpPocStep = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                        // starts with "/", at most 2,048 chars
  headers?: Record<string, string>;    // Host, Cookie and Authorization are set by the runner, never by the PoC
  body?: string;                       // raw body (JSON as a string), at most 64 KiB
  as?: string;                         // sandbox account to act as: "anonymous" (default) or a program account id
};
export type HttpPoc = { steps: HttpPocStep[] };   // 1..20 steps

export type ReportInput = {
  id: string;
  programId: string;
  title: string;                       // at most 200 chars
  body: string;                        // markdown as submitted (untrusted), at most 50k chars
  claimedVersion?: string;
  claimedSeverity?: Severity;
  poc?: HttpPoc;                       // a structured PoC when the form provided one
  reporter: { handle: string; trusted?: boolean };
  submittedAt: string;                 // ISO 8601
};

export type CodeLocation = { path: string; line?: number; symbol?: string };

/** Read-only access to a project's source at a version. */
export interface CodeSource {
  readonly id: string;                                        // "lantern@bundled", "github:curl/curl"
  resolveVersion(version: string): Promise<string | undefined>; // tag or commit -> canonical ref, undefined if unknown
  listVersions(): Promise<string[]>;
  listFiles(ref: string): Promise<string[]>;
  readFile(path: string, ref: string): Promise<string | undefined>;
  /** Where `name` is *defined* (function, method, class, const, macro), not mere mentions. */
  findSymbol(name: string, ref: string): Promise<CodeLocation[]>;
}

export type ReplayStep = {
  index: number;
  request: { method: string; path: string; as: string };
  status: number;
  bodyExcerpt: string;                 // at most 2 KiB, canaries redacted as "[CANARY:<id>]"
  durationMs: number;
};
/** A canary is a secret seeded per run. Seeing one you were not entitled to is proof of impact. */
export type CanaryHit = { canaryId: string; label: string; owner: string; stepIndex: number };
export type ReplayResult = { targetId: string; version: string; steps: ReplayStep[]; canaryHits: CanaryHit[]; error?: string };

/** Runs a PoC against a fresh, seeded, network-isolated instance of the target at `version`. */
export interface TargetRunner {
  readonly id: string;
  versions(): string[];
  accounts(): Array<{ id: string; description: string }>;
  replay(poc: HttpPoc, version: string, opts?: { signal?: AbortSignal }): Promise<ReplayResult>;
}

export type Verdict = "REPRODUCED" | "DUPLICATE" | "NEEDS_HUMAN" | "SLOP";
export type FindingKind = "version" | "code_ref" | "poc" | "duplicate" | "injection" | "consistency" | "severity";
export type Finding = {
  kind: FindingKind;
  status: "pass" | "fail" | "inconclusive";
  title: string;                       // "Function lantern_session_rehydrate() does not exist in 1.4.0"
  detail: string;
  evidence?: Record<string, unknown>;
};

export type ExtractedClaims = {
  version?: string;
  vulnClass?: string;                  // "CWE-639 Authorization Bypass Through User-Controlled Key"
  components: CodeLocation[];
  impact: string;
  preconditions: string[];
  poc?: HttpPoc;                       // parsed from free text when the form gave none
  severityClaim?: Severity;
};

export type PriorReport = {
  id: string;
  title: string;
  summary: string;
  vulnClass?: string;
  components: CodeLocation[];
  verdict: Verdict;
  reportedAt: string;
};

export type TriageVerdict = {
  reportId: string;
  verdict: Verdict;
  confidence: number;                  // 0..1
  summary: string;                     // maintainer-facing, plain English, 2-4 sentences
  researcherSummary: string;           // safe to show the researcher
  findings: Finding[];
  claims: ExtractedClaims;
  suggestedSeverity?: { level: Severity; cvss?: string; rationale: string };
  duplicateOf?: string;
  slopSignals: string[];
  replay?: ReplayResult;
  model: TriageModel;
  startedAt: string;
  finishedAt: string;
};

/** live: a real model made the judgments (provider/model = the one that answered). scripted: zero-key
 *  heuristics. degraded: the model failed or timed out mid-run, and deterministic stand-ins finished it. */
export type TriageModel = {
  provider: string;
  model: string;
  mode: "live" | "scripted" | "degraded";
  degraded?: { stage: TriageStage; reason: string; checks: string[] };   // where the AI dropped out, why, which checks ran
};

export const TRIAGE_STAGES = ["claims", "version", "code_refs", "duplicates", "replay", "assess", "verdict"] as const;
export type TriageStage = (typeof TRIAGE_STAGES)[number];
export type TriageEvent =
  | { type: "stage"; stage: TriageStage; status: "start" | "done"; note?: string; at: string }
  | { type: "finding"; finding: Finding; at: string }
  | { type: "replay_step"; step: ReplayStep; at: string }
  | { type: "verdict"; verdict: TriageVerdict; at: string };

// zod schemas for runtime validation (the web form, the API and triage all use them):
export const httpPocSchema, reportInputSchema, triageVerdictSchema /* … */;
```

## `@goodfaith/target`

```ts
export const LANTERN_VERSIONS: readonly ["1.4.0", "1.4.1"];
export function createLanternRunner(opts?: { seed?: string; limits?: { maxSteps?: number; timeoutMs?: number; maxBodyBytes?: number } }): TargetRunner;
export function lanternCodeSource(): CodeSource;        // reads the bundled source of each version (real files in the package)
export const LANTERN_PROGRAM: {
  id: "lantern";
  name: "Lantern";
  tagline: string;
  repo: string;                                          // display only, e.g. "lantern-notes/lantern" (fictional)
  versionsInScope: string[];
  accounts: Array<{ id: string; description: string }>;  // e.g. alice (researcher's test account), bob (victim)
  bounties: Record<Severity, { currency: "USD"; value: string }>;
  deposit: { currency: "USD"; value: string };
  trustAfterVerified: number;
};
```
- **Lantern:** a small Hono notes app (users, notes, attachments, admin), two full source copies under `packages/target/lantern/<version>/`.
  - **1.4.0 has three real bugs:**
    - IDOR on `GET /api/notes/:id` (CWE-639);
    - path traversal on attachment download (CWE-22);
    - mass assignment of `role` on `PATCH /api/users/me` (CWE-915).
  - 1.4.1 fixes all three.
- **Runner:**
  - Every `replay` builds a new in-memory instance: a virtual filesystem, seeded users and **random canaries** (Bob's private note, the server's `secrets.env`, the admin-only user list).
  - It runs in-process with no sockets and no outbound network.
  - Limits: at most 20 steps, 64 KiB bodies, 5 s total.
  - `canaryHits` lists every canary that reached an account not entitled to it.

## `@goodfaith/triage`

```ts
export type TriageDeps = { llm: Llm; code: CodeSource; target?: TargetRunner; priorReports?: PriorReport[]; now?: () => Date };
export function triageReport(report: ReportInput, deps: TriageDeps, opts?: { onEvent?: (e: TriageEvent) => void; signal?: AbortSignal; llmBudgetMs?: number }): Promise<TriageVerdict>;
export function decideVerdict(input: PolicyInput): { verdict: Verdict; confidence: number; reasons: string[] };   // pure, unit-tested
export function githubCodeSource(opts: { owner: string; repo: string; token?: string; cacheDir?: string; fetch?: typeof fetch }): CodeSource;
```

**Verdict policy.** It is deterministic and conservative. The LLM supplies evidence and opinions; this code decides.
1. **REPRODUCED:** any canary hit on an in-scope version. A reproduced report can never be SLOP or DUPLICATE-without-review.
2. **DUPLICATE:** same vulnerability class and the same primary component as an earlier REPRODUCED or accepted report, with LLM similarity ≥ 0.8. `duplicateOf` is set.
3. **SLOP:** no reproduction **and** at least one piece of *hard* fabrication evidence:
   - the claimed version does not exist;
   - the primary cited symbol or file does not exist at that version, and no near match exists (an edit distance ≤ 2 is treated as a typo and goes to NEEDS_HUMAN);
   - an instruction aimed at the AI triager inside the report.

   It also needs the LLM's slop assessment ≥ 0.7. LLM opinion alone is never enough, and a heuristic stand-in for it never counts: in degraded mode (`aiUnavailable`) SLOP is impossible.
4. **NEEDS_HUMAN:** everything else.

SLOP and DUPLICATE are recommendations. Money moves only on a maintainer's action.

**Degraded mode.** The first LLM failure in a run (an error, a timeout, a refusal, the LLM budget running out) switches the rest of the run to deterministic stand-ins, the scripted provider's heuristics, so a model that is down costs one call's time. Triage still finishes:
- version check; cited code from the form's "Affected code" section (`affectedCodeComponents`) first, then regex extraction from the body; the prompt-injection scan; duplicates by class and component; and replay of the **structured** PoC only (a PoC written in prose needs the AI).
- A canary hit is still REPRODUCED and a class-and-component duplicate still DUPLICATE; anything that would have been SLOP is NEEDS_HUMAN.
- The verdict says so: `model.mode: "degraded"` with `model.degraded = { stage, reason, checks }`, a finding "AI unavailable: deterministic checks only", a summary that starts "AI unavailable (…)", and a researcher summary that says a maintainer will review. The web UI shows a notice with the reason and the checks that ran, and flags the row in the console queue.

**Cancellation and time limits.** `signal` reaches every LLM call (`structured({ ..., signal })`) and the replay; an abort makes `triageReport` reject (an `AbortError`) and nothing is decided. `llmBudgetMs` caps the wall-clock time of all LLM calls in a run: a call still running when it is used up is cancelled, and triage finishes without waiting for the model. The web app uses 45 s per LLM attempt with one retry (`LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`), a 150 s LLM budget and a 200 s hard limit, after which the run is `triage_failed` and can be re-run.

**Scripted mode** (the zero-key demo) gives the same verdicts on the Lantern demo reports, through heuristics in `@goodfaith/llm`'s scripted provider.

**Evals** (`pnpm --filter @goodfaith/triage eval`):
- Lantern cases: valid reports with PoCs, slop (hallucinated code, wrong versions, injection), duplicates and borderline cases.
- A real-world corpus: curl's publicly disclosed AI-slop reports and real curl CVE reports, checked against the real curl source.
- It prints precision and recall per verdict and **false-SLOP on real reports (target 0)**, and writes `evals/results.json`.

## `apps/web`

**Routes:**
- `/`: the landing page with the story and live stats.
- `/p/lantern`: the program page.
- `/p/lantern/report`: the submit form, either a free report or a bounty claim with a deposit through PayPal JS SDK v6.
- `/r/[id]`: the researcher's status page, with the live triage timeline over SSE.
- `/console` and `/console/r/[id]`: the maintainer console (AG Grid) and report detail with evidence and actions.
- `/demo`: judge mode, with seeded one-click scenarios.

**API routes:**
- `POST /api/reports`
- `POST /api/reports/[id]/deposit` (creates the AUTHORIZE order)
- `POST /api/reports/[id]/deposit/approve` (authorizes the approved order, then starts triage)
- `GET /api/reports/[id]/events` (SSE)
- `POST /api/reports/[id]/settle`, with `{ action: "pay" | "release" | "capture" }`
- `POST /api/sponsor/fund` (a CAPTURE order)
- `POST /api/paypal/webhooks` (signature-verified)

**Store:** a `Store` interface with a memory adapter, a JSON-file adapter (`.data/`, gitignored) for development, and an Upstash Redis adapter for hosting (REST, `@upstash/redis`; compare-and-set is one Lua `EVAL`, so racing instances settle exactly once). Redis is chosen automatically when `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set (key prefix `GOODFAITH_REDIS_PREFIX`, default `gf:` live, `gf:mock:` mock). On Vercel without them, live mode fails fast ("hosted store is not configured") instead of using the read-only filesystem.

**Money rules (enforced server-side, tested):**
- A deposit is voided or captured at most once.
- A payout uses `senderBatchId = "gf-" + reportId`, so it pays once.
- "pay" requires REPRODUCED or a maintainer override with a typed reason.
- "capture" requires SLOP **and** maintainer confirmation.

**Mode:** `GOODFAITH_MODE` is `mock` (the default) or `live`. A visible MOCK badge shows whenever any mock is in use.
