import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One number with its label: big, tabular, monospace when it is money. */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  mono,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-card p-4 ring-1 ring-foreground/10", className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {label}
      </p>
      <p className={cn("mt-2 text-2xl font-semibold tracking-tight tabular", mono && "font-mono text-[1.4rem]")}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
