import type { TriageVerdict } from "@goodfaith/core";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<string, string> = { anthropic: "Claude", gemini: "Gemini", "openai-compatible": "OpenAI-compatible model" };

/** Who made the triage judgments, in words: "Claude", "Gemini", the scripted heuristics, or nobody. */
export function aiLabel(model: TriageVerdict["model"]): string {
  if (model.mode === "scripted") return "Scripted triage (mock mode)";
  if (model.mode === "degraded") return "Automatic checks only (AI unavailable)";
  return PROVIDER_LABEL[model.provider] ?? model.provider;
}

/** Whose recommendation a verdict is, for headings: "Claude's recommendation", "Automatic checks". */
export function recommendationHeading(model: TriageVerdict["model"]): string {
  if (model.mode === "degraded") return "Automatic checks (AI unavailable)";
  if (model.mode === "scripted") return "Scripted triage recommendation";
  return `${PROVIDER_LABEL[model.provider] ?? "The AI"}'s recommendation`;
}

/** Says plainly that the AI was unavailable, why, and which deterministic checks still ran. */
export function DegradedNotice({ verdict, className }: { verdict: TriageVerdict; className?: string }) {
  const d = verdict.model.mode === "degraded" ? verdict.model.degraded : undefined;
  if (verdict.model.mode !== "degraded") return null;
  return (
    <div role="note" className={cn("rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong", className)}>
      <p className="flex items-center gap-1.5 font-medium">
        <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
        The AI was unavailable, so only the automatic checks ran.
      </p>
      {d?.reason && <p className="mt-1 text-[0.8rem]">{d.reason}.</p>}
      {d?.checks && d.checks.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[0.8rem]">
          {d.checks.map((c) => (
            <li key={c} className="flex gap-1.5">
              <span aria-hidden>✓</span>
              {c}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[0.8rem]">Without the AI&apos;s assessment Good Faith never recommends SLOP. A maintainer decides, and can re-run triage once the AI is back.</p>
    </div>
  );
}
