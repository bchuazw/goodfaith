import type { JsonSchema, ScriptContext, ScriptedTurn } from "../types.js";
import { fitToSchema, normalizeKey } from "./fit.js";
import { assessReport, extractClaimsFromReport, scoreDuplicates } from "./triage.js";

function structuredTurn(label: string, build: (ctx: ScriptContext) => unknown): ScriptedTurn {
  return {
    type: "dynamic",
    op: "structured",
    label,
    resolve: (ctx) => ({ type: "structured", output: fitToSchema(ctx.jsonSchema, build(ctx)) }),
  };
}

const freeze = (turns: ScriptedTurn[]): readonly ScriptedTurn[] => Object.freeze(turns);

/**
 * Named scripts for the scripted provider (the zero-key triage demo). Each structured script fits its
 * deterministic output to whatever schema the caller passes to structured(). See scripts/triage.ts.
 */
export const scripts = {
  /** structured(): extract the security claims (components, vuln class, impact, PoC) from a report. */
  triageClaims: freeze([structuredTurn("triage: extract claims", (ctx) => extractClaimsFromReport(ctx.user))]),
  /** structured(): score the report for slop and suggest a severity, from the deterministic evidence. */
  triageAssess: freeze([structuredTurn("triage: assess", (ctx) => assessReport(ctx))]),
  /** structured(): rate similarity of the report against candidate prior reports. */
  triageDuplicate: freeze([structuredTurn("triage: duplicates", (ctx) => scoreDuplicates(ctx))]),
  /** structured(): fallback for unknown schemas (type defaults plus a placeholder summary). */
  genericStructured: freeze([
    structuredTurn("generic", () => ({ summary: "Scripted output: no LLM key is configured.", explanation: "Scripted output." })),
  ]),
  /** toolLoop(): fallback when no tools are scripted (the triage engine does not use a tool loop). */
  genericAgent: freeze([
    { type: "dynamic", op: "toolLoop", label: "generic agent", resolve: () => ({ type: "final", text: "Scripted agent: no tool script is configured for this call." }) },
  ]),
} as const;

export type ScriptName = keyof typeof scripts;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function schemaKeys(s: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!isObj(s) || depth > 5) return out;
  if (isObj(s.properties)) {
    for (const [k, v] of Object.entries(s.properties)) {
      out.add(normalizeKey(k));
      schemaKeys(v, out, depth + 1);
    }
  }
  if (isObj(s.items)) schemaKeys(s.items, out, depth + 1);
  for (const v of [s.anyOf, s.oneOf, s.allOf]) if (Array.isArray(v)) for (const x of v) schemaKeys(x, out, depth + 1);
  return out;
}

export type DefaultScriptInput = {
  op: "structured" | "toolLoop";
  system: string;
  user: string;
  toolNames: string[];
  name?: string;
  jsonSchema?: JsonSchema;
};

/** Chooses the default script when the scripted provider has no script for this kind of call. */
export function defaultScriptFor(i: DefaultScriptInput): { name: ScriptName; turns: readonly ScriptedTurn[] } {
  if (i.op === "structured") {
    const n = normalizeKey(i.name ?? "");
    const keys = schemaKeys(i.jsonSchema);
    if (/assess|slop|severity/.test(n) || keys.has("slopscore")) return { name: "triageAssess", turns: scripts.triageAssess };
    if (/duplicate|dedupe|dupe/.test(n) || (keys.has("matches") && keys.has("similarity"))) return { name: "triageDuplicate", turns: scripts.triageDuplicate };
    if (/claim|extract/.test(n) || (keys.has("components") && keys.has("impact"))) return { name: "triageClaims", turns: scripts.triageClaims };
    return { name: "genericStructured", turns: scripts.genericStructured };
  }
  return { name: "genericAgent", turns: scripts.genericAgent };
}
