import { formatMoney, type Money as MoneyValue } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Money with monospace precision: "$1,500.00" (+ the currency code where it matters). */
export function Money({ value, code, className }: { value?: MoneyValue; code?: boolean; className?: string }) {
  if (!value) return <span className={cn("font-mono text-muted-foreground", className)}>—</span>;
  return <span className={cn("font-mono tabular whitespace-nowrap", className)}>{formatMoney(value, { code })}</span>;
}
