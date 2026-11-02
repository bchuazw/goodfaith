// triageReport(): the triage pipeline. Claims → version → code refs → duplicates → replay → assess
// → verdict. Deterministic checks decide the facts; the LLM (live or scripted) supplies claim
// extraction, a slop/severity opinion and a duplicate score. The pure policy in policy.ts decides.

import type {
  CodeLocation,
  ExtractedClaims,
  Finding,
  HttpPoc,
  PriorReport,
  ReplayResult,
  ReportInput,
  Severity,
  TriageEvent,
  TriageStage,
  TriageVerdict,
} from "@goodfaith/core";
import { httpPocStepSchema } from "@goodfaith/core";
import { createLlm, type Llm, LlmError, LlmFallbackError, type StructuredInput } from "@goodfaith/llm";
import type { CodeSource, TargetRunner } from "@goodfaith/core";
import { affectedCodeComponents } from "./affected-code.js";
import { checkCodeRefs, type CodeRefResult, primaryComponentKey } from "./code-refs.js";
import { detectTriageInjection } from "./injection.js";
import { decideVerdict, type PolicyDuplicate } from "./policy.js";
import { ASSESS_SYSTEM, assessUser, CLAIMS_SYSTEM, claimsUser, DUPLICATE_SYSTEM, duplicateUser } from "./prompts.js";
import { type AssessmentOutput, assessmentSchema, type ClaimsOutput, claimsSchema, duplicateSchema } from "./schemas.js";

export interface TriageDeps {
  llm: Llm;
  code: CodeSource;
  target?: TargetRunner;
  priorReports?: PriorReport[];
  now?: () => Date;
}

export interface TriageOptions {
  onEvent?: (e: TriageEvent) => void;
  /**
   * Cancels the run: every LLM call and the replay are aborted, and triageReport rejects with the
   * signal's reason (an Error named "AbortError" when there is none). Nothing is decided after an abort.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock budget for all LLM calls in this run, in ms. A call still running when it is used up is
   * cancelled, and the remaining LLM judgments fall back to their deterministic stand-ins, so the run
   * still finishes. Unset: no budget beyond the LLM's own per-call timeout.
   */
  llmBudgetMs?: number;
}

/** What triageReport rejects with when its signal aborts. */
export function triageAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error(typeof signal.reason === "string" && signal.reason ? signal.reason : "Triage was cancelled");
  e.name = "AbortError";
  return e;
}

export async function triageReport(report: ReportInput, deps: TriageDeps, opts: TriageOptions = {}): Promise<TriageVerdict> {
  const budget = llmBudget(opts.signal, opts.llmBudgetMs);
  try {
    return await runTriage(report, deps, opts, budget.signal);
  } finally {
    budget.dispose();
  }
}

/** A signal for LLM calls: aborts with the run's signal, or when the LLM budget is used up. */
function llmBudget(outer: AbortSignal | undefined, budgetMs: number | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!(typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0)) return { signal: outer, dispose: () => undefined };
  const ctl = new AbortController();
  const onOuter = () => ctl.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error(`the AI time budget (${Math.round(budgetMs / 1000)} s) was used up`)), budgetMs);
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

async function runTriage(report: ReportInput, deps: TriageDeps, opts: TriageOptions, llmSignal: AbortSignal | undefined): Promise<TriageVerdict> {
  const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const startedAt = at();
  const findings: Finding[] = [];
  const slopSignals: string[] = [];
  /** Stops the run once the caller aborts; an LLM failure caused by that abort must not become a verdict. */
  const checkAborted = () => {
    if (opts.signal?.aborted) throw triageAbortError(opts.signal);
  };
  const llmOpts = llmSignal ? { signal: llmSignal } : {};

  const emit = (e: TriageEvent) => opts.onEvent?.(e);
  const stage = (s: TriageStage, status: "start" | "done", note?: string) => emit({ type: "stage", stage: s, status, ...(note ? { note } : {}), at: at() });
  const addFinding = (f: Finding) => {
    findings.push(f);
    emit({ type: "finding", finding: f, at: at() });
  };
  /** The deterministic checks that ran, in plain English (shown when the AI was unavailable). */
  const checks: string[] = [];

  // Every LLM judgment goes through judge(). The first LLM failure (an error, a timeout, the AI budget
  // running out) switches the rest of the run to deterministic stand-ins: degraded mode. A model that is
  // down then costs one call's time, not one per stage, and the run still finishes on the facts.
  let degraded: { stage: TriageStage; reason: string } | undefined;
  /** The model that actually answered (with a fallback chain, not always deps.llm's primary). */
  let answeredBy: { provider: string; model: string } | undefined;
  const standIn = createLlm({ provider: "scripted" });
  async function judge<T>(where: TriageStage, input: StructuredInput<T>, lastResort: T): Promise<{ value: T; byAi: boolean }> {
    if (!degraded) {
      try {
        const value = await deps.llm.structured({ ...input, ...llmOpts, onAnswer: (by) => (answeredBy = by) });
        return { value, byAi: true };
      } catch (e) {
        checkAborted();
        degraded = { stage: where, reason: describeLlmFailure(e) };
        addFinding(
          mk(
            "consistency",
            "inconclusive",
            "AI unavailable: deterministic checks only",
            `${degraded.reason}. Triage continued without the AI: the version, the cited code, a prompt-injection scan, duplicates by class and component, and a replay of the structured PoC. Without the AI's assessment the verdict cannot be SLOP; a maintainer decides.`,
            { stage: where, reason: degraded.reason },
          ),
        );
      }
    }
    try {
      return { value: await standIn.structured(input), byAi: false };
    } catch {
      return { value: lastResort, byAi: false };
    }
  }
  const aiNote = (s: TriageStage) => (degraded?.stage === s ? "AI unavailable; continuing with deterministic checks" : undefined);

  // --- 1. claims --------------------------------------------------------------------------------
  checkAborted();
  stage("claims", "start");
  const claimsRes = await judge("claims", { system: CLAIMS_SYSTEM, user: claimsUser(report), schema: claimsSchema, name: "triage_claims" }, EMPTY_CLAIMS);
  const claimsOut: ClaimsOutput = claimsRes.value;
  // Without the AI, the form's "Affected code" field is the most reliable citation, so it leads.
  const fromForm = claimsRes.byAi ? [] : affectedCodeComponents(report.body);
  const version = (report.claimedVersion ?? claimsOut.version)?.trim() || undefined;
  const vulnClass = claimsOut.vulnClass;
  const components = dedupeComponents([...fromForm, ...claimsOut.components]);
  const severityClaim = report.claimedSeverity ?? claimsOut.severityClaim;
  stage("claims", "done", aiNote("claims") ?? (vulnClass ? `${vulnClass}${version ? ` in ${version}` : ""}` : "claims extracted"));

  // --- 2. version -------------------------------------------------------------------------------
  checkAborted();
  stage("version", "start");
  const resolvedRef = version ? await deps.code.resolveVersion(version) : undefined;
  const versionProvided = Boolean(version);
  const versionResolves = Boolean(resolvedRef);
  const versionInScope = versionResolves;
  checks.push(!versionProvided ? "Version: none given" : versionResolves ? `Version: ${version} exists and is in scope` : `Version: ${version} does not exist`);
  if (!versionProvided) {
    addFinding(mk("version", "inconclusive", "No version was specified", "The report does not name a version, so scope and code references cannot be checked against one."));
  } else if (versionResolves) {
    addFinding(mk("version", "pass", `Version ${version} is in scope`, `The project has ${version}.`, { version, ref: resolvedRef }));
  } else {
    addFinding(mk("version", "fail", `Version ${version} does not exist`, `The project has no version ${version}.`, { version }));
    slopSignals.push(`The claimed version ${version} does not exist in the project.`);
  }
  stage("version", "done");

  // --- 3. code references -----------------------------------------------------------------------
  checkAborted();
  stage("code_refs", "start");
  let codeRefs: CodeRefResult = { findings: [], hardFailure: false, nearMatchOnly: false };
  if (resolvedRef && components.length > 0) {
    codeRefs = await checkCodeRefs(components, resolvedRef, deps.code);
    for (const f of codeRefs.findings) addFinding(f);
  } else if (components.length > 0 && !resolvedRef) {
    addFinding(mk("code_ref", "inconclusive", "Cannot check code references", "No resolvable version, so the cited files and functions cannot be verified."));
  } else {
    addFinding(mk("code_ref", "inconclusive", "No specific code was cited", "The report cites no file or function to verify."));
  }
  for (const f of codeRefs.findings) {
    if (f.status === "fail") slopSignals.push(f.title);
  }
  const formNote = fromForm.length > 0 ? ` (${fromForm.length} from the Affected code field)` : "";
  checks.push(
    components.length === 0
      ? "Cited code: nothing specific was cited"
      : resolvedRef
        ? `Cited code: ${components.length} reference(s)${formNote} checked at ${resolvedRef}, ${codeRefs.findings.filter((f) => f.status === "pass").length} found`
        : `Cited code: ${components.length} reference(s)${formNote}, not checkable without a valid version`,
  );

  // Injection detection is deterministic and part of the integrity checks.
  const injectionSignals = detectTriageInjection(report.body);
  const injectionDetected = injectionSignals.length > 0;
  if (injectionDetected) {
    const quote = injectionSignals[0]?.quote ?? "";
    addFinding(mk("injection", "fail", "The report contains an instruction aimed at the AI triager", `Found ${injectionSignals.length} prompt-injection signal(s). This is a hard slop signal and never counts in the reporter's favour.`, { signals: injectionSignals }));
    slopSignals.push(`Contains an instruction aimed at the AI triager: "${quote}".`);
  }
  checks.push(injectionDetected ? `Prompt-injection scan: ${injectionSignals.length} instruction(s) aimed at the triager` : "Prompt-injection scan: none found");
  stage("code_refs", "done");

  // --- 4. duplicates ----------------------------------------------------------------------------
  checkAborted();
  stage("duplicates", "start");
  const primaryComp = primaryComponentKey(components);
  const candidates = (deps.priorReports ?? []).filter((p) => p.verdict === "REPRODUCED");
  let duplicate: PolicyDuplicate | undefined;
  let duplicateOf: string | undefined;
  if (candidates.length > 0) {
    const dupRes = await judge(
      "duplicates",
      {
        system: DUPLICATE_SYSTEM,
        user: duplicateUser({ vulnClass, component: primaryComp, title: report.title, summary: claimsOut.impact }, candidates),
        schema: duplicateSchema,
        name: "triage_duplicate",
      },
      { matches: [] },
    );
    const matches = dupRes.value.matches;
    const scored = candidates
      .map((c) => ({
        prior: c,
        similarity: matches.find((m) => m.priorId === c.id)?.similarity ?? 0,
        sameCC: isSameClassAndComponent(vulnClass, primaryComp, c),
      }))
      .sort((a, b) => Number(b.sameCC) - Number(a.sameCC) || b.similarity - a.similarity);
    const best = scored[0];
    if (best) {
      duplicate = { ofId: best.prior.id, similarity: best.similarity, sameClassAndComponent: best.sameCC, priorAccepted: true };
      const strong = best.sameCC && best.similarity >= 0.8;
      if (strong) duplicateOf = best.prior.id;
      addFinding(
        mk(
          "duplicate",
          strong ? "pass" : "inconclusive",
          strong ? `Duplicate of ${best.prior.id}` : `Resembles ${best.prior.id}`,
          `Similarity ${best.similarity.toFixed(2)}; same class and component: ${best.sameCC}.`,
          { ofId: best.prior.id, similarity: best.similarity, sameClassAndComponent: best.sameCC },
        ),
      );
    }
  }
  checks.push(
    candidates.length === 0
      ? "Duplicates: no earlier accepted reports to compare with"
      : `Duplicates: compared with ${candidates.length} earlier accepted report(s) by class and component${duplicateOf ? `; duplicate of ${duplicateOf}` : ""}`,
  );
  stage("duplicates", "done", aiNote("duplicates"));

  // --- 5. replay --------------------------------------------------------------------------------
  checkAborted();
  stage("replay", "start");
  // A PoC parsed from free text needs the AI; without it only the form's structured PoC is replayed.
  const poc = toStrictPoc(report.poc ?? (claimsRes.byAi ? toCorePoc(claimsOut.poc) : undefined));
  let replay: ReplayResult | undefined;
  let canaryHit = false;
  if (duplicateOf) {
    addFinding(mk("poc", "inconclusive", "Skipped replay (duplicate)", `Treated as a duplicate of ${duplicateOf}; not replayed so the bounty is not paid twice.`));
  } else if (!deps.target) {
    addFinding(mk("poc", "inconclusive", "No sandbox available", "No target runner was provided, so the PoC was not replayed."));
  } else if (!resolvedRef) {
    addFinding(mk("poc", "inconclusive", "No resolvable version to replay against", "The PoC was not replayed because the version could not be resolved."));
  } else if (!poc) {
    addFinding(
      claimsRes.byAi || !claimsOut.poc
        ? mk("poc", "inconclusive", "No runnable PoC", "The report contains no HTTP proof of concept to replay.")
        : mk("poc", "inconclusive", "Free-text PoC not replayed (AI unavailable)", "The report describes its PoC in prose. Turning prose into requests needs the AI, which was unavailable; a structured PoC from the form would have been replayed."),
    );
  } else {
    replay = await deps.target.replay(poc, resolvedRef, opts.signal ? { signal: opts.signal } : undefined);
    checkAborted();
    for (const step of replay.steps) emit({ type: "replay_step", step, at: at() });
    canaryHit = replay.canaryHits.length > 0;
    if (canaryHit) {
      const labels = [...new Set(replay.canaryHits.map((h) => h.label))].join(", ");
      addFinding(mk("poc", "pass", "The PoC reproduced in the sandbox", `A seeded canary (${labels}) reached an account not entitled to it.`, { canaryHits: replay.canaryHits }));
    } else if (replay.error) {
      addFinding(mk("poc", "inconclusive", "The PoC could not be replayed", replay.error, { error: replay.error }));
    } else {
      addFinding(mk("poc", "fail", "The PoC did not reproduce", "No seeded canary leaked when the PoC ran against the sandbox at this version.", { steps: replay.steps.length }));
    }
  }
  checks.push(
    replay
      ? `Replay: ${report.poc ? "the structured PoC" : "the PoC"} ran in the sandbox (${replay.steps.length} step(s)) and ${canaryHit ? "leaked a seeded canary: reproduced" : replay.error ? `could not complete (${replay.error})` : "did not reproduce"}`
      : duplicateOf
        ? "Replay: skipped (duplicate)"
        : poc
          ? "Replay: not run (no sandbox or no valid version)"
          : "Replay: no structured PoC to run",
  );
  stage("replay", "done");

  // --- 6. assessment ----------------------------------------------------------------------------
  checkAborted();
  stage("assess", "start");
  const impossibleImpact = computeImpossibleImpact(report.body, vulnClass, canaryHit);
  const ev = {
    versionExists: versionResolves,
    versionInScope,
    claimedVersionInvalid: versionProvided && !versionResolves,
    hardCodeRefFailure: codeRefs.hardFailure,
    nearMatchOnly: codeRefs.nearMatchOnly,
    injectionDetected,
    canaryHit,
    impossibleImpact,
    vulnClass,
    claimedSeverity: severityClaim,
  };
  const lastResortScore = canaryHit ? 0.02 : ev.claimedVersionInvalid || ev.hardCodeRefFailure || injectionDetected ? 0.85 : 0.2;
  const assessRes = await judge(
    "assess",
    { system: ASSESS_SYSTEM, user: assessUser(report, claimsOut, ev), schema: assessmentSchema, name: "triage_assessment" },
    { slopScore: lastResortScore, slopReasons: [], injectionSuspected: injectionDetected },
  );
  const assessment: AssessmentOutput = assessRes.value;
  const aiUnavailable = degraded !== undefined;
  if (impossibleImpact) slopSignals.push("The claimed impact (code execution / takeover) is inconsistent with the cited code.");
  addFinding(
    aiUnavailable
      ? mk(
          "severity",
          canaryHit ? "pass" : "inconclusive",
          `Heuristic slop score ${assessment.slopScore.toFixed(2)} (AI unavailable)`,
          `${assessment.slopReasons.join(" ") || "Scored by rule."} Without the AI's own assessment this score cannot make the report SLOP.`,
          { slopScore: assessment.slopScore, heuristic: true },
        )
      : mk("severity", canaryHit ? "pass" : "inconclusive", `Slop assessment ${assessment.slopScore.toFixed(2)}`, assessment.slopReasons.join(" ") || "Assessment complete.", { slopScore: assessment.slopScore }),
  );
  stage("assess", "done", aiNote("assess"));

  // --- 7. verdict -------------------------------------------------------------------------------
  checkAborted();
  stage("verdict", "start");
  const decision = decideVerdict({
    versionProvided,
    versionResolves,
    canaryHit,
    hardCodeRefFailure: codeRefs.hardFailure,
    injectionDetected,
    slopScore: assessment.slopScore,
    duplicate,
    aiUnavailable,
  });

  const suggestedSeverity = buildSeverity(assessment, decision.verdict, aiUnavailable);
  const claims: ExtractedClaims = {
    ...(version ? { version } : {}),
    ...(vulnClass ? { vulnClass } : {}),
    components,
    impact: claimsOut.impact,
    preconditions: claimsOut.preconditions,
    ...(poc ? { poc } : {}),
    ...(severityClaim ? { severityClaim } : {}),
  };

  const verdict: TriageVerdict = {
    reportId: report.id,
    verdict: decision.verdict,
    confidence: decision.confidence,
    summary: `${degraded ? `AI unavailable (${degraded.reason}), so only the deterministic checks ran. ` : ""}${maintainerSummary(decision.verdict, decision.reasons, { version, suggestedSeverity, duplicateOf, canaryHit, replay })}`,
    researcherSummary: researcherSummary(decision.verdict, { suggestedSeverity, duplicateOf, aiUnavailable }),
    findings,
    claims,
    ...(suggestedSeverity ? { suggestedSeverity } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    slopSignals,
    ...(replay ? { replay } : {}),
    model: {
      provider: answeredBy?.provider ?? deps.llm.provider,
      model: answeredBy?.model ?? deps.llm.model,
      mode: degraded ? "degraded" : deps.llm.provider === "scripted" ? "scripted" : "live",
      ...(degraded ? { degraded: { stage: degraded.stage, reason: degraded.reason, checks } } : {}),
    },
    startedAt,
    finishedAt: at(),
  };
  stage("verdict", "done", decision.verdict);
  emit({ type: "verdict", verdict, at: at() });
  return verdict;
}

// --- helpers ------------------------------------------------------------------------------------

const EMPTY_CLAIMS: ClaimsOutput = { components: [], impact: "", preconditions: [] };

/** Why the LLM dropped out, in one line safe to show anyone (LlmError messages are already redacted). */
export function describeLlmFailure(e: unknown): string {
  if (!(e instanceof LlmError)) return `The AI failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
  if (e instanceof LlmFallbackError) {
    return e.attempts
      .map((a) => describeLlmFailure(new LlmError(a.message, { code: a.code, provider: a.provider, model: a.model, ...(a.status !== undefined ? { status: a.status } : {}) })))
      .join("; then ");
  }
  const who = e.model ? `${e.provider} ${e.model}` : e.provider;
  switch (e.code) {
    case "timeout":
      return `${who} did not answer in time`;
    case "aborted":
      return `${who} was cancelled${/budget/.test(e.message) ? ": the AI time budget was used up" : ""}`;
    case "http": {
      const s = e.status ?? 0;
      const why = s === 401 || s === 403 ? "authentication failed" : s === 429 ? "rate limited" : s === 503 || s === 529 ? "overloaded" : s >= 500 ? "server error" : "request rejected";
      return `${who} returned HTTP ${s} (${why})`;
    }
    case "network":
      return `${who} could not be reached`;
    case "refusal":
      return `${who} declined the request`;
    case "validation":
      return `${who} returned output that did not match the expected format`;
    default:
      return `${who} failed: ${e.message.slice(0, 160)}`;
  }
}

function mk(kind: Finding["kind"], status: Finding["status"], title: string, detail: string, evidence?: Record<string, unknown>): Finding {
  return { kind, status, title, detail, ...(evidence ? { evidence } : {}) };
}

function dedupeComponents(components: CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>();
  const out: CodeLocation[] = [];
  for (const c of components) {
    const key = `${c.path ?? ""}|${c.symbol ?? ""}`;
    if (key === "|" || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 20) break;
  }
  return out;
}

function cweOf(s: string | undefined): string | undefined {
  return /cwe-\d+/i.exec(s ?? "")?.[0]?.toUpperCase();
}

function isSameClassAndComponent(vulnClass: string | undefined, primaryComp: string | undefined, prior: PriorReport): boolean {
  const classMatch = Boolean(cweOf(vulnClass)) && cweOf(vulnClass) === cweOf(prior.vulnClass);
  const priorComp = (prior.components[0]?.path || prior.components[0]?.symbol || "").trim().toLowerCase();
  const compMatch = Boolean(primaryComp) && primaryComp === priorComp;
  return classMatch && compMatch;
}

function toCorePoc(poc: ClaimsOutput["poc"]): HttpPoc | undefined {
  if (!poc) return undefined;
  return { steps: poc.steps.map((s) => ({ method: s.method, path: s.path, ...(s.as ? { as: s.as } : {}), ...(s.body ? { body: s.body } : {}) })) };
}

/** Validates and trims a PoC to what the runner accepts (valid steps, at most 20). */
function toStrictPoc(poc: HttpPoc | undefined): HttpPoc | undefined {
  if (!poc) return undefined;
  const steps = poc.steps
    .map((s) => httpPocStepSchema.safeParse(s))
    .filter((r) => r.success)
    .map((r) => (r as { data: HttpPoc["steps"][number] }).data)
    .slice(0, 20);
  return steps.length > 0 ? { steps } : undefined;
}

function computeImpossibleImpact(body: string, vulnClass: string | undefined, canaryHit: boolean): boolean {
  if (canaryHit) return false;
  const claimsExec = /\b(remote code execution|\bRCE\b|arbitrary code execution|arbitrary command|command execution|full (?:server )?(?:takeover|compromise)|execute (?:arbitrary )?(?:code|commands?)|root shell|reverse shell)\b/i.test(body);
  const execClass = /CWE-(?:78|94|77|502|434|611)\b/i.test(vulnClass ?? "");
  return claimsExec && !execClass;
}

function buildSeverity(assessment: AssessmentOutput, verdict: TriageVerdict["verdict"], heuristic: boolean): TriageVerdict["suggestedSeverity"] | undefined {
  if (!assessment.severity) return undefined;
  // Only surface a severity suggestion when it is meaningful (reproduced or a human review).
  if (verdict === "SLOP") return undefined;
  const level = assessment.severity.level as Severity;
  const rationale = heuristic ? `Provisional, by rule (AI unavailable): ${assessment.severity.rationale}` : assessment.severity.rationale;
  return { level, ...(assessment.severity.cvss ? { cvss: assessment.severity.cvss } : {}), rationale };
}

function maintainerSummary(
  verdict: TriageVerdict["verdict"],
  reasons: string[],
  ctx: { version?: string; suggestedSeverity?: TriageVerdict["suggestedSeverity"]; duplicateOf?: string; canaryHit: boolean; replay?: ReplayResult },
): string {
  const reason = reasons.join(" ");
  switch (verdict) {
    case "REPRODUCED": {
      const labels = ctx.replay ? [...new Set(ctx.replay.canaryHits.map((h) => h.label))].join(", ") : "a seeded secret";
      const sev = ctx.suggestedSeverity ? ` Suggested severity: ${ctx.suggestedSeverity.level}.` : "";
      return `Reproduced${ctx.version ? ` on ${ctx.version}` : ""}: the PoC leaked ${labels} to an account that should not see it.${sev} Review the evidence and pay the bounty if you agree.`;
    }
    case "DUPLICATE":
      return `This looks like a duplicate of ${ctx.duplicateOf}. ${reason} Confirm before voiding the deposit.`;
    case "SLOP":
      return `Recommend SLOP. ${reason} Confirm before capturing the deposit.`;
    default:
      return `Needs a human review. ${reason}`;
  }
}

function researcherSummary(verdict: TriageVerdict["verdict"], ctx: { suggestedSeverity?: TriageVerdict["suggestedSeverity"]; duplicateOf?: string; aiUnavailable?: boolean }): string {
  if (ctx.aiUnavailable && verdict === "NEEDS_HUMAN") {
    return "Thanks for the report. Our AI reviewer was unavailable, so only the automatic checks ran (version, cited code, duplicates and a sandbox replay of any structured PoC). A maintainer will review it by hand; your deposit is not affected while they do.";
  }
  if (ctx.aiUnavailable && verdict === "REPRODUCED") {
    return `Good news: your PoC reproduced against a sandboxed instance. Our AI reviewer was unavailable, so the severity${ctx.suggestedSeverity ? ` (${ctx.suggestedSeverity.level})` : ""} is provisional. A maintainer will review and release the bounty.`;
  }
  switch (verdict) {
    case "REPRODUCED":
      return `Good news: we reproduced your report against a sandboxed instance${ctx.suggestedSeverity ? ` (suggested severity ${ctx.suggestedSeverity.level})` : ""}. A maintainer will review and release the bounty.`;
    case "DUPLICATE":
      return `Thanks for the report. It appears to match an earlier accepted report, so it is likely a duplicate. Your deposit will be released.`;
    case "SLOP":
      return `We could not verify this report, and our checks found signs it was not written in good faith. A maintainer will review before any deposit is affected.`;
    default:
      return `Thanks for the report. We could not reproduce it automatically, so a maintainer will review it by hand. Your deposit is not affected while we do.`;
  }
}
