import type { Finding } from "@goodfaith/core";
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, CopyCheckIcon, GaugeIcon, type LucideIcon, SyringeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Display = { icon: LucideIcon; className: string; label: string };

/** How a finding reads at a glance. A duplicate match or an injection is shown for what it is, not as pass/fail. */
export function findingDisplay(f: Finding): Display {
  if (f.kind === "duplicate" && f.status !== "fail" && /^duplicate of/i.test(f.title)) return { icon: CopyCheckIcon, className: "text-primary", label: "Duplicate" };
  if (f.kind === "injection") return { icon: SyringeIcon, className: "text-danger", label: "Injection" };
  if (f.kind === "severity" && f.status === "inconclusive") return { icon: GaugeIcon, className: "text-muted-foreground", label: "Assessment" };
  if (f.status === "pass") return { icon: CircleCheckIcon, className: "text-success", label: "Pass" };
  if (f.status === "fail") return { icon: CircleXIcon, className: "text-danger", label: "Fail" };
  return { icon: CircleHelpIcon, className: "text-warning-strong", label: "Inconclusive" };
}

/** Quotes found by the injection check, shown as quarantined text. */
export function injectionQuotes(f: Finding): string[] {
  const signals = (f.evidence?.signals ?? f.evidence?.quotes) as Array<{ quote?: string } | string> | undefined;
  if (!Array.isArray(signals)) return [];
  return signals.map((s) => (typeof s === "string" ? s : (s.quote ?? ""))).filter(Boolean);
}

export function FindingRow({ finding, compact }: { finding: Finding; compact?: boolean }) {
  const d = findingDisplay(finding);
  const quotes = finding.kind === "injection" ? injectionQuotes(finding) : [];
  return (
    <div className="flex gap-2.5 animate-rise-in">
      <d.icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", d.className)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <span className="sr-only">{d.label}: </span>
          {finding.title}
        </p>
        {!compact && finding.detail && <p className="mt-0.5 text-[0.8rem] leading-relaxed text-muted-foreground">{finding.detail}</p>}
        {quotes.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {quotes.slice(0, compact ? 1 : 3).map((q) => (
              <blockquote key={q} className="rounded-md border-l-2 border-danger bg-danger-soft/70 px-2.5 py-1.5 font-mono text-[0.72rem] leading-relaxed text-danger-strong">
                <span className="mr-1.5 font-sans text-[0.65rem] font-semibold tracking-wider uppercase">Untrusted text</span>
                {q}
              </blockquote>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
