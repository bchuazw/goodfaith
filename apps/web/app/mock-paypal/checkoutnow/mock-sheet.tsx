"use client";

import { CircleCheckIcon, FlaskConicalIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import { useState } from "react";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/client/api";
import type { Money as MoneyValue } from "@/lib/money";

type SheetOrder = { id: string; status: string; intent: "AUTHORIZE" | "CAPTURE"; amount?: MoneyValue; description?: string; item?: string };

export function MockSheet({ order, token, embed }: { order?: SheetOrder; token?: string; embed: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"approve" | "cancel">();
  const [done, setDone] = useState<"approved" | "cancelled">();
  const [error, setError] = useState<string>();
  const approvable = order && (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED");

  const finish = async (action: "approve" | "cancel") => {
    if (!token) return;
    setBusy(action);
    setError(undefined);
    try {
      const result = await api<{ redirectUrl: string }>("/api/mock-paypal", { body: { token, action, ...(email.trim() ? { email: email.trim() } : {}) } });
      const type = action === "approve" ? "approved" : "cancelled";
      setDone(type);
      if (embed && window.parent !== window) {
        window.parent.postMessage({ source: "goodfaith-mock-paypal", type, orderId: token }, window.location.origin);
      } else if (result.redirectUrl) {
        window.location.assign(result.redirectUrl);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {!embed && (
        <div className="flex items-center justify-center gap-2 bg-warning-soft px-4 py-2 text-center text-xs font-medium text-warning-strong">
          <FlaskConicalIcon className="size-3.5 shrink-0" aria-hidden />
          MOCK: a simulated PayPal approval. No PayPal account and no money are involved.
        </div>
      )}
      <div className={embed ? "mx-auto flex w-full max-w-sm flex-col gap-5 px-5 py-5" : "mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-5 py-8"}>
        <div className="space-y-1 text-center">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Good Faith requests</p>
          {order?.amount ? (
            <p className="text-3xl font-semibold">
              <Money value={order.amount} code />
            </p>
          ) : (
            <p className="text-lg font-medium">No such order</p>
          )}
          {order && (
            <p className="text-sm text-muted-foreground">
              {order.intent === "AUTHORIZE" ? "An authorization hold. Nothing is charged unless the maintainer captures it." : "A one-time payment."}
            </p>
          )}
        </div>

        {order && (
          <dl className="space-y-2 rounded-xl bg-muted/60 p-4 text-sm">
            {order.item && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">For</dt>
                <dd className="text-right">{order.item}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Order</dt>
              <dd className="font-mono text-xs">{order.id}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Intent</dt>
              <dd className="font-mono text-xs">{order.intent}</dd>
            </div>
          </dl>
        )}

        {done ? (
          <p className="flex items-center justify-center gap-2 text-sm font-medium text-success-strong" role="status">
            <CircleCheckIcon className="size-4" aria-hidden />
            {done === "approved" ? "Approved. Returning to Good Faith" : "Cancelled. Returning to Good Faith"}
          </p>
        ) : approvable ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mock-email">Simulated buyer email (optional)</Label>
              <Input id="mock-email" type="email" placeholder="researcher@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              <p className="text-xs text-muted-foreground">Bounties are paid to this address. One containing "unclaimed" simulates a receiver without a PayPal account.</p>
            </div>
            <Button className="h-11 w-full gap-2" onClick={() => finish("approve")} disabled={!!busy}>
              {busy === "approve" ? <LoaderCircleIcon className="animate-spin" /> : <LockIcon />}
              {order?.intent === "AUTHORIZE" ? "Approve the hold" : "Approve the payment"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => finish("cancel")} disabled={!!busy}>
              Cancel and return
            </Button>
          </div>
        ) : (
          order && <p className="text-center text-sm text-muted-foreground">This order is {order.status.toLowerCase().replaceAll("_", " ")} and needs no approval.</p>
        )}
        {error && (
          <p className="text-center text-sm text-danger-strong" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
