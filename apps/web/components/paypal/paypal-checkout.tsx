"use client";

import { FlaskConicalIcon, LoaderCircleIcon, LockIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createPayPalInstance, type OneTimePaymentSession } from "@/lib/client/paypal-v6";
import { cn } from "@/lib/utils";

export type CheckoutOrder = { orderId: string; approveUrl?: string };

export type PayPalCheckoutProps = {
  paypalMode: "mock" | "sandbox" | "live";
  /** Creates the Orders v2 order on the server (and anything it depends on, like the report). */
  createOrder: () => Promise<CheckoutOrder>;
  /** The buyer approved in PayPal: authorize or capture on the server. */
  onApproved: (orderId: string) => Promise<void>;
  onCancelled?: () => void;
  onFailed?: (message: string) => void;
  /** Return false to refuse the click (e.g. the form is not valid yet). */
  canStart?: () => boolean;
  mockLabel?: string;
  className?: string;
};

/** PayPal checkout: the JS SDK v6 button against the real sandbox, or the labelled mock sheet in mock mode. */
export function PayPalCheckout(props: PayPalCheckoutProps) {
  return props.paypalMode === "mock" ? <MockCheckout {...props} /> : <SdkCheckout {...props} />;
}

// ---------------------------------------------------------------------------------------------
// Live: JS SDK v6
// ---------------------------------------------------------------------------------------------

function SdkCheckout({ createOrder, onApproved, onCancelled, onFailed, canStart, className }: PayPalCheckoutProps) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ createOrder, onApproved, onCancelled, onFailed, canStart });
  const [state, setState] = useState<"loading" | "ready" | "ineligible" | "error" | "approving">("loading");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    handlers.current = { createOrder, onApproved, onCancelled, onFailed, canStart };
  });

  useEffect(() => {
    let session: OneTimePaymentSession | undefined;
    let button: HTMLElement | undefined;
    let cancelled = false;
    setState("loading");
    createPayPalInstance()
      .then(({ instance, eligible }) => {
        if (cancelled) return;
        if (!eligible) return setState("ineligible");
        session = instance.createPayPalOneTimePaymentSession({
          onApprove: async (data) => {
            setState("approving");
            try {
              await handlers.current.onApproved(data.orderId);
            } finally {
              setState("ready");
            }
          },
          onCancel: () => handlers.current.onCancelled?.(),
          onError: (e) => handlers.current.onFailed?.(e.message || e.code || "PayPal reported an error"),
        });
        button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", () => {
          if (handlers.current.canStart && !handlers.current.canStart()) return;
          let reported = false;
          const fail = (e: unknown, fallback: string) => {
            if (reported) return;
            reported = true;
            handlers.current.onFailed?.(e instanceof Error ? e.message : fallback);
          };
          // Start synchronously inside the click (transient activation); the order is created meanwhile.
          const order = handlers.current.createOrder().then((o) => ({ orderId: o.orderId }));
          order.catch((e: unknown) => fail(e, "Could not create the PayPal order"));
          session?.start({ presentationMode: "auto" }, order).catch((e: unknown) => fail(e, "PayPal could not start"));
        });
        container.current?.replaceChildren(button);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "PayPal could not load");
        setState("error");
      });
    return () => {
      cancelled = true;
      session?.destroy();
      button?.remove();
    };
  }, [attempt]);

  return (
    <div className={cn("space-y-2", className)}>
      <div ref={container} className={cn("min-h-11 [&_paypal-button]:block [&_paypal-button]:w-full", state !== "ready" && state !== "approving" && "hidden")} />
      {state === "loading" && (
        <div className="flex h-11 items-center justify-center gap-2 rounded-lg bg-muted text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Loading PayPal
        </div>
      )}
      {state === "approving" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Approved in PayPal. Placing the hold
        </p>
      )}
      {state === "ineligible" && <p className="text-sm text-warning-strong">PayPal is not available for this browser or account.</p>}
      {state === "error" && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-danger-strong" role="alert">
          {error}
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCcwIcon /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Mock: the app's own simulated approval sheet, clearly labelled
// ---------------------------------------------------------------------------------------------

type SheetMessage = { source: "goodfaith-mock-paypal"; type: "approved" | "cancelled"; orderId: string };

function MockCheckout({ createOrder, onApproved, onCancelled, onFailed, canStart, mockLabel, className }: PayPalCheckoutProps) {
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ orderId: string; url: string }>();
  const done = useRef(false);

  useEffect(() => {
    if (!sheet) return;
    done.current = false;
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as Partial<SheetMessage>;
      if (data?.source !== "goodfaith-mock-paypal" || data.orderId !== sheet.orderId || done.current) return;
      done.current = true;
      setSheet(undefined);
      if (data.type === "approved") {
        setBusy(true);
        try {
          await onApproved(sheet.orderId);
        } catch (err) {
          onFailed?.(err instanceof Error ? err.message : "Could not complete the payment");
        } finally {
          setBusy(false);
        }
      } else {
        onCancelled?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sheet, onApproved, onCancelled, onFailed]);

  const start = async () => {
    if (canStart && !canStart()) return;
    setBusy(true);
    try {
      const order = await createOrder();
      const base = order.approveUrl ?? `/mock-paypal/checkoutnow?token=${order.orderId}`;
      setSheet({ orderId: order.orderId, url: `${base}${base.includes("?") ? "&" : "?"}embed=1` });
    } catch (err) {
      onFailed?.(err instanceof Error ? err.message : "Could not create the order");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <Button type="button" size="lg" className="h-11 w-full gap-2 text-[0.95rem]" onClick={start} disabled={busy}>
        {busy ? <LoaderCircleIcon className="animate-spin" /> : <LockIcon />}
        {mockLabel ?? "Approve with PayPal"}
        <span className="ml-1 rounded bg-warning-soft px-1.5 py-0.5 font-mono text-[0.65rem] font-bold tracking-widest text-warning-strong">MOCK</span>
      </Button>
      <Dialog
        open={!!sheet}
        onOpenChange={(open) => {
          if (!open && sheet && !done.current) {
            done.current = true;
            setSheet(undefined);
            onCancelled?.();
          }
        }}
      >
        <DialogContent className="max-w-[calc(100%-1.5rem)] gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton>
          <DialogHeader className="sr-only">
            <DialogTitle>Simulated PayPal approval (mock)</DialogTitle>
            <DialogDescription>A mock PayPal sheet. No real PayPal account or money is involved.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 border-b bg-warning-soft px-4 py-2 text-xs font-medium text-warning-strong">
            <FlaskConicalIcon className="size-3.5" aria-hidden /> MOCK: a simulated PayPal window. No PayPal account or money is involved.
          </div>
          {sheet && <iframe title="Simulated PayPal approval" src={sheet.url} className="h-[min(35rem,78dvh)] w-full bg-background" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
