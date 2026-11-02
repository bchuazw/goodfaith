// @goodfaith/triage: the AI triage engine, the verdict policy and the GitHub code source.
// See docs/CONTRACTS.md.

export { checkCodeRefs, type CodeRefResult, definedSymbols, definesSymbol, editDistance, primaryComponentKey } from "./code-refs.js";
export { githubCodeSource, type GithubCodeSourceOptions } from "./github.js";
export { detectTriageInjection, type TriageInjectionSignal } from "./injection.js";
export { decideVerdict, type PolicyDuplicate, type PolicyInput, type PolicyResult } from "./policy.js";
export {
  assessmentSchema,
  type AssessmentOutput,
  claimsSchema,
  type ClaimsOutput,
  duplicateSchema,
  type DuplicateOutput,
} from "./schemas.js";
export { type TriageDeps, type TriageOptions, triageAbortError, triageReport } from "./triage.js";
