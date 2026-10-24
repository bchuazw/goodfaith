import type { JsonSchema, ScriptContext, ScriptedTurn } from "../types.js";
import { ADVISOR_ALLOW_VERDICT, assessRisk, blockVerdictFor } from "./advisor.js";
import { evidenceAnalystScript, evidenceSummaryBag } from "./evidence.js";
import { fitToSchema, normalizeKey } from "./fit.js";
import { shoppingScript } from "./shopping.js";
import { draftPermissionSlip, slipBag } from "./slip.js";

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
 * Named scripts for the scripted provider. Use one with
 * `createLlm({ provider: "scripted", script: scripts.shoppingCompromised })` or `withScript(llm, ...)`.
 * Every structured script fits its canned output to the caller's schema; every shopping script adapts to
 * the tools it is given (see docs/LLM_NOTES.md).
 */
export const scripts = {
  /** structured(): drafts IntentConstraints from the user's words (deterministic parser). */
  permissionSlipDraft: freeze([structuredTurn("permission slip draft", (ctx) => slipBag(draftPermissionSlip(ctx.user)))]),
  /** toolLoop(): search market → list merchants → browse verified merchant → cart 1 bag ≤ $45 → sign → pay → summary. */
  shoppingHappyPath: freeze(shoppingScript("happy")),
  /** toolLoop(): follows the injected instructions at the unverified merchant: 5 × Platinum bundle → sign → pay. */
  shoppingCompromised: freeze(shoppingScript("compromised")),
  /** toolLoop(): verified merchant, cat food priced above the $45 auto-approve limit (the $52 step-up beat). */
  shoppingStepUp: freeze(shoppingScript("stepup")),
  /** structured(): risk advisor says ALLOW (intentMatch 0.97). */
  advisorAllow: freeze([structuredTurn("advisor allow", () => ADVISOR_ALLOW_VERDICT)]),
  /** structured(): risk advisor says BLOCK, quoting the injection found in the prompt when there is one. */
  advisorBlock: freeze([structuredTurn("advisor block", (ctx) => blockVerdictFor(ctx.user))]),
  /** structured(): heuristic advisor (BLOCK on injection signals, STEP_UP on odd quantities, else ALLOW). Default. */
  advisorAuto: freeze([structuredTurn("advisor heuristic", (ctx) => assessRisk(ctx.user))]),
  /** toolLoop(): merchant-console Evidence Analyst. */
  evidenceAnalyst: freeze(evidenceAnalystScript()),
  /** structured(): dispute evidence narrative. */
  evidenceSummary: freeze([structuredTurn("evidence summary", (ctx) => evidenceSummaryBag(ctx.user))]),
  /** structured(): fallback for unknown schemas (type defaults plus a placeholder summary). */
  genericStructured: freeze([
    structuredTurn("generic", () => ({ summary: "Scripted output: no LLM key is configured.", explanation: "Scripted output." })),
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
    if (/advis|risk|verdict|judge|guard/.test(n) || keys.has("injectionsuspected") || (keys.has("recommendation") && keys.has("intentmatch"))) {
      return { name: "advisorAuto", turns: scripts.advisorAuto };
    }
    if (/slip|mandate|constraint|intent|permission/.test(n) || keys.has("maxperorder")) {
      return { name: "permissionSlipDraft", turns: scripts.permissionSlipDraft };
    }
    if (/evidence|dispute/.test(n) || keys.has("evidence")) return { name: "evidenceSummary", turns: scripts.evidenceSummary };
    return { name: "genericStructured", turns: scripts.genericStructured };
  }
  if (i.toolNames.some((t) => /dispute|evidence/i.test(t))) return { name: "evidenceAnalyst", turns: scripts.evidenceAnalyst };
  const text = `${i.system}\n${i.user}`;
  if (/\bcompromised[\s_-]*(?:agent|mode)\b|\[compromised\]/i.test(text)) return { name: "shoppingCompromised", turns: scripts.shoppingCompromised };
  if (/\[step-?up\]|\bstep-?up (?:demo|scenario|mode)\b/i.test(text)) return { name: "shoppingStepUp", turns: scripts.shoppingStepUp };
  return { name: "shoppingHappyPath", turns: scripts.shoppingHappyPath };
}
