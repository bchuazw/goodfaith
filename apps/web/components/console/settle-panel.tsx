"use client";

import type { Severity } from "@goodfaith/core";
import { BanknoteIcon, HandCoinsIcon, LoaderCircleIcon, LockOpenIcon, RefreshCwIcon, RotateCcwIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { NativeSelect } from "@/components/form";
import { IdChip } from "@/components/id-chip";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { formatMoney, type Money as MoneyValue } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ActionOption, ReportView, SettlementAction } from "@/lib/view-types";

const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const MIN_REASON = 12;

type Props = { view: ReportView; bounties: Record<Severity, MoneyValue>; onUpdated: (v: ReportView) => void };

async function settle(id: string, body: Record<string, unknown>): Promise<ReportView> {
  return api<ReportView>(`/api/reports/${id}/settle`, { body });
}

/** Pay, release or capture, each behind a confirmation that says exactly which PayPal calls will run. */
export function SettlePanel({ view, bounties, onUpdated }: Props) {
  const options = view.options;
  const [open, setOpen] = useState<SettlementAction>();
  const [busy, setBusy] = useState<string>();
  const s = view.settlement;
  if (!options) return null;

  const run = async (label: string, body: Record<string, unknown>, success: string) => {
    setBusy(label);
    try {
      const next = await settle(view.id, body);
      onUpdated(next);
      setOpen(undefined);
      toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const rerun = async () => {
    setBusy("rerun");
    try {
      onUpdated(await api<ReportView>(`/api/reports/${view.id}/triage`, { body: {} }));
      toast.success("Triage restarted");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const refreshPayout = async () => {
    setBusy("payout");
    try {
      onUpdated(await api<ReportView>(`/api/reports/${view.id}/payout`, { body: {} }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const deposit = view.deposit;
  // The action triage points to gets the emphasis; the others stay available but quiet.
  const verdict = view.verdict?.verdict;
  const recommended: SettlementAction | undefined =
    s?.action ?? (verdict === "REPRODUCED" ? "pay" : verdict === "SLOP" ? "capture" : verdict ? "release" : undefined);
  const toneFor = (a: SettlementAction): "primary" | "danger" | undefined => (a !== recommended ? undefined : a === "capture" ? "danger" : "primary");
  const canRerun = !s && (view.status === "triaged" || view.status === "triage_failed");

  return (
    <div className="space-y-4">
      {s?.status === "done" ? (
        <SettledSummary view={view} />
      ) : (
        <>
          {s?.status === "failed" && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-strong" role="alert">
              The {s.action} did not finish: {s.error?.message}
              {s.error?.debugId && <span className="block font-mono text-xs">PayPal debug id {s.error.debugId}</span>}
              Retrying is safe: it repeats the same PayPal calls with the same request ids.
            </p>
          )}
          <ActionButton
            icon={BanknoteIcon}
            label={s?.action === "pay" ? "Retry the payout" : "Pay the bounty"}
            sub={options.pay.allowed ? (options.pay.needs === "override" ? "Needs an override reason" : "Voids the deposit, pays via PayPal Payouts") : options.pay.reason}
            option={options.pay}
            tone={toneFor("pay")}
            onClick={() => setOpen("pay")}
          />
          <ActionButton
            icon={LockOpenIcon}
            label={s?.action === "release" ? "Retry the release" : "Release the deposit"}
            sub={options.release.allowed ? "Voids the hold in full" : options.release.reason}
            option={options.release}
            tone={toneFor("release")}
            onClick={() => setOpen("release")}
          />
          <ActionButton
            icon={HandCoinsIcon}
            label={s?.action === "capture" ? "Retry the capture" : "Capture the deposit"}
            sub={options.capture.allowed ? "Slop only, with confirmation" : options.capture.reason}
            option={options.capture}
            tone={toneFor("capture")}
            onClick={() => setOpen("capture")}
          />
        </>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {canRerun && (
          <Button size="sm" variant="ghost" onClick={rerun} disabled={!!busy}>
            {busy === "rerun" ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />} Re-run triage
          </Button>
        )}
        {view.payout?.batchId && (
          <Button size="sm" variant="ghost" onClick={refreshPayout} disabled={!!busy}>
            {busy === "payout" ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />} Refresh payout from PayPal
          </Button>
        )}
      </div>

      <PayDialog open={open === "pay"} onOpenChange={(o) => setOpen(o ? "pay" : undefined)} view={view} bounties={bounties} busy={busy === "pay"} onConfirm={(severity, reason) => run("pay", { action: "pay", severity, ...(reason ? { overrideReason: reason } : {}) }, "Bounty sent with PayPal Payouts")} />
      <ReleaseDialog open={open === "release"} onOpenChange={(o) => setOpen(o ? "release" : undefined)} view={view} busy={busy === "release"} onConfirm={(note) => run("release", { action: "release", ...(note ? { note } : {}) }, "Deposit released")} />
      <CaptureDialog open={open === "capture"} onOpenChange={(o) => setOpen(o ? "capture" : undefined)} view={view} busy={busy === "capture"} onConfirm={() => run("capture", { action: "capture", confirm: true }, "Deposit captured")} />
      {deposit && !s && <p className="text-xs leading-relaxed text-muted-foreground">One resolution per deposit: the first void or capture claimed wins, enforced on the server and by PayPal.</p>}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  sub,
  option,
  tone,
  onClick,
}: {
  icon: typeof BanknoteIcon;
  label: string;
  sub?: string;
  option: ActionOption;
  tone?: "primary" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!option.allowed}
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left ring-1 ring-foreground/10 transition-colors disabled:cursor-not-allowed",
        option.allowed && tone === "primary" && "bg-primary text-primary-foreground ring-primary hover:bg-primary/90",
        option.allowed && tone === "danger" && "bg-danger-soft text-danger-strong ring-danger/40 hover:bg-danger/15",
        option.allowed && !tone && "bg-card hover:bg-muted",
        !option.allowed && "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {sub && <span className={cn("block text-xs", option.allowed && tone === "primary" ? "text-primary-foreground/80" : "opacity-80")}>{sub}</span>}
      </span>
    </button>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular">{i + 1}.</span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function PayDialog({
  open,
  onOpenChange,
  view,
  bounties,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  view: ReportView;
  bounties: Record<Severity, MoneyValue>;
  busy: boolean;
  onConfirm: (severity: Severity, reason?: string) => void;
}) {
  const locked = view.payout?.severity ?? view.settlement?.severity;
  const [severity, setSeverity] = useState<Severity>(locked ?? view.verdict?.suggestedSeverity?.level ?? view.claimedSeverity ?? "medium");
  const [reason, setReason] = useState(view.settlement?.overrideReason ?? "");
  const needsOverride = view.options?.pay.needs === "override";
  const amount = view.payout?.amount ?? bounties[severity];
  const receiver = view.payoutEmail ?? view.deposit?.payer;
  const ok = !needsOverride || reason.trim().length >= MIN_REASON;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pay the bounty</DialogTitle>
          <DialogDescription>{needsOverride ? `The verdict is ${view.verdict?.verdict ?? "not in yet"}. Paying anyway needs your reason on the record.` : "Triage reproduced this report in the sandbox."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">Severity</span>
            <NativeSelect value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} disabled={!!locked} className="w-36 capitalize" aria-label="Severity to pay">
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s} · {formatMoney(bounties[s])}
                </option>
              ))}
            </NativeSelect>
          </label>
          {view.verdict?.suggestedSeverity && (
            <p className="text-xs text-muted-foreground">
              Claude suggests <strong className="text-foreground capitalize">{view.verdict.suggestedSeverity.level}</strong>
              {view.verdict.suggestedSeverity.cvss && <span className="font-mono"> · {view.verdict.suggestedSeverity.cvss}</span>}. {view.verdict.suggestedSeverity.rationale}
            </p>
          )}
          {needsOverride && (
            <div className="space-y-1.5">
              <label htmlFor="override" className="text-sm font-medium">
                Override reason
              </label>
              <Textarea id="override" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this should be paid although triage did not reproduce it" aria-invalid={reason.length > 0 && !ok} />
              <p className="text-xs text-muted-foreground">At least {MIN_REASON} characters. Stored with the settlement.</p>
            </div>
          )}
          <Steps
            items={[
              view.deposit ? (
                <>
                  Void the <Money value={view.deposit.amount} /> hold{view.deposit.authorizationId && <> (authorization <span className="font-mono text-xs">{view.deposit.authorizationId}</span>)</>}.
                </>
              ) : (
                <>No deposit to void (trusted researcher).</>
              ),
              <>
                Send <Money value={amount} /> with PayPal Payouts to <span className="font-mono text-xs">{receiver ?? "the deposit's payer"}</span>, sender batch <span className="font-mono text-xs">gf-{view.id}</span>. PayPal pays a batch id once.
              </>,
            ]}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={() => onConfirm(severity, needsOverride ? reason.trim() : undefined)} disabled={!ok || busy}>
            {busy && <LoaderCircleIcon className="animate-spin" />}Pay {formatMoney(amount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseDialog({ open, onOpenChange, view, busy, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; view: ReportView; busy: boolean; onConfirm: (note?: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Release the deposit</DialogTitle>
          <DialogDescription>For honest reports that will not be paid: duplicates, out-of-scope or invalid-but-sincere findings.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Steps
            items={[
              <>
                Void the {view.deposit ? <Money value={view.deposit.amount} /> : "deposit"} hold{view.deposit?.authorizationId && <> (authorization <span className="font-mono text-xs">{view.deposit.authorizationId}</span>)</>}. The researcher is
                charged nothing.
              </>,
            ]}
          />
          <div className="space-y-1.5">
            <label htmlFor="release-note" className="text-sm font-medium">
              Note to the researcher <span className="text-xs font-normal text-muted-foreground">optional</span>
            </label>
            <Textarea id="release-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Thanks: this was already reported." />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={() => onConfirm(note.trim() || undefined)} disabled={busy}>
            {busy && <LoaderCircleIcon className="animate-spin" />}Release deposit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CaptureDialog({ open, onOpenChange, view, busy, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; view: ReportView; busy: boolean; onConfirm: () => void }) {
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const ok = checked && typed.trim().toUpperCase() === "CAPTURE";
  const signals = view.verdict?.slopSignals ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setChecked(false);
          setTyped("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-danger-strong">
            <ShieldAlertIcon className="size-5" aria-hidden /> Capture the deposit
          </DialogTitle>
          <DialogDescription>Only for reports you have reviewed and judge fabricated. The researcher can dispute it in PayPal; Good Faith answers with the triage evidence.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {signals.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Hard evidence</p>
              <ul className="space-y-1 text-sm">
                {signals.map((sig) => (
                  <li key={sig} className="flex gap-2">
                    <span aria-hidden className="text-danger">•</span>
                    {sig}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Steps
            items={[
              <>
                Capture the {view.deposit ? <Money value={view.deposit.amount} /> : "deposit"} authorization{view.deposit?.authorizationId && <> <span className="font-mono text-xs">{view.deposit.authorizationId}</span></>} into the maintainers&apos; fund. It
                cannot be released afterwards.
              </>,
            ]}
          />
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger)]" />
            I reviewed the evidence and confirm this report is fabricated.
          </label>
          <div className="space-y-1.5">
            <label htmlFor="capture-confirm" className="text-sm font-medium">
              Type <span className="font-mono">CAPTURE</span> to confirm
            </label>
            <Input id="capture-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={!ok || busy}>
            {busy && <LoaderCircleIcon className="animate-spin" />}Capture {view.deposit ? formatMoney(view.deposit.amount) : "deposit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettledSummary({ view }: { view: ReportView }) {
  const s = view.settlement;
  if (!s) return null;
  const title = s.action === "pay" ? "Bounty paid" : s.action === "release" ? "Deposit released" : "Deposit captured";
  const Icon = s.action === "pay" ? BanknoteIcon : s.action === "release" ? LockOpenIcon : HandCoinsIcon;
  return (
    <div className={cn("space-y-2 rounded-xl p-4 ring-1", s.action === "capture" ? "bg-danger-soft ring-danger/30" : "bg-success-soft ring-success/30")}>
      <p className={cn("flex items-center gap-2 font-medium", s.action === "capture" ? "text-danger-strong" : "text-success-strong")}>
        <Icon className="size-4" aria-hidden />
        {title}
        {s.amount && <Money value={s.amount} className="ml-auto" />}
      </p>
      <p className="text-xs text-muted-foreground">
        by {s.actor}
        {s.completedAt && <> · {formatDateTime(s.completedAt)}</>}
        {s.severity && <> · {s.severity} severity</>}
      </p>
      {s.overrideReason && <p className="text-xs">Override: {s.overrideReason}</p>}
      {s.note && <p className="text-xs">Note: {s.note}</p>}
      {view.deposit?.captureId && <IdChip value={view.deposit.captureId} label="Capture" />}
    </div>
  );
}
