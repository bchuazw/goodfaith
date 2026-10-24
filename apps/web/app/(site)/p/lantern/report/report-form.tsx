"use client";

import type { Severity } from "@goodfaith/core";
import { CircleCheckIcon, HandshakeIcon, LoaderCircleIcon, ScrollTextIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Field, NativeSelect, SectionHeading } from "@/components/form";
import { Money } from "@/components/money";
import { PayPalCheckout } from "@/components/paypal/paypal-checkout";
import { type EditableStep, newStep, PocEditor, stepErrors } from "@/components/report/poc-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/client/api";
import { HERO_REPORTS, type HeroKey } from "@/lib/hero-reports";
import { formatMoney, type Money as MoneyValue } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ReportView } from "@/lib/view-types";

type Program = {
  id: string;
  name: string;
  versionsInScope: string[];
  accounts: Array<{ id: string; description: string }>;
  bounties: Record<Severity, MoneyValue>;
  deposit: MoneyValue;
};

type FormState = {
  kind: "free" | "bounty";
  title: string;
  version: string;
  severity: Severity | "";
  affectedCode: string;
  description: string;
  impact: string;
  pocMode: "steps" | "text";
  steps: EditableStep[];
  pocNotes: string;
  handle: string;
  payoutEmail: string;
};

const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

const EMPTY: FormState = {
  kind: "bounty",
  title: "",
  version: "1.4.0",
  severity: "",
  affectedCode: "",
  description: "",
  impact: "",
  pocMode: "steps",
  steps: [newStep({ path: "/api/notes/note_1" })],
  pocNotes: "",
  handle: "",
  payoutEmail: "",
};

function validate(f: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (f.title.trim().length < 8) errors.title = "Give it a title of at least 8 characters";
  if (f.description.trim().length < 20) errors.description = "Describe the issue in at least 20 characters";
  const handle = f.handle.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(handle)) errors.handle = "2 to 64 letters, digits, _ . or -";
  if (f.payoutEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.payoutEmail.trim())) errors.payoutEmail = "Enter a valid email";
  if (f.pocMode === "steps" && f.steps.some((s) => stepErrors(s))) errors.poc = "Fix the highlighted PoC steps";
  return errors;
}

function payload(f: FormState) {
  const usesSteps = f.pocMode === "steps" && f.steps.some((s) => s.path.trim() !== "/" && s.path.trim() !== "");
  return {
    programId: "lantern",
    kind: f.kind,
    title: f.title.trim(),
    ...(f.version.trim() ? { claimedVersion: f.version.trim() } : {}),
    ...(f.severity ? { claimedSeverity: f.severity } : {}),
    affectedCode: f.affectedCode,
    description: f.description,
    impact: f.impact,
    ...(f.pocMode === "text" && f.pocNotes.trim() ? { pocNotes: f.pocNotes } : {}),
    ...(usesSteps
      ? { poc: { steps: f.steps.map((s) => ({ method: s.method, path: s.path.trim(), as: s.as, ...(s.method !== "GET" && s.body.trim() ? { body: s.body } : {}) })) } }
      : {}),
    reporter: { handle: f.handle.trim() },
    ...(f.kind === "bounty" && f.payoutEmail.trim() ? { payoutEmail: f.payoutEmail.trim() } : {}),
  };
}

export function ReportForm({ program, paypalMode }: { program: Program; paypalMode: "mock" | "sandbox" | "live" }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // A bounty claim is saved once, then reused if the researcher retries the PayPal step.
  const saved = useRef<{ id: string; fingerprint: string }>(undefined);
  const errors = useMemo(() => validate(form), [form]);
  const visibleErrors = showErrors ? errors : {};
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const loadExample = (key: HeroKey) => {
    const h = HERO_REPORTS[key];
    setForm({
      ...EMPTY,
      kind: "bounty",
      title: h.title,
      version: h.claimedVersion,
      severity: h.claimedSeverity,
      affectedCode: h.affectedCode,
      description: h.description,
      impact: h.impact,
      pocMode: h.poc ? "steps" : "text",
      steps: h.poc ? h.poc.steps.map((s) => newStep({ method: s.method, path: s.path, as: s.as ?? "anonymous", body: s.body ?? "" })) : EMPTY.steps,
      pocNotes: h.pocNotes ?? "",
      handle: h.handle,
      payoutEmail: paypalMode === "mock" ? h.payoutEmail : "",
    });
    setShowErrors(false);
    saved.current = undefined;
    toast.info(`Loaded the "${h.label}" example. Review it, then submit.`);
  };

  const checkValid = () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) {
      toast.error("Some fields need attention.");
      document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return false;
    }
    return true;
  };

  const saveReport = async (): Promise<string> => {
    const body = payload(form);
    const fingerprint = JSON.stringify(body);
    if (saved.current?.fingerprint === fingerprint) return saved.current.id;
    const res = await api<{ report: ReportView; depositRequired: boolean }>("/api/reports", { body });
    saved.current = { id: res.report.id, fingerprint };
    if (!res.depositRequired) {
      // A trusted researcher's claim needs no deposit: triage is already running.
      router.push(`/r/${res.report.id}`);
      throw new Error("TRUSTED_NO_DEPOSIT");
    }
    return res.report.id;
  };

  const submitFree = async () => {
    if (!checkValid()) return;
    setSubmitting(true);
    try {
      const res = await api<{ report: ReportView }>("/api/reports", { body: payload(form) });
      router.push(`/r/${res.report.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setSubmitting(false);
    }
  };

  const bounty = form.kind === "bounty";

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-4 py-3 text-sm">
        <SparklesIcon className="size-4 text-primary" aria-hidden />
        <span className="text-muted-foreground">Trying it out? Load an example:</span>
        {(Object.keys(HERO_REPORTS) as HeroKey[]).map((k) => (
          <Button key={k} type="button" size="sm" variant="outline" onClick={() => loadExample(k)}>
            {HERO_REPORTS[k].label}
          </Button>
        ))}
      </div>

      <section className="space-y-4">
        <SectionHeading step="Step 1" title="Free report or bounty claim?" description="Reporting is always free. Claiming a bounty takes a refundable hold, so only claims someone stands behind cost anything." />
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Report type</legend>
          {(
            [
              { value: "free", icon: ScrollTextIcon, title: "Free report", body: "Best effort. No deposit and no bounty. Triage still runs, and maintainers see the result." },
              { value: "bounty", icon: HandshakeIcon, title: "Bounty claim", body: `Post a refundable ${formatMoney(program.deposit)} PayPal hold. Reproduced reports are paid from the bounty table below.` },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className={cn(
                "relative flex cursor-pointer gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                form.kind === opt.value && "ring-2 ring-primary",
              )}
            >
              <input type="radio" name="kind" value={opt.value} checked={form.kind === opt.value} onChange={() => set("kind", opt.value)} className="sr-only" />
              <opt.icon className={cn("mt-0.5 size-5 shrink-0", form.kind === opt.value ? "text-primary" : "text-muted-foreground")} aria-hidden />
              <span className="space-y-1">
                <span className="block font-medium">{opt.title}</span>
                <span className="block text-sm leading-relaxed text-muted-foreground">{opt.body}</span>
              </span>
              {form.kind === opt.value && <CircleCheckIcon className="absolute top-3 right-3 size-4 text-primary" aria-hidden />}
            </label>
          ))}
        </fieldset>
        {bounty && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            {SEVERITIES.map((s) => (
              <span key={s}>
                <span className="capitalize">{s}</span> <Money value={program.bounties[s]} className="text-foreground" />
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-5">
        <SectionHeading step="Step 2" title="The issue" description="Cite real files and functions: Good Faith checks every one exists at the version you name." />
        <Field id="title" label="Title" error={visibleErrors.title}>
          <Input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={200} aria-invalid={!!visibleErrors.title} placeholder="IDOR: any user can read another user's private notes" />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="version" label="Affected version" hint={`In scope: ${program.versionsInScope.join(", ")}`}>
            <NativeSelect id="version" value={program.versionsInScope.includes(form.version) ? form.version : "other"} onChange={(e) => set("version", e.target.value === "other" ? "" : e.target.value)} className="w-full">
              {program.versionsInScope.map((v) => (
                <option key={v} value={v}>
                  Lantern {v}
                </option>
              ))}
              <option value="other">Other version…</option>
            </NativeSelect>
            {!program.versionsInScope.includes(form.version) && (
              <Input aria-label="Other version" value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="e.g. 1.3.9" className="mt-2 font-mono" />
            )}
          </Field>
          <Field id="severity" label="Claimed severity" optional>
            <div id="severity" role="radiogroup" aria-label="Claimed severity" className="flex flex-wrap gap-1.5">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={form.severity === s}
                  onClick={() => set("severity", form.severity === s ? "" : s)}
                  className={cn("h-8 rounded-lg px-3 text-sm capitalize ring-1 ring-input transition-colors hover:bg-muted", form.severity === s && "bg-primary text-primary-foreground ring-primary hover:bg-primary/90")}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <Field id="affected" label="Affected code" optional hint={<>One per line, e.g. <code className="font-mono">- `src/notes.ts`, `registerNoteRoutes()`</code></>}>
          <Textarea id="affected" value={form.affectedCode} onChange={(e) => set("affectedCode", e.target.value)} className="min-h-16 font-mono text-[0.8rem]" spellCheck={false} />
        </Field>
        <Field id="description" label="Description" error={visibleErrors.description}>
          <Textarea id="description" value={form.description} onChange={(e) => set("description", e.target.value)} className="min-h-28" aria-invalid={!!visibleErrors.description} placeholder="What is wrong, where, and why it is exploitable." />
        </Field>
        <Field id="impact" label="Impact" optional>
          <Textarea id="impact" value={form.impact} onChange={(e) => set("impact", e.target.value)} className="min-h-16" placeholder="What an attacker gains." />
        </Field>
      </section>

      <section className="space-y-4">
        <SectionHeading step="Step 3" title="Proof of concept" description="HTTP steps replay against a fresh, sandboxed Lantern with seeded canary secrets. A leaked canary is proof." />
        <Tabs value={form.pocMode} onValueChange={(v) => set("pocMode", v as FormState["pocMode"])}>
          <TabsList>
            <TabsTrigger value="steps">HTTP steps</TabsTrigger>
            <TabsTrigger value="text">Free text</TabsTrigger>
          </TabsList>
          <TabsContent value="steps" className="pt-3">
            <PocEditor steps={form.steps} onChange={(steps) => set("steps", steps)} accounts={program.accounts} showErrors={showErrors} />
            {visibleErrors.poc && <p className="mt-2 text-xs text-danger-strong">{visibleErrors.poc}</p>}
            <ul className="mt-3 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-3">
              {program.accounts.map((a) => (
                <li key={a.id} className="rounded-lg bg-muted/40 px-2.5 py-1.5">
                  <span className="font-mono text-foreground">{a.id}</span>: {a.description.replace(/^[^—-]+[—-]\s*/, "")}
                </li>
              ))}
            </ul>
          </TabsContent>
          <TabsContent value="text" className="pt-3">
            <Field id="poc-notes" label="Steps to reproduce" hint="Prose is read by triage, but only structured steps can be replayed deterministically.">
              <Textarea id="poc-notes" value={form.pocNotes} onChange={(e) => set("pocNotes", e.target.value)} className="min-h-28" />
            </Field>
          </TabsContent>
        </Tabs>
      </section>

      <section className="space-y-5">
        <SectionHeading step="Step 4" title="You" />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="handle" label="Researcher handle" error={visibleErrors.handle} hint="Shown on the hall of fame if you are paid.">
            <Input id="handle" value={form.handle} onChange={(e) => set("handle", e.target.value)} placeholder="mkdir_p" aria-invalid={!!visibleErrors.handle} autoComplete="nickname" />
          </Field>
          {bounty && (
            <Field id="payout-email" label="PayPal email for the bounty" optional error={visibleErrors.payoutEmail} hint="Leave empty to pay the PayPal account that posts the deposit.">
              <Input id="payout-email" type="email" value={form.payoutEmail} onChange={(e) => set("payoutEmail", e.target.value)} aria-invalid={!!visibleErrors.payoutEmail} autoComplete="email" />
            </Field>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-2xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6">
        {bounty ? (
          <>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">
                Post the <Money value={program.deposit} /> deposit and submit
              </h2>
              <p className="max-w-prose text-sm text-muted-foreground">
                PayPal places an authorization hold; nothing is charged. It is released in full for any honest report, including duplicates, and captured only if a
                maintainer confirms the report is fabricated. Triage starts the moment the hold is in place.
              </p>
            </div>
            <div className="max-w-sm">
              <PayPalCheckout
                paypalMode={paypalMode}
                canStart={checkValid}
                createOrder={async () => {
                  const id = await saveReport();
                  const order = await api<{ orderId: string; approveUrl?: string }>(`/api/reports/${id}/deposit`, { body: {} });
                  return order;
                }}
                onApproved={async (orderId) => {
                  const id = saved.current?.id;
                  if (!id) throw new Error("The report was not saved");
                  await api(`/api/reports/${id}/deposit/approve`, { body: { orderId } });
                  toast.success("Deposit held. Triage has started.");
                  router.push(`/r/${id}`);
                }}
                onCancelled={() => {
                  const id = saved.current?.id;
                  toast.info(id ? "Deposit not posted. Your claim is saved; you can post the deposit from its status page." : "Deposit not posted.");
                }}
                onFailed={(m) => {
                  if (m !== "TRUSTED_NO_DEPOSIT") toast.error(m);
                }}
                mockLabel="Post deposit with PayPal"
              />
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-prose text-sm text-muted-foreground">Free reports are triaged right away. There is no deposit and no bounty.</p>
            <Button size="lg" className="h-10 gap-2" onClick={submitFree} disabled={submitting}>
              {submitting ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
              Submit free report
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
