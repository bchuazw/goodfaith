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
import type { Llm } from "@goodfaith/llm";
import type { CodeSource, TargetRunner } from "@goodfaith/core";
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
  signal?: AbortSignal;
}

export async function triageReport(report: ReportInput, deps: TriageDeps, opts: TriageOptions = {}): Promise<TriageVerdict> {
  const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const startedAt = at();
  const findings: Finding[] = [];
  const slopSignals: string[] = [];

  const emit = (e: TriageEvent) => opts.onEvent?.(e);
  const stage = (s: TriageStage, status: "start" | "done", note?: string) => emit({ type: "stage", stage: s, status, ...(note ? { note } : {}), at: at() });
  const addFinding = (f: Finding) => {
    findings.push(f);
    emit({ type: "finding", finding: f, at: at() });
  };

  // --- 1. claims --------------------------------------------------------------------------------
  stage("claims", "start");
  let claimsOut: ClaimsOutput;
  try {
    claimsOut = await deps.llm.structured({ system: CLAIMS_SYSTEM, user: claimsUser(report), schema: claimsSchema, name: "triage_claims" });
  } catch {
    claimsOut = { components: [], impact: "", preconditions: [] };
  }
  const version = (report.claimedVersion ?? claimsOut.version)?.trim() || undefined;
  const vulnClass = claimsOut.vulnClass;
  const components = dedupeComponents(claimsOut.components);
  const severityClaim = report.claimedSeverity ?? claimsOut.severityClaim;
  stage("claims", "done", vulnClass ? `${vulnClass}${version ? ` in ${version}` : ""}` : "claims extracted");

  // --- 2. version -------------------------------------------------------------------------------
  stage("version", "start");
  const resolvedRef = version ? await deps.code.resolveVersion(version) : undefined;
  const versionProvided = Boolean(version);
  const versionResolves = Boolean(resolvedRef);
  const versionInScope = versionResolves;
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

  // Injection detection is deterministic and part of the integrity checks.
  const injectionSignals = detectTriageInjection(report.body);
  const injectionDetected = injectionSignals.length > 0;
  if (injectionDetected) {
    const quote = injectionSignals[0]?.quote ?? "";
    addFinding(mk("injection", "fail", "The report contains an instruction aimed at the AI triager", `Found ${injectionSignals.length} prompt-injection signal(s). This is a hard slop signal and never counts in the reporter's favour.`, { signals: injectionSignals }));
    slopSignals.push(`Contains an instruction aimed at the AI triager: "${quote}".`);
  }
  stage("code_refs", "done");

  // --- 4. duplicates ----------------------------------------------------------------------------
  stage("duplicates", "start");
  const primaryComp = primaryComponentKey(components);
  const candidates = (deps.priorReports ?? []).filter((p) => p.verdict === "REPRODUCED");
  let duplicate: PolicyDuplicate | undefined;
  let duplicateOf: string | undefined;
  if (candidates.length > 0) {
    let matches: Array<{ priorId: string; similarity: number }> = [];
    try {
      const out = await deps.llm.structured({
        system: DUPLICATE_SYSTEM,
        user: duplicateUser({ vulnClass, component: primaryComp, title: report.title, summary: claimsOut.impact }, candidates),
        schema: duplicateSchema,
        name: "triage_duplicate",
      });
      matches = out.matches;
    } catch {
      matches = [];
    }
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
  stage("duplicates", "done");

  // --- 5. replay --------------------------------------------------------------------------------
  stage("replay", "start");
  const poc = toStrictPoc(report.poc ?? toCorePoc(claimsOut.poc));
  let replay: ReplayResult | undefined;
  let canaryHit = false;
  if (duplicateOf) {
    addFinding(mk("poc", "inconclusive", "Skipped replay (duplicate)", `Treated as a duplicate of ${duplicateOf}; not replayed so the bounty is not paid twice.`));
  } else if (!deps.target) {
    addFinding(mk("poc", "inconclusive", "No sandbox available", "No target runner was provided, so the PoC was not replayed."));
  } else if (!resolvedRef) {
    addFinding(mk("poc", "inconclusive", "No resolvable version to replay against", "The PoC was not replayed because the version could not be resolved."));
  } else if (!poc) {
    addFinding(mk("poc", "inconclusive", "No runnable PoC", "The report contains no HTTP proof of concept to replay."));
  } else {
    replay = await deps.target.replay(poc, resolvedRef, opts.signal ? { signal: opts.signal } : undefined);
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
  stage("replay", "done");

  // --- 6. assessment ----------------------------------------------------------------------------
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
  let assessment: AssessmentOutput;
  try {
    assessment = await deps.llm.structured({ system: ASSESS_SYSTEM, user: assessUser(report, claimsOut, ev), schema: assessmentSchema, name: "triage_assessment" });
  } catch {
    const fallbackScore = canaryHit ? 0.02 : ev.claimedVersionInvalid || ev.hardCodeRefFailure || injectionDetected ? 0.85 : 0.2;
    assessment = { slopScore: fallbackScore, slopReasons: [], injectionSuspected: injectionDetected };
  }
  if (impossibleImpact) slopSignals.push("The claimed impact (code execution / takeover) is inconsistent with the cited code.");
  addFinding(mk("severity", canaryHit ? "pass" : "inconclusive", `Slop assessment ${assessment.slopScore.toFixed(2)}`, assessment.slopReasons.join(" ") || "Assessment complete.", { slopScore: assessment.slopScore }));
  stage("assess", "done");

  // --- 7. verdict -------------------------------------------------------------------------------
  stage("verdict", "start");
  const decision = decideVerdict({
    versionProvided,
    versionResolves,
    canaryHit,
    hardCodeRefFailure: codeRefs.hardFailure,
    injectionDetected,
    slopScore: assessment.slopScore,
    duplicate,
  });

  const suggestedSeverity = buildSeverity(assessment, decision.verdict);
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
    summary: maintainerSummary(decision.verdict, decision.reasons, { version, suggestedSeverity, duplicateOf, canaryHit, replay }),
    researcherSummary: researcherSummary(decision.verdict, { suggestedSeverity, duplicateOf }),
    findings,
    claims,
    ...(suggestedSeverity ? { suggestedSeverity } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    slopSignals,
    ...(replay ? { replay } : {}),
    model: { provider: deps.llm.provider, model: deps.llm.model, mode: deps.llm.provider === "scripted" ? "scripted" : "live" },
    startedAt,
    finishedAt: at(),
  };
  stage("verdict", "done", decision.verdict);
  emit({ type: "verdict", verdict, at: at() });
  return verdict;
}

// --- helpers ------------------------------------------------------------------------------------

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

function buildSeverity(assessment: AssessmentOutput, verdict: TriageVerdict["verdict"]): TriageVerdict["suggestedSeverity"] | undefined {
  if (!assessment.severity) return undefined;
  // Only surface a severity suggestion when it is meaningful (reproduced or a human review).
  if (verdict === "SLOP") return undefined;
  const level = assessment.severity.level as Severity;
  return { level, ...(assessment.severity.cvss ? { cvss: assessment.severity.cvss } : {}), rationale: assessment.severity.rationale };
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

function researcherSummary(verdict: TriageVerdict["verdict"], ctx: { suggestedSeverity?: TriageVerdict["suggestedSeverity"]; duplicateOf?: string }): string {
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
