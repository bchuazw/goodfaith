import { CircleCheckIcon, HourglassIcon, InfoIcon, type LucideIcon, ScanSearchIcon, TriangleAlertIcon } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ReportView } from "@/lib/view-types";

type Step = { icon: LucideIcon; tone: string; title: string; body: string };

/** What happens next, in the researcher's terms. */
export function nextStep(v: ReportView): Step {
  const deposit = v.deposit ? formatMoney(v.deposit.amount) : "$20.00";
  if (v.status === "awaiting_deposit") {
    return { icon: HourglassIcon, tone: "text-muted-foreground", title: "Post the refundable deposit", body: `Triage starts once PayPal places the ${deposit} hold. It is not a charge: honest reports get it back in full.` };
  }
  if (v.status === "queued" || v.status === "triaging") {
    return { icon: ScanSearchIcon, tone: "text-primary", title: "Reproducing your report", body: "Claude is checking the cited code and replaying the PoC against a fresh, sandboxed Lantern. This usually takes under a minute." };
  }
  if (v.status === "triage_failed") {
    return { icon: TriangleAlertIcon, tone: "text-danger-strong", title: "Triage could not finish", body: "A maintainer has been notified and can re-run it. Your deposit stays on hold, and a hold is never charged without a human decision." };
  }
  const s = v.settlement;
  if (s?.status === "done") {
    if (s.action === "pay") return { icon: CircleCheckIcon, tone: "text-success-strong", title: `Bounty paid: ${s.amount ? formatMoney(s.amount) : ""}`, body: `Sent with PayPal Payouts${v.deposit ? `, and your ${deposit} hold was released` : ""}.` };
    if (s.action === "release") return { icon: CircleCheckIcon, tone: "text-success-strong", title: "Deposit released", body: `The ${deposit} hold was voided in full. Nothing was charged.` };
    return { icon: InfoIcon, tone: "text-danger-strong", title: "Deposit captured", body: `A maintainer confirmed the report was fabricated, so the ${deposit} hold was captured for the maintainers' fund. You can dispute it in PayPal; Good Faith answers with this evidence.` };
  }
  if (v.kind === "free") return { icon: InfoIcon, tone: "text-muted-foreground", title: "Free report received", body: "A maintainer will read the triage. Free reports carry no deposit and no bounty." };
  switch (v.verdict?.verdict) {
    case "REPRODUCED":
      return { icon: CircleCheckIcon, tone: "text-success-strong", title: "Verified: awaiting the payout", body: "Your PoC reproduced. A maintainer approves the bounty; your deposit is released at the same time." };
    case "DUPLICATE":
      return { icon: InfoIcon, tone: "text-primary", title: "Already reported", body: "An earlier verified report covers this. Honest duplicates cost nothing: the deposit is released in full." };
    case "SLOP":
      return { icon: TriangleAlertIcon, tone: "text-danger-strong", title: "Flagged as fabricated", body: "A maintainer reviews the evidence before anything happens. Only a human can capture a deposit." };
    default:
      return { icon: HourglassIcon, tone: "text-warning-strong", title: "With a maintainer", body: "Automated checks were inconclusive, so a person will read it. Your deposit stays on hold meanwhile." };
  }
}

export function NextStep({ view }: { view: ReportView }) {
  const step = nextStep(view);
  return (
    <div className="flex gap-3">
      <step.icon className={cn("mt-0.5 size-5 shrink-0", step.tone)} aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">{step.title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
      </div>
    </div>
  );
}
