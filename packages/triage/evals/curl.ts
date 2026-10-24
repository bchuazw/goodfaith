// Real-world corpus runner: `GITHUB_TOKEN=$(gh auth token) pnpm --filter @goodfaith/triage eval:curl`.
//
// Triages publicly disclosed curl reports with the scripted LLM and the GitHub-backed code source,
// checking each cited reference against the real curl source at the cited version. Reports how many
// slop reports yield hard code-reference evidence and confirms that no real CVE report is flagged
// SLOP. Writes results.curl.json. No PoC replay (we never run curl); deterministic checks only.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Finding, TriageVerdict } from "@goodfaith/core";
import { createLlm } from "@goodfaith/llm";
import { githubCodeSource, triageReport } from "../src/index.js";
import { type CurlCase, CURL_CASES } from "./curl-corpus.js";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) console.warn("No GITHUB_TOKEN set; using the unauthenticated GitHub rate limit (60/hr). Run `GITHUB_TOKEN=$(gh auth token) ...` to raise it.\n");

  const llm = createLlm({ provider: "scripted" });
  const code = githubCodeSource({ owner: "curl", repo: "curl", token, cacheDir: ".cache/github" });

  console.log(`Good Faith real-world corpus — curl/curl, ${CURL_CASES.length} report(s), scripted LLM + deterministic code-reference checks\n`);

  const rows: Array<{ id: string; kind: CurlCase["kind"]; verdict: TriageVerdict["verdict"] | "ERROR"; hardEvidence: boolean; codeRef: string }> = [];
  for (const c of CURL_CASES) {
    try {
      const v = await triageReport(c.report, { llm, code });
      const codeRefFindings = v.findings.filter((f) => f.kind === "code_ref");
      const hardEvidence = codeRefFindings.some((f) => f.status === "fail");
      rows.push({ id: c.id, kind: c.kind, verdict: v.verdict, hardEvidence, codeRef: summariseCodeRef(codeRefFindings) });
      const mark = c.kind === "cve" ? (v.verdict === "SLOP" ? "FALSE-SLOP!" : "ok ") : hardEvidence ? "hard-ev" : "soft   ";
      console.log(`  [${c.kind}] ${mark.padEnd(11)} ${c.id.padEnd(34)} verdict=${v.verdict.padEnd(12)} code-ref: ${rows[rows.length - 1]?.codeRef}`);
    } catch (e) {
      rows.push({ id: c.id, kind: c.kind, verdict: "ERROR", hardEvidence: false, codeRef: `error: ${e instanceof Error ? e.message : String(e)}` });
      console.log(`  [${c.kind}] ERROR       ${c.id.padEnd(34)} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const slop = rows.filter((r) => r.kind === "slop");
  const cve = rows.filter((r) => r.kind === "cve");
  const slopHardEvidence = slop.filter((r) => r.hardEvidence).length;
  const slopFlaggedSlop = slop.filter((r) => r.verdict === "SLOP").length;
  const cveFalseSlop = cve.filter((r) => r.verdict === "SLOP").length;

  console.log("\n--- Summary ---");
  console.log(`Slop reports: ${slop.length}`);
  console.log(`  with hard code-reference evidence (cited code does not exist at the version): ${slopHardEvidence}/${slop.length}`);
  console.log(`  recommended SLOP by the policy: ${slopFlaggedSlop}/${slop.length}`);
  console.log(`  the rest cite REAL curl code (fabricated bug in real code) -> NEEDS_HUMAN, the hard case that needs reproduction`);
  console.log(`Real CVE reports: ${cve.length}`);
  console.log(`  flagged SLOP (false-SLOP, must be 0): ${cveFalseSlop}/${cve.length}`);

  const out = {
    generatedAt: new Date().toISOString(),
    repo: "curl/curl",
    mode: "scripted + github code source",
    totals: { slop: slop.length, cve: cve.length },
    slopWithHardEvidence: slopHardEvidence,
    slopRecommendedSlop: slopFlaggedSlop,
    cveFalseSlop,
    cases: CURL_CASES.map((c, i) => ({ id: c.id, kind: c.kind, source: c.source, mapping: c.mapping, verdict: rows[i]?.verdict, hardEvidence: rows[i]?.hardEvidence })),
  };
  const path = fileURLToPath(new URL("./results.curl.json", import.meta.url));
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${path}`);

  if (cveFalseSlop > 0) {
    console.error(`\nFAIL: ${cveFalseSlop} real CVE report(s) were flagged SLOP. The control property is violated.`);
    process.exit(1);
  }
}

function summariseCodeRef(findings: Finding[]): string {
  if (findings.length === 0) return "(none cited)";
  const f = findings[0] as Finding;
  return `${f.status}: ${f.title}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
