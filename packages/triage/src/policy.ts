// The Good Faith verdict policy. Deterministic and conservative: the LLM supplies evidence and
// opinions, but this pure function decides. See docs/CONTRACTS.md ("Verdict policy").

import type { Verdict } from "@goodfaith/core";

export interface PolicyDuplicate {
  /** The prior report this one most resembles. */
  ofId: string;
  /** LLM similarity 0..1. */
  similarity: number;
  /** Same vulnerability class AND same primary component as the prior (computed deterministically). */
  sameClassAndComponent: boolean;
  /** The prior report was REPRODUCED or otherwise accepted. */
  priorAccepted: boolean;
}

export interface PolicyInput {
  /** The report named a version. */
  versionProvided: boolean;
  /** The named version exists in the project at an in-scope ref. */
  versionResolves: boolean;
  /** A seeded canary reached an account not entitled to it, during replay on a resolved version. */
  canaryHit: boolean;
  /** The primary cited symbol or file does not exist at the version, and no near match was found. */
  hardCodeRefFailure: boolean;
  /** An instruction aimed at the AI triager was found inside the report. */
  injectionDetected: boolean;
  /** The LLM's slop assessment, 0..1. */
  slopScore: number;
  duplicate?: PolicyDuplicate;
}

export interface PolicyResult {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
}

const SLOP_THRESHOLD = 0.7;
const DUPLICATE_SIMILARITY = 0.8;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function decideVerdict(input: PolicyInput): PolicyResult {
  const slopScore = clamp01(input.slopScore);

  // 1. REPRODUCED — a canary hit is ground truth. A reproduced report is never SLOP or DUPLICATE here.
  if (input.canaryHit) {
    return {
      verdict: "REPRODUCED",
      confidence: 0.98,
      reasons: ["A seeded canary secret was returned to an account not entitled to it when the PoC was replayed on an in-scope version."],
    };
  }

  // 2. DUPLICATE — same class and primary component as an accepted prior, with high similarity.
  const dup = input.duplicate;
  if (dup?.sameClassAndComponent && dup.priorAccepted && dup.similarity >= DUPLICATE_SIMILARITY) {
    return {
      verdict: "DUPLICATE",
      confidence: clamp01(dup.similarity),
      reasons: [`Same vulnerability class and primary component as ${dup.ofId} (similarity ${dup.similarity.toFixed(2)}), which was already accepted.`],
    };
  }

  // 3. SLOP — no reproduction AND at least one piece of hard fabrication evidence AND the LLM agrees.
  const claimedVersionInvalid = input.versionProvided && !input.versionResolves;
  const hardEvidence: string[] = [];
  if (claimedVersionInvalid) hardEvidence.push("the claimed version does not exist in the project");
  if (input.hardCodeRefFailure) hardEvidence.push("the primary cited code does not exist at that version and has no near match");
  if (input.injectionDetected) hardEvidence.push("the report contains an instruction aimed at the AI triager");
  if (hardEvidence.length > 0 && slopScore >= SLOP_THRESHOLD) {
    return {
      verdict: "SLOP",
      confidence: slopScore,
      reasons: [`No reproduction, and there is hard fabrication evidence: ${hardEvidence.join("; ")}. The slop assessment is ${slopScore.toFixed(2)}.`],
    };
  }

  // 4. NEEDS_HUMAN — everything else. A typo (near match) or an unreproduced-but-honest report lands here.
  const reasons: string[] = [];
  if (hardEvidence.length > 0) reasons.push(`Possible fabrication signals (${hardEvidence.join("; ")}), but the slop assessment (${slopScore.toFixed(2)}) is below the threshold, so a human should decide.`);
  else if (dup && dup.similarity >= DUPLICATE_SIMILARITY) reasons.push(`Resembles ${dup.ofId}, but not enough to auto-dedupe; a human should compare them.`);
  else reasons.push("The claim could not be reproduced and shows no hard fabrication evidence; a human should review it.");
  return { verdict: "NEEDS_HUMAN", confidence: 0.5, reasons };
}
