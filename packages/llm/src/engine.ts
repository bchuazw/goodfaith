import { LlmError, LlmValidationError } from "./errors.js";
import { formatZodIssues, parseJsonLoose, stripNullOptionals, zodToJsonSchema } from "./json-schema.js";
import { type RetryPolicy, robustCall, withTimeout } from "./robust.js";
import type {
  JsonSchema,
  Llm,
  LlmEffort,
  LlmLogEntry,
  LlmProvider,
  LlmUsage,
  QuarantineMode,
  ScriptToolResult,
  StructuredInput,
  ToolDef,
  ToolEvent,
  ToolLoopInput,
  ToolLoopResult,
} from "./types.js";
import { quarantine, untrustedContentRule } from "./untrusted.js";

// ---------------------------------------------------------------------------
// Provider adapter interface (internal)
// ---------------------------------------------------------------------------

export type PreparedTool = { name: string; description: string; jsonSchema: JsonSchema; untrusted: boolean };
export type ModelToolCall = { id: string; name: string; args: unknown; argsError?: string };
export type ModelTurn = { text: string; toolCalls: ModelToolCall[]; usage?: LlmUsage; stopReason?: string };
export type ToolResultMessage = { callId: string; name: string; content: string; isError: boolean };

/** Mutable per-call state shared with adapters (the scripted provider builds its ScriptContext from it). */
export type CallState = {
  op: "structured" | "toolLoop";
  name?: string;
  jsonSchema?: JsonSchema;
  events: ToolEvent[];
  results: ScriptToolResult[];
  step: number;
  repair?: { feedback: string; previous: string };
};

export type ConversationInit = {
  system: string;
  user: string;
  /** Per-call effort (providers without an effort setting ignore it). */
  effort?: LlmEffort;
  tools?: PreparedTool[];
  output?: { name: string; jsonSchema: JsonSchema };
  state: CallState;
};

/** One provider-native conversation. `send` must not mutate history until the call succeeds (so retries are safe). */
export interface Conversation {
  send(signal: AbortSignal): Promise<ModelTurn>;
  addToolResults(results: ToolResultMessage[]): void;
  addUserText(text: string): void;
}

export interface ProviderAdapter {
  readonly provider: LlmProvider;
  readonly model: string;
  conversation(init: ConversationInit): Conversation;
}

export type EngineOptions = {
  policy: RetryPolicy;
  onLog?: (e: LlmLogEntry) => void;
  redact: (text: string) => string;
  untrustedMode: QuarantineMode;
  untrustedMaxChars: number;
  toolTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
};

const MAX_STEPS_CAP = 50;

export function createEngine(adapter: ProviderAdapter, opts: EngineOptions): Llm {
  const { provider, model } = adapter;
  const hooks = { log: opts.onLog, redact: opts.redact, sleep: opts.sleep };

  async function structured<T>(i: StructuredInput<T>): Promise<T> {
    if (!i.name?.trim()) throw configError("structured() needs a non-empty name");
    const jsonSchema = zodToJsonSchema(i.schema);
    const state: CallState = { op: "structured", name: i.name, jsonSchema, events: [], results: [], step: 0 };
    const conversation = adapter.conversation({
      system: i.system,
      user: i.user,
      output: { name: i.name, jsonSchema },
      state,
      ...(i.effort ? { effort: i.effort } : {}),
    });
    let issues: string[] = [];
    let raw = "";
    for (let step = 0; step < 2; step++) {
      state.step = step;
      const turn = await robustCall(opts.policy, { provider, model, op: "structured", name: i.name, step }, hooks, async (signal) => {
        const t = await conversation.send(signal);
        return { value: t, usage: t.usage, stopReason: t.stopReason };
      });
      raw = turn.text;
      const parsed = parseJsonLoose(turn.text);
      if (parsed.ok) {
        const result = i.schema.safeParse(stripNullOptionals(parsed.value, jsonSchema));
        if (result.success) return result.data;
        issues = formatZodIssues(result.error);
      } else {
        issues = [parsed.error];
      }
      if (turn.stopReason === "max_tokens") issues.push("The reply was cut off at the output token limit; answer more briefly.");
      if (step === 0) {
        const feedback = repairPrompt(i.name, issues);
        state.repair = { feedback, previous: turn.text };
        conversation.addUserText(feedback);
      }
    }
    throw new LlmValidationError(
      `Structured output "${i.name}" did not match its schema after one repair attempt: ${issues.join("; ")}`,
      { provider, model, issues, raw: opts.redact(raw) },
    );
  }

  async function toolLoop(i: ToolLoopInput): Promise<ToolLoopResult> {
    if (!Number.isInteger(i.maxSteps) || i.maxSteps < 1) throw configError("toolLoop() needs maxSteps >= 1");
    const maxSteps = Math.min(i.maxSteps, MAX_STEPS_CAP);
    const names = new Set<string>();
    for (const t of i.tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw configError(`Invalid tool name "${t.name}" (use [a-zA-Z0-9_-], max 64)`);
      if (names.has(t.name)) throw configError(`Duplicate tool name "${t.name}"`);
      names.add(t.name);
    }
    const prepared: PreparedTool[] = i.tools.map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: zodToJsonSchema(t.parameters),
      untrusted: t.untrusted === true,
    }));
    const system = prepared.some((t) => t.untrusted) ? `${i.system}\n\n${untrustedContentRule()}` : i.system;
    const state: CallState = { op: "toolLoop", events: [], results: [], step: 0 };
    const conversation = adapter.conversation({ system, user: i.user, tools: prepared, state, ...(i.effort ? { effort: i.effort } : {}) });
    const events = state.events;
    const emit = (e: ToolEvent) => {
      events.push(e);
      i.onEvent?.(e);
    };

    for (let step = 0; step < maxSteps; step++) {
      state.step = step;
      const turn = await robustCall(opts.policy, { provider, model, op: "toolLoop", step }, hooks, async (signal) => {
        const t = await conversation.send(signal);
        return { value: t, usage: t.usage, stopReason: t.stopReason };
      });

      if (turn.toolCalls.length === 0) {
        const text = turn.text.trim();
        emit({ type: "final", text });
        return { finalText: text, events, stopReason: "final", steps: step + 1 };
      }
      if (turn.stopReason === "max_tokens") {
        throw new LlmError("Model output hit max_tokens while calling tools; the tool arguments may be truncated. Raise maxTokens.", {
          code: "truncated",
          provider,
          model,
        });
      }
      if (turn.text.trim()) emit({ type: "thought", text: turn.text.trim() });

      const messages: ToolResultMessage[] = [];
      for (const call of turn.toolCalls) {
        emit({ type: "tool_call", name: call.name, args: call.args });
        const tool = i.tools.find((t) => t.name === call.name);
        const prep = prepared.find((t) => t.name === call.name);
        const out = await runTool(tool, prep, call, [...names]);
        emit({ type: "tool_result", name: call.name, result: out.result, untrusted: out.untrusted });
        state.results.push({
          name: call.name,
          args: call.args,
          result: out.result,
          untrusted: out.untrusted,
          isError: out.isError,
          modelContent: out.content,
        });
        messages.push({ callId: call.id, name: call.name, content: out.content, isError: out.isError });
      }
      conversation.addToolResults(messages);
    }

    const text = `Stopped after ${maxSteps} steps without a final answer.`;
    emit({ type: "final", text });
    return { finalText: text, events, stopReason: "max_steps", steps: maxSteps };
  }

  async function runTool(
    tool: ToolDef | undefined,
    prep: PreparedTool | undefined,
    call: ModelToolCall,
    available: string[],
  ): Promise<{ result: unknown; content: string; isError: boolean; untrusted: boolean }> {
    const untrusted = tool?.untrusted === true;
    let result: unknown;
    let isError = false;
    if (!tool || !prep) {
      result = { error: `Unknown tool "${call.name}". Available tools: ${available.join(", ")}.` };
      isError = true;
    } else if (call.argsError) {
      result = { error: `Tool arguments were not valid JSON: ${call.argsError}` };
      isError = true;
    } else {
      const parsed = tool.parameters.safeParse(stripNullOptionals(call.args ?? {}, prep.jsonSchema));
      if (!parsed.success) {
        result = { error: "Invalid tool arguments", issues: formatZodIssues(parsed.error) };
        isError = true;
      } else {
        try {
          result = await withTimeout(
            Promise.resolve(tool.execute(parsed.data)),
            opts.toolTimeoutMs,
            `Tool "${tool.name}" timed out after ${opts.toolTimeoutMs} ms`,
          );
        } catch (e) {
          result = { error: opts.redact(e instanceof Error ? e.message : String(e)) };
          isError = true;
        }
      }
    }
    const content = untrusted
      ? quarantine(result, { source: call.name, mode: opts.untrustedMode, maxChars: opts.untrustedMaxChars })
      : serializeForModel(result);
    return { result, content: content || "(empty)", isError, untrusted };
  }

  function configError(message: string): LlmError {
    return new LlmError(message, { code: "config", provider, model });
  }

  return { provider, model, structured, toolLoop };
}

function repairPrompt(name: string, issues: string[]): string {
  return [
    `Your previous reply did not match the required JSON schema for "${name}".`,
    "Problems:",
    ...issues.map((issue) => `- ${issue}`),
    "Reply again with only the corrected JSON object. Keep the values you were confident about and fix only what is listed.",
  ].join("\n");
}

function serializeForModel(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "(no output)";
  let text: string;
  try {
    text = JSON.stringify(result) ?? String(result);
  } catch {
    text = String(result);
  }
  return text.length > 20000 ? `${text.slice(0, 20000)}…[truncated ${text.length - 20000} characters]` : text;
}
