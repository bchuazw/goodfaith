// @goodfaith/core: shared domain types and zod schemas. Contract: docs/CONTRACTS.md.
import { z } from "zod";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const POC_LIMITS = { maxSteps: 20, maxPath: 2048, maxBodyBytes: 64 * 1024 } as const;
export const REPORT_LIMITS = { maxTitle: 200, maxBody: 50_000 } as const;

/** Headers the runner owns; a PoC that sets them is rejected rather than silently overridden. */
const RESERVED_HEADERS = new Set(["host", "cookie", "authorization", "content-length", "connection"]);

export const httpPocStepSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .max(POC_LIMITS.maxPath)
    .refine((p) => p.startsWith("/") && !p.startsWith("//"), "must be a target-relative path starting with /"),
  headers: z
    .record(z.string(), z.string())
    .refine((h) => Object.keys(h).every((k) => !RESERVED_HEADERS.has(k.toLowerCase())), "Host, Cookie and Authorization are set by the sandbox")
    .optional(),
  body: z
    .string()
    .refine((b) => new TextEncoder().encode(b).length <= POC_LIMITS.maxBodyBytes, `must be at most ${POC_LIMITS.maxBodyBytes} bytes`)
    .optional(),
  as: z.string().min(1).max(64).optional(),
});
export type HttpPocStep = z.infer<typeof httpPocStepSchema>;

export const httpPocSchema = z.object({ steps: z.array(httpPocStepSchema).min(1).max(POC_LIMITS.maxSteps) });
export type HttpPoc = z.infer<typeof httpPocSchema>;

export const reportInputSchema = z.object({
  id: z.string().min(1).max(64),
  programId: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(REPORT_LIMITS.maxTitle),
  body: z.string().max(REPORT_LIMITS.maxBody),
  claimedVersion: z.string().trim().min(1).max(64).optional(),
  claimedSeverity: z.enum(SEVERITIES).optional(),
  poc: httpPocSchema.optional(),
  reporter: z.object({ handle: z.string().trim().min(1).max(64), trusted: z.boolean().optional() }),
  submittedAt: z.string().datetime(),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

export type CodeLocation = { path: string; line?: number; symbol?: string };

/** Read-only access to a project's source at a version. */
export interface CodeSource {
  readonly id: string;
  /** Tag or commit to a canonical ref; undefined when the version does not exist. */
  resolveVersion(version: string): Promise<string | undefined>;
  listVersions(): Promise<string[]>;
  listFiles(ref: string): Promise<string[]>;
  readFile(path: string, ref: string): Promise<string | undefined>;
  /** Where `name` is defined (function, method, class, const, macro), not mere mentions. */
  findSymbol(name: string, ref: string): Promise<CodeLocation[]>;
}

export type ReplayStep = {
  index: number;
  request: { method: string; path: string; as: string };
  status: number;
  /** At most 2 KiB; canaries are redacted as "[CANARY:<id>]". */
  bodyExcerpt: string;
  durationMs: number;
};

/** A canary is a secret seeded per run; seeing one you were not entitled to is proof of impact. */
export type CanaryHit = { canaryId: string; label: string; owner: string; stepIndex: number };

export type ReplayResult = { targetId: string; version: string; steps: ReplayStep[]; canaryHits: CanaryHit[]; error?: string };

/** Runs a PoC against a fresh, seeded, network-isolated instance of the target at `version`. */
export interface TargetRunner {
  readonly id: string;
  versions(): string[];
  accounts(): Array<{ id: string; description: string }>;
  replay(poc: HttpPoc, version: string, opts?: { signal?: AbortSignal }): Promise<ReplayResult>;
}

export const VERDICTS = ["REPRODUCED", "DUPLICATE", "NEEDS_HUMAN", "SLOP"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type FindingKind = "version" | "code_ref" | "poc" | "duplicate" | "injection" | "consistency" | "severity";

export type Finding = {
  kind: FindingKind;
  status: "pass" | "fail" | "inconclusive";
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
};

export type ExtractedClaims = {
  version?: string;
  vulnClass?: string;
  components: CodeLocation[];
  impact: string;
  preconditions: string[];
  poc?: HttpPoc;
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
  confidence: number;
  summary: string;
  researcherSummary: string;
  findings: Finding[];
  claims: ExtractedClaims;
  suggestedSeverity?: { level: Severity; cvss?: string; rationale: string };
  duplicateOf?: string;
  slopSignals: string[];
  replay?: ReplayResult;
  model: { provider: string; model: string; mode: "live" | "scripted" };
  startedAt: string;
  finishedAt: string;
};

export type TriageStage = "claims" | "version" | "code_refs" | "duplicates" | "replay" | "assess" | "verdict";

export type TriageEvent =
  | { type: "stage"; stage: TriageStage; status: "start" | "done"; note?: string; at: string }
  | { type: "finding"; finding: Finding; at: string }
  | { type: "replay_step"; step: ReplayStep; at: string }
  | { type: "verdict"; verdict: TriageVerdict; at: string };

const codeLocationSchema = z.object({ path: z.string(), line: z.number().int().positive().optional(), symbol: z.string().optional() });

const findingSchema = z.object({
  kind: z.enum(["version", "code_ref", "poc", "duplicate", "injection", "consistency", "severity"]),
  status: z.enum(["pass", "fail", "inconclusive"]),
  title: z.string(),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

const replayResultSchema = z.object({
  targetId: z.string(),
  version: z.string(),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      request: z.object({ method: z.string(), path: z.string(), as: z.string() }),
      status: z.number().int(),
      bodyExcerpt: z.string(),
      durationMs: z.number().nonnegative(),
    }),
  ),
  canaryHits: z.array(z.object({ canaryId: z.string(), label: z.string(), owner: z.string(), stepIndex: z.number().int().nonnegative() })),
  error: z.string().optional(),
});

export const triageVerdictSchema = z.object({
  reportId: z.string(),
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  researcherSummary: z.string(),
  findings: z.array(findingSchema),
  claims: z.object({
    version: z.string().optional(),
    vulnClass: z.string().optional(),
    components: z.array(codeLocationSchema),
    impact: z.string(),
    preconditions: z.array(z.string()),
    poc: httpPocSchema.optional(),
    severityClaim: z.enum(SEVERITIES).optional(),
  }),
  suggestedSeverity: z.object({ level: z.enum(SEVERITIES), cvss: z.string().optional(), rationale: z.string() }).optional(),
  duplicateOf: z.string().optional(),
  slopSignals: z.array(z.string()),
  replay: replayResultSchema.optional(),
  model: z.object({ provider: z.string(), model: z.string(), mode: z.enum(["live", "scripted"]) }),
  startedAt: z.string(),
  finishedAt: z.string(),
}) satisfies z.ZodType<TriageVerdict>;
