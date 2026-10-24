import { BanknoteIcon, LockIcon } from "lucide-react";
import { IdChip } from "@/components/id-chip";
import { Money } from "@/components/money";
import { DepositBadge, PayoutBadge } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { DepositView, PayoutView, ReportView } from "@/lib/view-types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

export function DepositCard({ deposit, report }: { deposit?: DepositView; report: Pick<ReportView, "kind" | "reporter" | "status"> }) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <LockIcon className="size-4 text-muted-foreground" aria-hidden />
          Deposit
        </CardTitle>
        {report.kind === "bounty" && <DepositBadge status={deposit?.status} />}
      </CardHeader>
      <CardContent>
        {report.kind === "free" ? (
          <p className="text-sm text-muted-foreground">Free report: no deposit, no bounty. Triage still runs.</p>
        ) : !deposit && report.reporter.trusted ? (
          <p className="text-sm text-muted-foreground">Trusted researcher: bounty claims need no deposit after 3 verified reports.</p>
        ) : !deposit ? (
          <p className="text-sm text-muted-foreground">No deposit yet.</p>
        ) : (
          <dl className="space-y-2">
            <Row label="Amount">
              <Money value={deposit.amount} code />
            </Row>
            <Row label="Order">
              <IdChip value={deposit.orderId} />
            </Row>
            {deposit.authorizationId && (
              <Row label="Authorization">
                <IdChip value={deposit.authorizationId} />
              </Row>
            )}
            {deposit.captureId && (
              <Row label="Capture">
                <IdChip value={deposit.captureId} />
              </Row>
            )}
            {deposit.payer && (
              <Row label="Payer">
                <span className="font-mono text-xs">{deposit.payer}</span>
              </Row>
            )}
            {deposit.status === "AUTHORIZED" && deposit.honorUntil && (
              <Row label="Triage promised by">
                <span className="text-xs">{formatDateTime(deposit.honorUntil)}</span>
              </Row>
            )}
            {deposit.voidedAt && <Row label="Released">{formatDateTime(deposit.voidedAt)}</Row>}
            {deposit.capturedAt && <Row label="Captured">{formatDateTime(deposit.capturedAt)}</Row>}
            {deposit.source === "vault" && <p className="pt-1 text-xs text-muted-foreground">Posted by judge mode from the demo researcher&apos;s saved sandbox wallet.</p>}
            {deposit.lastError && (
              <p className="rounded-md bg-danger-soft px-2 py-1.5 text-xs text-danger-strong">
                PayPal: {deposit.lastError.code}
                {deposit.lastError.debugId && <span className="font-mono"> (debug id {deposit.lastError.debugId})</span>}
              </p>
            )}
            {deposit.dispute && (
              <p className="rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning-strong">
                Disputed in PayPal: case <span className="font-mono">{deposit.dispute.id}</span> ({deposit.dispute.status})
              </p>
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function PayoutCard({ payout }: { payout: PayoutView }) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <BanknoteIcon className="size-4 text-muted-foreground" aria-hidden />
          Bounty payout
        </CardTitle>
        <PayoutBadge status={payout.status} />
      </CardHeader>
      <CardContent>
        <dl className="space-y-2">
          <Row label="Amount">
            <Money value={payout.amount} code />
          </Row>
          <Row label="Severity">
            <span className="capitalize">{payout.severity}</span>
          </Row>
          <Row label="To">
            <span className="font-mono text-xs">{payout.receiver}</span>
          </Row>
          <Row label="Sender batch">
            <IdChip value={payout.senderBatchId} />
          </Row>
          {payout.batchId && (
            <Row label="Batch">
              <IdChip value={payout.batchId} />
            </Row>
          )}
          {payout.itemId && (
            <Row label="Item">
              <IdChip value={payout.itemId} />
            </Row>
          )}
          {payout.transactionId && (
            <Row label="Transaction">
              <IdChip value={payout.transactionId} />
            </Row>
          )}
          {payout.fee && (
            <Row label="PayPal fee">
              <Money value={payout.fee} />
            </Row>
          )}
          {payout.error && (
            <p className="rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning-strong">
              {payout.error.name}
              {payout.status === "UNCLAIMED" ? ": the receiver has 30 days to open a PayPal account and claim it." : ""}
            </p>
          )}
          {payout.replayed && <p className="text-xs text-muted-foreground">PayPal returned the original batch for this sender batch id: nothing was paid twice.</p>}
        </dl>
      </CardContent>
    </Card>
  );
}
