// Zod schemas for the three LLM structured-output calls in triage. The scripted provider fits its
// deterministic bags to these; the live model is constrained by them.

import { SEVERITIES } from "@goodfaith/core";
import { z } from "zod";

const method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** A lenient PoC shape for extraction; triage re-validates against the strict core schema before replay. */
export const extractedPocSchema = z.object({
  steps: z
    .array(
      z.object({
        method,
        path: z.string(),
        as: z.string().optional(),
        body: z.string().optional(),
      }),
    )
    .max(40),
});

export const claimsSchema = z.object({
  version: z.string().optional(),
  vulnClass: z.string().optional(),
  components: z.array(z.object({ path: z.string(), symbol: z.string().optional(), line: z.number().int().positive().optional() })).max(40),
  impact: z.string(),
  preconditions: z.array(z.string()).max(20),
  poc: extractedPocSchema.optional(),
  severityClaim: z.enum(SEVERITIES).optional(),
});
export type ClaimsOutput = z.infer<typeof claimsSchema>;

export const assessmentSchema = z.object({
  slopScore: z.number().min(0).max(1),
  slopReasons: z.array(z.string()).max(12),
  injectionSuspected: z.boolean(),
  severity: z.object({ level: z.enum(SEVERITIES), cvss: z.string().optional(), rationale: z.string() }).optional(),
});
export type AssessmentOutput = z.infer<typeof assessmentSchema>;

export const duplicateSchema = z.object({
  matches: z.array(z.object({ priorId: z.string(), similarity: z.number().min(0).max(1) })).max(20),
});
export type DuplicateOutput = z.infer<typeof duplicateSchema>;
