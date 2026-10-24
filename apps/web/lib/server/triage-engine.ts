/**
 * The triage engine the web app runs, behind one signature: @goodfaith/triage's
 * `triageReport(report, deps, { onEvent, signal })`.
 */
import type { CodeSource, PriorReport, ReportInput, TargetRunner, TriageEvent, TriageVerdict } from "@goodfaith/core";
import type { Llm } from "@goodfaith/llm";

export type TriageDeps = { llm: Llm; code: CodeSource; target?: TargetRunner; priorReports?: PriorReport[]; now?: () => Date };

export type TriageFn = (
  report: ReportInput,
  deps: TriageDeps,
  opts?: { onEvent?: (e: TriageEvent) => void; signal?: AbortSignal },
) => Promise<TriageVerdict>;

export type TriageEngine = {
  /** "triage": @goodfaith/triage. Tests may wrap it ("fixture") to count or fail runs. */
  kind: "triage" | "fixture";
  run: TriageFn;
};
