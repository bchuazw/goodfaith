import type { Conversation, ConversationInit, ModelTurn, ProviderAdapter } from "../engine.js";
import { LlmError } from "../errors.js";
import { defaultScriptFor } from "../scripts/index.js";
import type { ScriptContext, ScriptedTurn } from "../types.js";

export const SCRIPTED_MODEL = "scripted-demo";

type Op = "structured" | "toolLoop";
type ConcreteTurn = Exclude<ScriptedTurn, { type: "dynamic" }>;

function opOf(t: ScriptedTurn): Op {
  if (t.type === "structured") return "structured";
  if (t.type === "dynamic") return t.op ?? "toolLoop";
  return "toolLoop";
}

export type ScriptedAdapterConfig = {
  model: string;
  script?: readonly ScriptedTurn[];
  /** "replay": each call starts from the first matching turn. "queue": turns are consumed across calls. */
  mode: "replay" | "queue";
};

/**
 * Replays scripted turns. structured() calls consume `structured` turns (and dynamic turns with
 * op "structured"); toolLoop() calls consume `tool_calls` / `final` turns (and other dynamic turns).
 * If the script has no turns for the kind of call being made, the deterministic demo default for that
 * call is used (see scripts/index.ts), so one scripted Llm can serve the whole app.
 */
export function scriptedAdapter(cfg: ScriptedAdapterConfig): ProviderAdapter {
  const shared: Record<Op, number> = { structured: 0, toolLoop: 0 };
  return {
    provider: "scripted",
    model: cfg.model,
    conversation(init: ConversationInit): Conversation {
      const op = init.state.op;
      const outputName = init.output?.name;
      const own = (cfg.script ?? []).filter(
        (t) => opOf(t) === op && !(t.type === "structured" && t.name !== undefined && t.name !== outputName),
      );
      const usingOwn = own.length > 0;
      const turns: readonly ScriptedTurn[] = usingOwn
        ? own
        : defaultScriptFor({
            op,
            system: init.system,
            user: init.user,
            toolNames: (init.tools ?? []).map((t) => t.name),
            name: outputName,
            jsonSchema: init.output?.jsonSchema,
          }).turns;
      const queue = usingOwn && cfg.mode === "queue";
      let cursor = queue ? shared[op] : 0;
      let replayedLast = false;

      const ctx = (): ScriptContext => ({
        op,
        system: init.system,
        user: init.user,
        name: outputName,
        jsonSchema: init.output?.jsonSchema,
        tools: (init.tools ?? []).map((t) => ({ name: t.name, description: t.description, untrusted: t.untrusted, jsonSchema: t.jsonSchema })),
        events: init.state.events,
        results: init.state.results,
        step: init.state.step,
        repair: init.state.repair,
      });

      return {
        async send(): Promise<ModelTurn> {
          for (;;) {
            // A default structured script has one turn; replay it for the repair attempt so a schema the
            // default cannot satisfy ends in an LlmValidationError that lists the issues.
            if (cursor >= turns.length && !usingOwn && op === "structured" && turns.length > 0 && !replayedLast) {
              replayedLast = true;
              cursor = turns.length - 1;
            }
            if (cursor >= turns.length) {
              throw new LlmError(
                `Scripted provider has no ${op} turn left (${turns.length} ${usingOwn ? "scripted" : "default"} turn(s) used).`,
                { code: "script", provider: "scripted", model: cfg.model },
              );
            }
            const next = turns[cursor] as ScriptedTurn;
            cursor++;
            if (queue) shared[op] = cursor;
            const turn = await resolveTurn(next, ctx, cfg.model);
            if (turn) return toModelTurn(turn, op, init.state.step, cfg.model);
          }
        },
        addToolResults() {
          // The engine records results in the shared CallState that dynamic turns read.
        },
        addUserText() {
          // Repair feedback is exposed to dynamic turns via ScriptContext.repair.
        },
      };
    },
  };
}

async function resolveTurn(t: ScriptedTurn, ctx: () => ScriptContext, model: string, depth = 0): Promise<ConcreteTurn | null> {
  if (t.type !== "dynamic") return t;
  if (depth > 5) throw new LlmError("Dynamic scripted turns nested too deeply.", { code: "script", provider: "scripted", model });
  const resolved = await t.resolve(ctx());
  return resolved ? resolveTurn(resolved, ctx, model, depth + 1) : null;
}

function toModelTurn(t: ConcreteTurn, op: Op, step: number, model: string): ModelTurn {
  switch (t.type) {
    case "tool_calls":
      if (op !== "toolLoop") {
        throw new LlmError("A tool_calls turn was scripted for a structured() call.", { code: "script", provider: "scripted", model });
      }
      return {
        text: t.thought ?? "",
        toolCalls: t.calls.map((c, i) => ({ id: `scripted_${step}_${i}`, name: c.name, args: c.args })),
        stopReason: "tool_use",
      };
    case "final":
      return { text: t.text, toolCalls: [], stopReason: "end_turn" };
    case "structured":
      return { text: t.raw ?? JSON.stringify(t.output ?? null), toolCalls: [], stopReason: "end_turn" };
  }
}
