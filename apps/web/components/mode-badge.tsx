"use client";

import { FlaskConicalIcon, ShieldCheckIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModeView } from "@/lib/view-types";

/** MOCK whenever anything is simulated; otherwise which real services are live (always the PayPal sandbox here). */
export function ModeBadge({ mode }: { mode: ModeView }) {
  const mocked = mode.mocks.length > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        {mocked ? (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 font-mono text-[0.7rem] font-semibold tracking-[0.12em] text-warning-strong ring-1 ring-warning/40 ring-inset"
            aria-label="Mock mode: see what is simulated"
          >
            <FlaskConicalIcon className="size-3.5" aria-hidden />
            MOCK
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-accent px-2.5 text-xs font-medium text-accent-foreground ring-1 ring-primary/20 ring-inset"
            aria-label="Live services: see details"
          >
            <ShieldCheckIcon className="size-3.5" aria-hidden />
            {mode.paypal === "live" ? "PayPal live" : "PayPal sandbox"}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        {mocked ? (
          <div className="space-y-2">
            <p className="font-medium">Mock mode: nothing here touches real services.</p>
            <ul className="space-y-1.5 text-muted-foreground">
              {mode.mocks.map((m) => (
                <li key={m} className="flex gap-2">
                  <FlaskConicalIcon className="mt-0.5 size-3.5 shrink-0 text-warning-strong" aria-hidden />
                  {m}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Set GOODFAITH_MODE=live to use the real PayPal sandbox and Claude.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="font-medium">Live services</p>
            <p className="text-muted-foreground">
              PayPal <span className="font-mono text-foreground">{mode.paypal}</span>
              {mode.paypal === "sandbox" ? " (test money only)" : ""}
            </p>
            <p className="text-muted-foreground">
              Triage model <span className="font-mono text-foreground">{mode.llm.model}</span> ({mode.llm.provider})
              {mode.llm.fallbacks?.map((f) => (
                <span key={`${f.provider}/${f.model}`}>
                  , then <span className="font-mono text-foreground">{f.model}</span> ({f.provider}) if it is unavailable
                </span>
              ))}
            </p>
            <p className="text-muted-foreground">
              Store <span className="font-mono text-foreground">{mode.store}</span>
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
