"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** A PayPal (or Good Faith) identifier in monospace, copyable, with an optional label. */
export function IdChip({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be unavailable (insecure origin); the id stays selectable.
    }
  };
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5", className)}>
      {label && <span className="shrink-0 text-xs text-muted-foreground">{label}</span>}
      <code className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.78rem] tracking-tight select-all">{value}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `Copied ${label ?? "id"}` : `Copy ${label ?? "id"} ${value}`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      </button>
    </span>
  );
}
