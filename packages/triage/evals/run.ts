// Eval runner: `pnpm --filter @goodfaith/triage eval`.
//
// Scripted mode (default, zero keys) triages every case; EVAL_LLM=live uses the real model on at
// most 6 reports to verify the live path. Prints precision/recall per verdict and false-SLOP (which
// must be 0), and writes evals/results.json.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Verdict } from "@goodfaith/core";
import { VERDICTS } from "@goodfaith/core";
import { createLlm, type Llm, type LlmLogEntry, llmFromEnv } from "@goodfaith/llm";
import { createLanternRunner, lanternCodeSource } from "@goodfaith/target";
import { triageReport } from "../src/index.js";
import { EVAL_CASES } from "./reports.js";

const LIVE = (process.env.EVAL_LLM ?? "").toLowerCase() === "live";
const LIVE_CAP = 6;

interface Row {
  id: string;
  expected: Verdict;
  predicted: Verdict;
  ok: boolean;
  confidence: number;
}

async function main(): Promise<void> {
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const onLog = (e: LlmLogEntry) => {
    if (!e.ok) return;
    usage.calls += 1;
    usage.inputTokens += e.usage?.inputTokens ?? 0;
    usage.outputTokens += e.usage?.outputTokens ?? 0;
  };

  let llm: Llm;
  if (LIVE) {
    llm = llmFromEnv(process.env, { onLog });
    if (llm.provider === "scripted") {
      console.error("EVAL_LLM=live but no API key is configured; aborting so we do not silently run scripted.");
      process.exit(2);
    }
  } else {
    llm = createLlm({ provider: "scripted" });
  }

  const cases = LIVE ? EVAL_CASES.filter((c) => c.live).slice(0, LIVE_CAP) : EVAL_CASES;
  const code = lanternCodeSource();

  console.log(`\nGood Faith triage eval — mode=${LIVE ? "live" : "scripted"} (${llm.provider}/${llm.model}), ${cases.length} case(s)\n`);

  const rows: Row[] = [];
  for (const c of cases) {
    // A fresh runner per case guarantees fresh canaries, as in production.
    const target = createLanternRunner();
    const verdict = await triageReport(c.report, { llm, code, target, priorReports: c.priors });
    const ok = verdict.verdict === c.expected;
    rows.push({ id: c.id, expected: c.expected, predicted: verdict.verdict, ok, confidence: Number(verdict.confidence.toFixed(2)) });
    const mark = ok ? "ok " : "XX ";
    console.log(`  ${mark} ${c.id.padEnd(30)} expected ${c.expected.padEnd(12)} got ${verdict.verdict.padEnd(12)} (conf ${verdict.confidence.toFixed(2)})`);
  }

  const metrics = computeMetrics(rows);
  report(metrics, rows);

  const out = {
    generatedAt: new Date().toISOString(),
    mode: LIVE ? "live" : "scripted",
    model: { provider: llm.provider, model: llm.model },
    total: rows.length,
    correct: rows.filter((r) => r.ok).length,
    accuracy: Number((rows.filter((r) => r.ok).length / rows.length).toFixed(4)),
    falseSlop: metrics.falseSlop,
    falseSlopCases: rows.filter((r) => r.predicted === "SLOP" && r.expected !== "SLOP").map((r) => r.id),
    perVerdict: metrics.perVerdict,
    ...(LIVE ? { usage } : {}),
    cases: rows,
  };
  const path = fileURLToPath(new URL(LIVE ? "./results.live.json" : "./results.json", import.meta.url));
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${path}`);

  if (metrics.falseSlop > 0) {
    console.error(`\nFAIL: false-SLOP is ${metrics.falseSlop} (must be 0). A real/honest report was called SLOP.`);
    process.exit(1);
  }
  const wrong = rows.filter((r) => !r.ok);
  if (wrong.length > 0) {
    console.log(`\n${wrong.length} case(s) did not match the expected verdict (false-SLOP is still 0):`);
    for (const r of wrong) console.log(`  - ${r.id}: expected ${r.expected}, got ${r.predicted}`);
  }
}

interface VerdictMetric {
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
  support: number;
}

function computeMetrics(rows: Row[]): { perVerdict: Record<Verdict, VerdictMetric>; falseSlop: number } {
  const perVerdict = {} as Record<Verdict, VerdictMetric>;
  for (const v of VERDICTS) {
    const tp = rows.filter((r) => r.predicted === v && r.expected === v).length;
    const fp = rows.filter((r) => r.predicted === v && r.expected !== v).length;
    const fn = rows.filter((r) => r.predicted !== v && r.expected === v).length;
    const support = rows.filter((r) => r.expected === v).length;
    perVerdict[v] = {
      precision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)),
      recall: tp + fn === 0 ? null : Number((tp / (tp + fn)).toFixed(3)),
      tp,
      fp,
      fn,
      support,
    };
  }
  const falseSlop = rows.filter((r) => r.predicted === "SLOP" && r.expected !== "SLOP").length;
  return { perVerdict, falseSlop };
}

function report(metrics: { perVerdict: Record<Verdict, VerdictMetric>; falseSlop: number }, rows: Row[]): void {
  const correct = rows.filter((r) => r.ok).length;
  console.log(`\nAccuracy: ${correct}/${rows.length} (${((correct / rows.length) * 100).toFixed(1)}%)`);
  console.log("\n  verdict        precision  recall   tp  fp  fn  support");
  for (const v of VERDICTS) {
    const m = metrics.perVerdict[v];
    const p = m.precision === null ? "  -  " : m.precision.toFixed(3);
    const r = m.recall === null ? "  -  " : m.recall.toFixed(3);
    console.log(`  ${v.padEnd(13)}  ${p.padStart(8)}  ${r.padStart(6)}  ${String(m.tp).padStart(2)}  ${String(m.fp).padStart(2)}  ${String(m.fn).padStart(2)}  ${String(m.support).padStart(7)}`);
  }
  console.log(`\nfalse-SLOP (honest/real reports called SLOP): ${metrics.falseSlop}  (target 0)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
