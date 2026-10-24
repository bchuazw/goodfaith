"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form";
import { PayPalCheckout } from "@/components/paypal/paypal-checkout";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";

const PRESETS = ["100", "250", "500", "1000"];

/** A sponsor funds the bounty pool: an Orders v2 CAPTURE order approved in PayPal, captured on the server. */
export function SponsorFund({ paypalMode }: { paypalMode: "mock" | "sandbox" | "live" }) {
  const router = useRouter();
  const [amount, setAmount] = useState("250");
  const [sponsor, setSponsor] = useState("");
  const [tried, setTried] = useState(false);
  const amountOk = /^\d{1,5}(\.\d{2})?$/.test(amount) && Number(amount) >= 5 && Number(amount) <= 10_000;
  const sponsorOk = sponsor.trim().length >= 2;

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Amount" className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={amount === p}
            onClick={() => setAmount(p)}
            className={cn("h-8 rounded-lg px-3 font-mono text-sm ring-1 ring-input transition-colors hover:bg-muted", amount === p && "bg-primary text-primary-foreground ring-primary hover:bg-primary/90")}
          >
            ${Number(p).toLocaleString("en-US")}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="fund-amount" label="Amount (USD)" error={tried && !amountOk ? "Between $5 and $10,000" : undefined}>
          <Input id="fund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className="font-mono" aria-invalid={tried && !amountOk} />
        </Field>
        <Field id="fund-sponsor" label="Sponsor name" error={tried && !sponsorOk ? "Who is funding this?" : undefined}>
          <Input id="fund-sponsor" value={sponsor} onChange={(e) => setSponsor(e.target.value)} placeholder="Acme Security" aria-invalid={tried && !sponsorOk} />
        </Field>
      </div>
      <PayPalCheckout
        paypalMode={paypalMode}
        canStart={() => {
          setTried(true);
          return amountOk && sponsorOk;
        }}
        createOrder={() => api<{ orderId: string; approveUrl?: string }>("/api/sponsor/fund", { body: { amount, sponsor: sponsor.trim() } })}
        onApproved={async (orderId) => {
          await api(`/api/sponsor/fund/${orderId}/capture`, { body: {} });
          toast.success("Thank you: the pool is funded.");
          router.refresh();
        }}
        onCancelled={() => toast.info("No payment was made.")}
        onFailed={(m) => toast.error(m)}
        mockLabel="Fund with PayPal"
      />
    </div>
  );
}
