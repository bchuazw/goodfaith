"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { NativeSelect } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type EditableStep = { key: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; as: string; body: string };

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const MAX_STEPS = 20;

let counter = 0;
export const newStep = (over: Partial<EditableStep> = {}): EditableStep => ({ key: `s${++counter}`, method: "GET", path: "/", as: "alice", body: "", ...over });

/** Problems per step, mirroring @goodfaith/core's httpPocStepSchema. */
export function stepErrors(step: EditableStep): string | undefined {
  if (!step.path.startsWith("/") || step.path.startsWith("//")) return "Use a path on the target, starting with / (absolute URLs are rejected)";
  if (step.path.length > 2048) return "Path is longer than 2,048 characters";
  if (new TextEncoder().encode(step.body).length > 64 * 1024) return "Body is larger than 64 KiB";
  return undefined;
}

export function PocEditor({
  steps,
  onChange,
  accounts,
  showErrors,
}: {
  steps: EditableStep[];
  onChange: (steps: EditableStep[]) => void;
  accounts: Array<{ id: string; description: string }>;
  showErrors?: boolean;
}) {
  const update = (key: string, patch: Partial<EditableStep>) => onChange(steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    if (s) next.splice(i + by, 0, s);
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <ol className="space-y-2.5">
        {steps.map((step, i) => {
          const error = showErrors ? stepErrors(step) : undefined;
          const withBody = step.method !== "GET";
          return (
            <li key={step.key} className={cn("rounded-xl bg-muted/50 p-3 ring-1 ring-foreground/5", error && "ring-danger/40")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 font-mono text-xs text-muted-foreground tabular">{i + 1}.</span>
                <NativeSelect aria-label={`Step ${i + 1} method`} value={step.method} onChange={(e) => update(step.key, { method: e.target.value as EditableStep["method"] })} className="w-[6.5rem] font-mono">
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </NativeSelect>
                <Input
                  aria-label={`Step ${i + 1} path`}
                  aria-invalid={!!error}
                  value={step.path}
                  onChange={(e) => update(step.key, { path: e.target.value })}
                  placeholder="/api/notes/note_2"
                  className="min-w-0 flex-1 basis-48 font-mono text-[0.8rem]"
                  spellCheck={false}
                  autoComplete="off"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  act as
                  <NativeSelect aria-label={`Step ${i + 1} account`} value={step.as} onChange={(e) => update(step.key, { as: e.target.value })} className="w-[7.5rem] font-mono">
                    <option value="anonymous">anonymous</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.id}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <div className="ml-auto flex items-center">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUpIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDownIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => onChange(steps.filter((s) => s.key !== step.key))}>
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
              {withBody && (
                <Textarea
                  aria-label={`Step ${i + 1} body`}
                  value={step.body}
                  onChange={(e) => update(step.key, { body: e.target.value })}
                  placeholder='{"role": "admin"}'
                  className="mt-2 min-h-14 font-mono text-[0.78rem]"
                  spellCheck={false}
                />
              )}
              {error && <p className="mt-1.5 text-xs text-danger-strong">{error}</p>}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...steps, newStep({ as: steps.at(-1)?.as ?? "alice" })])} disabled={steps.length >= MAX_STEPS}>
          <PlusIcon /> Add step
        </Button>
        <p className="text-xs text-muted-foreground">The sandbox signs each step in as the chosen account; Host, Cookie and Authorization are set for you.</p>
      </div>
    </div>
  );
}
