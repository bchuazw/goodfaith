// @goodfaith/llm: provider-agnostic structured output and tool loops (Anthropic, Gemini,
// OpenAI-compatible, scripted) with spotlighting for untrusted tool output. See docs/LLM_NOTES.md.

export { createLlm, DEFAULT_MODELS, defineTool, llmFromEnv, withScript } from "./create.js";
export { LlmError, type LlmErrorCode, LlmValidationError } from "./errors.js";
export { toAnthropicSchema, toGeminiSchema, toOpenAIStrictSchema, zodToJsonSchema } from "./json-schema.js";
export {
  ADVISOR_ALLOW_VERDICT,
  ADVISOR_BLOCK_VERDICT,
  type AdvisorVerdict,
  assessRisk,
} from "./scripts/advisor.js";
export { fitToSchema } from "./scripts/fit.js";
export { defaultScriptFor, type ScriptName, scripts } from "./scripts/index.js";
export { DEMO_TOOL_NAMES } from "./scripts/shopping.js";
export { DEMO_INTENT_TEXT, type DraftConstraints, draftPermissionSlip, type PermissionSlipDraft } from "./scripts/slip.js";
export type {
  JsonSchema,
  Llm,
  LlmConfig,
  LlmEffort,
  LlmLogEntry,
  LlmProvider,
  LlmUsage,
  QuarantineMode,
  ScriptContext,
  ScriptedToolCall,
  ScriptedTurn,
  ScriptToolInfo,
  ScriptToolResult,
  StructuredInput,
  ToolDef,
  ToolEvent,
  ToolLoopInput,
  ToolLoopResult,
} from "./types.js";
export {
  DATAMARK,
  detectInjectionSignals,
  type InjectionSignal,
  isQuarantined,
  type QuarantinedBlock,
  type QuarantineOptions,
  quarantine,
  sanitizeUntrusted,
  UNTRUSTED_CONTENT_RULE,
  unquarantine,
  untrustedContentRule,
} from "./untrusted.js";
