/**
 * TEMPORARY ADAPTER: delete this file once @goodfaith/triage exports `triageReport`.
 *
 * It stands in for the triage engine with the same signature and event stream, paced like a real run,
 * so the web app's timeline, console and settlement can be built and demoed before the engine lands.
 * The deterministic checks are real (the bundled Lantern code source, the sandboxed Lantern runner and
 * @goodfaith/llm's injection detector); the parts the LLM owns in the real engine (claim extraction,
 * duplicate similarity, the slop assessment and the prose) are simple fixed heuristics. The UI labels
 * every verdict from here as MOCK ("triage: fixture adapter").
 */
import type {
  CodeLocation,
  ExtractedClaims,
  Finding,
  PriorReport,
  ReplayResult,
  ReportInput,
  Severity,
  TriageEvent,
  TriageStage,
  TriageVerdict,
  Verdict,
} from "@goodfaith/core";
import { detectInjectionSignals } from "@goodfaith/llm";
import type { TriageDeps, TriageEngine } from "./triage-engine";

const CWE: Array<{ re: RegExp; cwe: string }> = [
  { re: /\bIDOR\b|access control|authori[sz]ation bypass|owner(?:ship)? check|other users'? (?:private )?notes/i, cwe: "CWE-639 Authorization Bypass Through User-Controlled Key" },
  { re: /path traversal|directory traversal|\.\.\//i, cwe: "CWE-22 Path Traversal" },
  { re: /mass assignment|\brole\b[^.]{0,40}\badmin\b/i, cwe: "CWE-915 Mass Assignment" },
  { re: /deseriali[sz]|prototype pollution|\bRCE\b|remote code execution/i, cwe: "CWE-502 Deserialization of Untrusted Data" },
];

/** Text that addresses the AI doing the triage: an instruction aimed at the triager is itself a slop signal. */
const AIMED_AT_TRIAGER = /\b(?:AI|LLM|language model|automated) (?:triager|reviewer|assistant|model)\b|\bnote to the (?:AI|triager|LLM)\b/i;

type Pace = (ms: number) => Promise<void>;

export function createFixtureTriage(opts: { pace?: number } = {}): TriageEngine {
  const factor = opts.pace ?? 1;
  return {
    kind: "fixture",
    run: (report, deps, runOpts) => fixtureTriage(report, deps, runOpts ?? {}, factor),
  };
}

async function fixtureTriage(
  report: ReportInput,
  deps: TriageDeps,
  opts: { onEvent?: (e: TriageEvent) => void; signal?: AbortSignal },
  factor: number,
): Promise<TriageVerdict> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const findings: Finding[] = [];
  const at = () => now().toISOString();
  const emit = (e: TriageEvent) => opts.onEvent?.(e);
  const pace: Pace = (ms) =>
    new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error("Triage aborted"));
      const timer = setTimeout(resolve, ms * factor);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Triage aborted"));
      });
    });
  const stage = async (s: TriageStage, work: () => Promise<string | undefined>) => {
    emit({ type: "stage", stage: s, status: "start", at: at() });
    const note = await work();
    emit({ type: "stage", stage: s, status: "done", ...(note ? { note } : {}), at: at() });
  };
  const find = (f: Finding) => {
    findings.push(f);
    emit({ type: "finding", finding: f, at: at() });
  };

  // 1. Claims ----------------------------------------------------------------------------------
  const claims: ExtractedClaims = { components: [], impact: "", preconditions: [] };
  let injection: Array<{ quote: string }> = [];
  await stage("claims", async () => {
    await pace(900);
    const text = `${report.title}\n${report.body}`;
    if (report.claimedVersion) claims.version = report.claimedVersion;
    claims.vulnClass = CWE.find((c) => c.re.test(text))?.cwe;
    claims.components = citedComponents(report.body);
    claims.impact = section(report.body, "Impact") ?? "";
    if (report.poc) claims.poc = report.poc;
    if (report.claimedSeverity) claims.severityClaim = report.claimedSeverity;
    if (report.poc?.steps.some((s) => s.as && s.as !== "anonymous")) claims.preconditions.push("A signed-in Lantern account");

    injection = detectInjectionSignals(report.body).filter((s) => !s.weak);
    const aimed = AIMED_AT_TRIAGER.exec(report.body);
    if (aimed && !injection.some((s) => s.quote.includes(aimed[0]))) injection.push({ quote: lineAround(report.body, aimed.index) });
    if (injection.length > 0) {
      await pace(350);
      find({
        kind: "injection",
        status: "fail",
        title: "The report contains instructions aimed at the AI triager",
        detail: "Text inside the report tries to steer the triage outcome. It was treated as data, never as an instruction, and counts as a slop signal.",
        evidence: { quotes: injection.map((s) => s.quote).slice(0, 4) },
      });
    }
    const parts = [claims.vulnClass ?? "no vulnerability class", `${claims.components.length} code reference${claims.components.length === 1 ? "" : "s"}`];
    if (report.poc) parts.push(`a ${report.poc.steps.length}-step HTTP PoC`);
    return `Extracted ${parts.join(", ")}`;
  });

  // 2. Version ---------------------------------------------------------------------------------
  let ref: string | undefined;
  let versionMissing = false;
  await stage("version", async () => {
    await pace(500);
    if (!report.claimedVersion) {
      find({ kind: "version", status: "inconclusive", title: "No affected version was claimed", detail: "Replay uses the latest in-scope version." });
      ref = (await deps.code.listVersions()).at(0);
      return ref ? `Defaulting to ${ref}` : undefined;
    }
    ref = await deps.code.resolveVersion(report.claimedVersion);
    if (!ref) {
      versionMissing = true;
      find({
        kind: "version",
        status: "fail",
        title: `Version ${report.claimedVersion} does not exist`,
        detail: `Known versions: ${(await deps.code.listVersions()).join(", ")}.`,
        evidence: { claimed: report.claimedVersion },
      });
      return "Claimed version not found";
    }
    find({ kind: "version", status: "pass", title: `Lantern ${ref} exists and is in scope`, detail: "The claimed version resolves in the program's source." });
    return `Resolved ${ref}`;
  });

  // 3. Code references -------------------------------------------------------------------------
  let primaryMissing = false;
  await stage("code_refs", async () => {
    if (!ref) {
      find({ kind: "code_ref", status: "inconclusive", title: "Code references not checked", detail: "There is no version to check them against." });
      return undefined;
    }
    let checked = 0;
    for (const [i, c] of claims.components.entries()) {
      await pace(450);
      checked++;
      const fileText = await deps.code.readFile(c.path, ref);
      if (c.symbol) {
        const defs = await deps.code.findSymbol(c.symbol, ref);
        const def = defs.find((d) => d.path === c.path) ?? defs[0];
        if (def) {
          find({
            kind: "code_ref",
            status: "pass",
            title: `${c.symbol}() is defined at ${def.path}:${def.line ?? "?"}`,
            detail: `Found in Lantern ${ref}.`,
            evidence: { path: def.path, ...(def.line ? { line: def.line } : {}), symbol: c.symbol, claimedPath: c.path },
          });
        } else {
          if (i === 0) primaryMissing = true;
          find({
            kind: "code_ref",
            status: "fail",
            title: `Function ${c.symbol}() does not exist in ${ref}`,
            detail: fileText === undefined ? `Neither the symbol nor the cited file ${c.path} exists at this version.` : `${c.path} exists, but nothing in Lantern ${ref} defines ${c.symbol}.`,
            evidence: { symbol: c.symbol, claimedPath: c.path, fileExists: fileText !== undefined, filesSearched: (await deps.code.listFiles(ref)).length },
          });
        }
      } else if (fileText !== undefined) {
        find({ kind: "code_ref", status: "pass", title: `${c.path} exists in ${ref}`, detail: `${fileText.split("\n").length} lines.`, evidence: { path: c.path } });
      } else {
        if (i === 0) primaryMissing = true;
        find({ kind: "code_ref", status: "fail", title: `File ${c.path} does not exist in ${ref}`, detail: "No such file in the program's source at this version.", evidence: { claimedPath: c.path } });
      }
    }
    if (checked === 0) find({ kind: "code_ref", status: "inconclusive", title: "No code references cited", detail: "The report names no files or functions." });
    return `${checked} reference${checked === 1 ? "" : "s"} checked`;
  });

  // 4. Duplicates ------------------------------------------------------------------------------
  let duplicateOf: PriorReport | undefined;
  await stage("duplicates", async () => {
    await pace(700);
    const prior = (deps.priorReports ?? []).filter((p) => p.verdict === "REPRODUCED");
    let best: { p: PriorReport; score: number } | undefined;
    for (const p of prior) {
      const score = similarity(report, claims, p);
      if (!best || score > best.score) best = { p, score };
    }
    if (best && best.score >= 0.8) {
      duplicateOf = best.p;
      find({
        kind: "duplicate",
        status: "fail",
        title: `Duplicate of ${best.p.id}: the same ${claimsShort(claims)} in the same component`,
        detail: `"${best.p.title}" (verdict ${best.p.verdict}, ${best.p.reportedAt.slice(0, 10)}) already covers this. Similarity ${best.score.toFixed(2)}.`,
        evidence: { duplicateOf: best.p.id, similarity: Number(best.score.toFixed(2)), priorTitle: best.p.title },
      });
      return `Matches ${best.p.id}`;
    }
    find({ kind: "duplicate", status: "pass", title: "No earlier report covers this", detail: `Compared with ${prior.length} accepted report${prior.length === 1 ? "" : "s"}.` });
    return `${prior.length} compared`;
  });

  // 5. Replay ----------------------------------------------------------------------------------
  let replay: ReplayResult | undefined;
  await stage("replay", async () => {
    if (!report.poc || !deps.target || !ref) {
      await pace(300);
      find({
        kind: "poc",
        status: "inconclusive",
        title: report.poc ? "The PoC could not be replayed" : "No structured PoC to replay",
        detail: report.poc ? "There is no in-scope version to run it against." : "The report describes the steps in prose only, so there is nothing deterministic to run.",
      });
      return "Skipped";
    }
    await pace(600);
    replay = await deps.target.replay(report.poc, ref, opts.signal ? { signal: opts.signal } : undefined);
    for (const step of replay.steps) {
      await pace(450);
      emit({ type: "replay_step", step, at: at() });
    }
    if (replay.canaryHits.length > 0) {
      const hit = replay.canaryHits[0];
      find({
        kind: "poc",
        status: "pass",
        title: `Reproduced: ${hit?.label} reached ${replay.steps[hit?.stepIndex ?? 0]?.request.as ?? "the attacker"}`,
        detail: `A canary seeded for this run (owner: ${hit?.owner}) appeared in a response to an account not entitled to it. That is proof of impact, not an opinion.`,
        evidence: { canaryHits: replay.canaryHits, version: ref },
      });
      return `${replay.canaryHits.length} canary hit${replay.canaryHits.length === 1 ? "" : "s"}`;
    }
    const codes = replay.steps.map((s) => s.status).join(", ");
    find({
      kind: "poc",
      status: "fail",
      title: "The PoC did not reproduce",
      detail: replay.error ? `Replay stopped: ${replay.error}` : `Lantern ${ref} answered ${codes || "nothing"}; no canary reached an account that should not see it.`,
      evidence: { statuses: replay.steps.map((s) => s.status), version: ref },
    });
    return "No canary hits";
  });

  // 6. Assessment ------------------------------------------------------------------------------
  const reproduced = (replay?.canaryHits.length ?? 0) > 0;
  let suggested: TriageVerdict["suggestedSeverity"];
  let slopScore = 0.1;
  const slopSignals: string[] = [];
  await stage("assess", async () => {
    await pace(800);
    if (reproduced && replay) {
      const owners = new Set(replay.canaryHits.map((h) => h.canaryId));
      const level: Severity = owners.has("env") ? "critical" : "high";
      suggested = {
        level,
        cvss: level === "critical" ? "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N" : "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
        rationale:
          level === "critical"
            ? "Server secrets leak to a normal user."
            : "Any registered user reads other users' private data; ids are enumerable, so every record is exposed.",
      };
      find({ kind: "severity", status: "pass", title: `Suggested severity: ${level}`, detail: suggested.rationale, evidence: { cvss: suggested.cvss, claimed: report.claimedSeverity } });
    }
    if (injection.length > 0) slopSignals.push("Instructions aimed at the AI triager");
    if (primaryMissing) slopSignals.push("The primary cited function or file does not exist");
    if (versionMissing) slopSignals.push("The claimed version does not exist");
    const claimedRce = /remote code execution|\bRCE\b/i.test(`${report.title}\n${report.body}`);
    if (claimedRce && replay && !reproduced) {
      slopSignals.push("Claims remote code execution; the PoC's endpoint does not exist");
      find({
        kind: "consistency",
        status: "fail",
        title: "The claimed impact is not supported by the evidence",
        detail: `The report claims remote code execution, but its only request returned HTTP ${replay.steps.map((s) => s.status).join(", ")}.`,
      });
    }
    if (report.claimedSeverity === "critical" && !reproduced) slopSignals.push("Maximum severity claimed without a working PoC");
    slopScore = Math.min(0.97, 0.1 + 0.3 * Number(injection.length > 0) + 0.35 * Number(primaryMissing) + 0.25 * Number(versionMissing) + 0.15 * Number(claimedRce && !reproduced) + 0.05 * Number(report.claimedSeverity === "critical"));
    return reproduced ? `Severity ${suggested?.level}` : `Slop assessment ${slopScore.toFixed(2)}`;
  });

  // 7. Verdict (the CONTRACTS.md policy) -------------------------------------------------------
  let verdict: Verdict = "NEEDS_HUMAN";
  let confidence = 0.6;
  await stage("verdict", async () => {
    await pace(400);
    const hardFabrication = versionMissing || primaryMissing || injection.length > 0;
    if (reproduced) {
      verdict = "REPRODUCED";
      confidence = 0.97;
    } else if (duplicateOf) {
      verdict = "DUPLICATE";
      confidence = 0.88;
    } else if (hardFabrication && slopScore >= 0.7) {
      verdict = "SLOP";
      confidence = Number(slopScore.toFixed(2));
    }
    return verdict;
  });

  const sev = suggested?.level;
  const summaries: Record<Verdict, [string, string]> = {
    REPRODUCED: [
      `Reproduced on Lantern ${ref}: the PoC's requests made a seeded canary reach an account that is not entitled to it. Suggested severity ${sev}. Recommend paying the ${sev} bounty.`,
      `Your PoC reproduced on Lantern ${ref}, so the report is verified. A maintainer will review the payout.`,
    ],
    DUPLICATE: [
      `Same vulnerability class and component as ${duplicateOf?.id}, which was already reproduced. Recommend releasing the deposit: an honest duplicate costs nothing.`,
      `This issue was already reported and verified (${duplicateOf?.id}). Your deposit will be released in full.`,
    ],
    SLOP: [
      `Hard fabrication evidence: ${slopSignals.join("; ").toLowerCase()}. The PoC did not reproduce. Recommend capturing the deposit after review.`,
      "The cited code does not exist at the claimed version and the PoC did not reproduce. A maintainer will review the evidence before deciding on the deposit.",
    ],
    NEEDS_HUMAN: [
      "The automated checks were inconclusive: nothing reproduced, but there is no hard evidence of fabrication either. A maintainer should read it.",
      "Automated checks could not confirm the report. A maintainer will read it.",
    ],
  };
  const [summary, researcherSummary] = summaries[verdict];
  const result: TriageVerdict = {
    reportId: report.id,
    verdict,
    confidence,
    summary,
    researcherSummary,
    findings,
    claims,
    ...(suggested ? { suggestedSeverity: suggested } : {}),
    ...(duplicateOf ? { duplicateOf: duplicateOf.id } : {}),
    slopSignals,
    ...(replay ? { replay } : {}),
    model: { provider: "fixture", model: "temporary-adapter", mode: "scripted" },
    startedAt,
    finishedAt: now().toISOString(),
  };
  emit({ type: "verdict", verdict: result, at: at() });
  return result;
}

/** Backticked paths with an optional `name()` on the same line: "- `src/notes.ts`, `registerNoteRoutes()`". */
function citedComponents(body: string): CodeLocation[] {
  const out: CodeLocation[] = [];
  const affected = section(body, "Affected code") ?? body;
  for (const line of affected.split("\n")) {
    const path = /`((?:src|lib|app)\/[\w./-]+\.\w+)`/.exec(line)?.[1];
    if (!path) continue;
    const symbol = /`([A-Za-z_$][\w$]*)\(\)`/.exec(line)?.[1];
    const lineNo = /\bline (\d+)\b/i.exec(line)?.[1];
    if (!out.some((c) => c.path === path && c.symbol === symbol)) {
      out.push({ path, ...(symbol ? { symbol } : {}), ...(lineNo ? { line: Number(lineNo) } : {}) });
    }
  }
  return out;
}

function section(body: string, name: string): string | undefined {
  const m = new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "mi").exec(body);
  return m?.[1]?.trim() || undefined;
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).replace(/<!--|-->/g, "").trim();
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);

/** Class match, component overlap and wording overlap; a stand-in for the engine's LLM similarity. */
function similarity(report: ReportInput, claims: ExtractedClaims, prior: PriorReport): number {
  const sameClass = !!claims.vulnClass && !!prior.vulnClass && claims.vulnClass.split(" ")[0] === prior.vulnClass.split(" ")[0];
  const paths = new Set(claims.components.map((c) => c.path));
  const overlap = prior.components.some((c) => paths.has(c.path));
  const a = words(`${report.title} ${report.body}`);
  const b = words(`${prior.title} ${prior.summary}`);
  const shared = [...a].filter((w) => b.has(w)).length;
  const jaccard = shared / Math.max(1, new Set([...a, ...b]).size);
  return 0.45 * Number(sameClass) + 0.35 * Number(overlap) + Math.min(0.2, jaccard);
}

function claimsShort(claims: ExtractedClaims): string {
  return claims.vulnClass?.split(" ")[0] ?? "issue";
}
