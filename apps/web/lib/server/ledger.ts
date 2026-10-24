/**
 * The PayPal trail: every PayPal call the app makes, and every verified webhook, as one line the
 * console can show next to the money it moved. Ids and statuses only; never bodies or secrets.
 */
import { paypalErrorInfo } from "./errors";
import type { Services } from "./services";
import type { LedgerEntry, LedgerOp } from "./store";

type Scope = { reportId?: string; fundingId?: string };

export async function appendLedger(svc: Services, entry: Omit<LedgerEntry, "at"> & { at?: string }): Promise<void> {
  try {
    await svc.db.ledger.append({ at: svc.now().toISOString(), ...entry }, svc.program.id);
  } catch (e) {
    // The trail is evidence, not a money rule: a failed append must never undo a completed PayPal call.
    console.error(`[goodfaith] ledger append failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Runs one PayPal call and records it. `describe` turns the result into the trail line; failures are
 * recorded with PayPal's name, issue and debug id, then rethrown.
 */
export async function paypalCall<T>(
  svc: Services,
  op: LedgerOp,
  scope: Scope,
  call: () => Promise<T>,
  describe: (result: T) => { summary: string; ids?: Record<string, string>; status?: string },
  failureSummary: string,
): Promise<T> {
  try {
    const result = await call();
    await appendLedger(svc, { op, ok: true, ...scope, ...describe(result) });
    return result;
  } catch (e) {
    const info = paypalErrorInfo(e);
    await appendLedger(svc, { op, ok: false, ...scope, summary: failureSummary, error: info });
    throw e;
  }
}
