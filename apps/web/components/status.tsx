/** Status vocabulary: every state ships as icon + text (never color alone). */
import type { Severity, Verdict } from "@goodfaith/core";
import {
  BanknoteIcon,
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleXIcon,
  CopyCheckIcon,
  HandCoinsIcon,
  HourglassIcon,
  LoaderCircleIcon,
  LockIcon,
  LockOpenIcon,
  type LucideIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  UserRoundSearchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DepositStatus, ReportStatus } from "@/lib/view-types";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "seal";

const TONE: Record<Tone, string> = {
  success: "bg-success-soft text-success-strong ring-success/30",
  warning: "bg-warning-soft text-warning-strong ring-warning/35",
  danger: "bg-danger-soft text-danger-strong ring-danger/30",
  info: "bg-accent text-accent-foreground ring-primary/20",
  neutral: "bg-muted text-muted-foreground ring-foreground/10",
  seal: "bg-[color-mix(in_oklch,var(--seal)_16%,transparent)] text-seal-strong ring-seal/35",
};

export const toneText: Record<Tone, string> = {
  success: "text-success-strong",
  warning: "text-warning-strong",
  danger: "text-danger-strong",
  info: "text-primary",
  neutral: "text-muted-foreground",
  seal: "text-seal-strong",
};

export function StatusPill({
  tone,
  icon: Icon,
  children,
  spin,
  size = "sm",
  className,
  title,
}: {
  tone: Tone;
  icon: LucideIcon;
  children: React.ReactNode;
  spin?: boolean;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap ring-1 ring-inset",
        size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-[0.8rem]",
        TONE[tone],
        className,
      )}
    >
      <Icon aria-hidden className={cn(size === "sm" ? "size-3.5" : "size-4", spin && "animate-spin")} />
      {children}
    </span>
  );
}

type Meta = { tone: Tone; icon: LucideIcon; label: string; spin?: boolean };

export const VERDICT_META: Record<Verdict, Meta & { blurb: string }> = {
  REPRODUCED: { tone: "success", icon: ShieldCheckIcon, label: "Reproduced", blurb: "The PoC leaked a canary in the sandbox. Proof, not opinion." },
  DUPLICATE: { tone: "info", icon: CopyCheckIcon, label: "Duplicate", blurb: "Same class and component as an earlier verified report." },
  NEEDS_HUMAN: { tone: "warning", icon: UserRoundSearchIcon, label: "Needs human", blurb: "Inconclusive. Nothing proves it, nothing disproves it." },
  SLOP: { tone: "danger", icon: ShieldXIcon, label: "Slop", blurb: "Hard evidence of fabrication, and nothing reproduced." },
};

export function VerdictBadge({ verdict, pending, size }: { verdict?: Verdict; pending?: boolean; size?: "sm" | "md" }) {
  if (!verdict) {
    return pending ? (
      <StatusPill tone="neutral" icon={LoaderCircleIcon} spin size={size}>
        Triaging
      </StatusPill>
    ) : (
      <StatusPill tone="neutral" icon={CircleDashedIcon} size={size}>
        No verdict
      </StatusPill>
    );
  }
  const m = VERDICT_META[verdict];
  return (
    <StatusPill tone={m.tone} icon={m.icon} size={size}>
      {m.label}
    </StatusPill>
  );
}

const DEPOSIT_META: Record<DepositStatus, Meta> = {
  CREATED: { tone: "neutral", icon: HourglassIcon, label: "Awaiting approval" },
  APPROVED: { tone: "neutral", icon: LoaderCircleIcon, label: "Approved, authorizing", spin: true },
  AUTHORIZED: { tone: "info", icon: LockIcon, label: "Held" },
  VOIDING: { tone: "info", icon: LoaderCircleIcon, label: "Releasing", spin: true },
  VOIDED: { tone: "success", icon: LockOpenIcon, label: "Released" },
  CAPTURING: { tone: "danger", icon: LoaderCircleIcon, label: "Capturing", spin: true },
  CAPTURED: { tone: "danger", icon: HandCoinsIcon, label: "Captured" },
  FAILED: { tone: "danger", icon: CircleAlertIcon, label: "Failed" },
};

export function DepositBadge({ status, size }: { status?: DepositStatus; size?: "sm" | "md" }) {
  if (!status) {
    return (
      <StatusPill tone="neutral" icon={CircleDashedIcon} size={size}>
        No deposit
      </StatusPill>
    );
  }
  const m = DEPOSIT_META[status];
  return (
    <StatusPill tone={m.tone} icon={m.icon} spin={m.spin} size={size}>
      {m.label}
    </StatusPill>
  );
}

export function payoutMeta(status: string): Meta {
  switch (status) {
    case "SUCCESS":
      return { tone: "success", icon: BanknoteIcon, label: "Paid" };
    case "UNCLAIMED":
      return { tone: "warning", icon: HourglassIcon, label: "Unclaimed" };
    case "ONHOLD":
      return { tone: "warning", icon: HourglassIcon, label: "On hold" };
    case "FAILED":
    case "RETURNED":
    case "BLOCKED":
    case "REFUNDED":
    case "REVERSED":
    case "DENIED":
      return { tone: "danger", icon: CircleXIcon, label: status.charAt(0) + status.slice(1).toLowerCase() };
    default:
      return { tone: "info", icon: LoaderCircleIcon, label: "Pending", spin: true };
  }
}

export function PayoutBadge({ status, size }: { status?: string; size?: "sm" | "md" }) {
  if (!status) {
    return (
      <StatusPill tone="neutral" icon={CircleDashedIcon} size={size}>
        No payout
      </StatusPill>
    );
  }
  const m = payoutMeta(status);
  return (
    <StatusPill tone={m.tone} icon={m.icon} spin={m.spin} size={size}>
      {m.label}
    </StatusPill>
  );
}

const REPORT_META: Record<ReportStatus, Meta> = {
  awaiting_deposit: { tone: "neutral", icon: HourglassIcon, label: "Awaiting deposit" },
  queued: { tone: "neutral", icon: LoaderCircleIcon, label: "Queued", spin: true },
  triaging: { tone: "info", icon: LoaderCircleIcon, label: "Triaging", spin: true },
  triaged: { tone: "seal", icon: CircleAlertIcon, label: "Awaiting decision" },
  settled: { tone: "success", icon: CircleCheckIcon, label: "Settled" },
  triage_failed: { tone: "danger", icon: CircleXIcon, label: "Triage failed" },
};

export function ReportStatusBadge({ status, size }: { status: ReportStatus; size?: "sm" | "md" }) {
  const m = REPORT_META[status];
  return (
    <StatusPill tone={m.tone} icon={m.icon} spin={m.spin} size={size}>
      {m.label}
    </StatusPill>
  );
}

const SEVERITY_DOT: Record<Severity, string> = {
  low: "bg-muted-foreground/60",
  medium: "bg-warning",
  high: "bg-danger",
  critical: "bg-danger ring-2 ring-danger/30",
};

export function SeverityLabel({ level, muted }: { level?: Severity; muted?: boolean }) {
  if (!level) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm capitalize", muted && "text-muted-foreground")}>
      <span aria-hidden className={cn("size-2 rounded-full", SEVERITY_DOT[level])} />
      {level}
    </span>
  );
}

export function FindingIcon({ status, className }: { status: "pass" | "fail" | "inconclusive"; className?: string }) {
  if (status === "pass") return <CircleCheckIcon aria-label="Pass" className={cn("size-4 text-success", className)} />;
  if (status === "fail") return <CircleXIcon aria-label="Fail" className={cn("size-4 text-danger", className)} />;
  return <CircleHelpIcon aria-label="Inconclusive" className={cn("size-4 text-warning-strong", className)} />;
}

export const FINDING_LABEL = { pass: "Pass", fail: "Fail", inconclusive: "Inconclusive" } as const;

export { BanIcon };
