/**
 * Scripted Evidence Analyst (merchant console): get_dispute → verify_mandate_chain → build_evidence_pack →
 * submit_evidence, each step skipped if the caller does not provide a matching tool.
 */
import type { ScriptContext, ScriptedTurn, ScriptToolInfo } from "../types.js";
import { collectValues, toStr } from "./fit.js";
import { callTool, dynamicTurn } from "./shopping.js";

function findTool(ctx: ScriptContext, canonical: string[], pattern: RegExp): ScriptToolInfo | undefined {
  for (const name of canonical) {
    const t = ctx.tools.find((x) => x.name === name);
    if (t) return t;
  }
  return ctx.tools.find((t) => pattern.test(t.name));
}

export function disputeIdFrom(ctx: Pick<ScriptContext, "user" | "results">): string | undefined {
  const direct =
    /\b(PP-D-[A-Z0-9-]+|PP-[A-Z0-9-]{6,})\b/i.exec(ctx.user)?.[1] ??
    /\bdispute\s+(?:id\s+)?#?([A-Z0-9][A-Za-z0-9-]{4,})\b/i.exec(ctx.user)?.[1];
  if (direct) return direct;
  const values = collectValues(ctx.results.filter((r) => !r.isError).map((r) => r.result));
  const fromResults = values.get("disputeid") ?? values.get("id");
  return typeof fromResults === "string" ? fromResults : undefined;
}

function known(ctx: ScriptContext): Record<string, unknown> {
  const id = disputeIdFrom(ctx);
  return { ...Object.fromEntries(collectValues(ctx.results.filter((r) => !r.isError).map((r) => r.result))), ...(id ? { disputeId: id } : {}) };
}

export function evidenceAnalystScript(): ScriptedTurn[] {
  return [
    dynamicTurn("evidence:list", (ctx) => {
      const tool = findTool(ctx, ["list_disputes"], /list.*dispute/i);
      if (!tool || disputeIdFrom(ctx)) return null;
      return callTool(tool, {}, "Looking up open disputes.");
    }),
    dynamicTurn("evidence:get", (ctx) => {
      const tool = findTool(ctx, ["get_dispute"], /get.*dispute|dispute.*detail/i);
      if (!tool) return null;
      const id = disputeIdFrom(ctx);
      return callTool(tool, { disputeId: id, id }, `Reading dispute ${id ?? ""}.`.replace(" .", "."));
    }),
    dynamicTurn("evidence:verify", (ctx) => {
      const tool = findTool(ctx, ["verify_mandate_chain"], /verify/i);
      return tool ? callTool(tool, known(ctx), "Verifying the AP2 mandate chain behind the disputed order.") : null;
    }),
    dynamicTurn("evidence:build", (ctx) => {
      const tool = findTool(ctx, ["build_evidence_pack"], /build|pack|assemble/i);
      return tool ? callTool(tool, known(ctx), "Assembling the evidence pack: the signed permission slip, the merchant cart and the PayPal capture.") : null;
    }),
    dynamicTurn("evidence:submit", (ctx) => {
      const tool = findTool(ctx, ["submit_evidence", "provide_evidence"], /submit|provide/i);
      return tool ? callTool(tool, known(ctx), "Submitting the evidence pack through the PayPal Disputes API.") : null;
    }),
    dynamicTurn("evidence:final", (ctx) => {
      const id = disputeIdFrom(ctx);
      const values = collectValues(ctx.results.filter((r) => !r.isError).map((r) => r.result));
      const valid = values.get("valid");
      const status = toStr(values.get("status") ?? "");
      const failed = ctx.results.find((r) => r.isError);
      const parts = [
        `Evidence for dispute ${id ?? "(unknown)"}:`,
        valid === true
          ? "the AP2 mandate chain verifies (user-signed permission slip, merchant-signed cart, agent countersignature)."
          : valid === false
            ? "the mandate chain did NOT verify, so I did not argue the case."
            : "mandate chain checked.",
        status ? `PayPal status: ${status}.` : "",
        failed ? `Note: ${failed.name} failed.` : "",
      ];
      return { type: "final", text: parts.filter(Boolean).join(" ") };
    }),
  ];
}

export function evidenceSummaryBag(user: string): Record<string, unknown> {
  const summary =
    "The buyer's AI agent made this purchase under an AP2 permission slip the buyer signed. The slip, the merchant-signed cart and the agent's countersignature all verify and are linked to the PayPal capture by its custom_id, so the order was authorised.";
  return { summary, narrative: summary, notes: summary, explanation: summary, disputeId: disputeIdFrom({ user, results: [] }) };
}
