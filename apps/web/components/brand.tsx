import { cn } from "@/lib/utils";

/** The Good Faith mark: a notched seal (a bond, a promise) around a check. */
export function SealMark({ className }: { className?: string }) {
  const teeth = 16;
  const points: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (Math.PI * i) / teeth - Math.PI / 2;
    const r = i % 2 === 0 ? 15.5 : 13.6;
    points.push(`${(16 + r * Math.cos(a)).toFixed(2)},${(16 + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7", className)}>
      <polygon points={points.join(" ")} className="fill-primary" />
      <circle cx="16" cy="16" r="10.2" className="fill-none stroke-primary-foreground/45" strokeWidth="1" />
      <path d="M11.2 16.4l3.2 3.1 6.6-7" className="fill-none stroke-primary-foreground" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SealMark />
      <span className="font-display text-[1.35rem] leading-none tracking-tight">Good Faith</span>
    </span>
  );
}
