/**
 * The three hero reports judge mode (/demo) submits: AI slop, a real IDOR, and a duplicate of it.
 * The report text comes from the triage agent's eval corpus (packages/triage/evals/reports.ts), so the demo
 * and the evals can never drift apart; this file only adds the demo's labels, handles and expectations.
 */
import type { HttpPoc, Severity } from "@goodfaith/core";
import { EVAL_CASES } from "../../../packages/triage/evals/reports";

export type HeroKey = "slop" | "idor" | "duplicate";

export type HeroReport = {
  key: HeroKey;
  /** What judge mode calls the scenario. */
  label: string;
  /** What the maintainer is expected to do once triage has spoken. */
  expected: { verdict: "SLOP" | "REPRODUCED" | "DUPLICATE"; settle: "capture" | "pay" | "release" };
  handle: string;
  /** Mock-mode payout address; live mode pays the PayPal account that posted the deposit. */
  payoutEmail: string;
  title: string;
  /** The report's markdown, exactly as in the eval corpus. */
  body: string;
  claimedVersion: string;
  claimedSeverity?: Severity;
  poc?: HttpPoc;
};

const DEMO: Record<HeroKey, { evalId: string; label: string; expected: HeroReport["expected"]; handle: string; payoutEmail: string }> = {
  slop: { evalId: "hero1_slop", label: "Polished AI slop", expected: { verdict: "SLOP", settle: "capture" }, handle: "quantum_breach_ai", payoutEmail: "quantum.breach@example.com" },
  idor: { evalId: "hero2_real_idor", label: "Real IDOR with an HTTP PoC", expected: { verdict: "REPRODUCED", settle: "pay" }, handle: "mkdir_p", payoutEmail: "mkdir.p.research@example.com" },
  duplicate: { evalId: "hero3_duplicate", label: "Duplicate of the IDOR", expected: { verdict: "DUPLICATE", settle: "release" }, handle: "late_to_the_party", payoutEmail: "late.party@example.com" },
};

function hero(key: HeroKey): HeroReport {
  const d = DEMO[key];
  const c = EVAL_CASES.find((e) => e.id === d.evalId);
  if (!c) throw new Error(`eval case ${d.evalId} is missing from packages/triage/evals/reports.ts`);
  const r = c.report;
  return {
    key,
    label: d.label,
    expected: d.expected,
    handle: d.handle,
    payoutEmail: d.payoutEmail,
    title: r.title,
    body: r.body,
    claimedVersion: r.claimedVersion ?? "1.4.0",
    ...(r.claimedSeverity ? { claimedSeverity: r.claimedSeverity } : {}),
    ...(r.poc ? { poc: r.poc } : {}),
  };
}

export const HERO_REPORTS: Record<HeroKey, HeroReport> = { slop: hero("slop"), idor: hero("idor"), duplicate: hero("duplicate") };

/** The markdown body Good Faith stores for a form submission: its sections, in a fixed order. */
export function composeReportBody(parts: { affectedCode?: string; description: string; impact?: string; pocNotes?: string }): string {
  const sections: string[] = [];
  if (parts.affectedCode?.trim()) sections.push(`## Affected code\n${parts.affectedCode.trim()}`);
  sections.push(`## Description\n${parts.description.trim()}`);
  if (parts.impact?.trim()) sections.push(`## Impact\n${parts.impact.trim()}`);
  if (parts.pocNotes?.trim()) sections.push(`## Proof of concept\n${parts.pocNotes.trim()}`);
  return sections.join("\n\n");
}
