import { isPayPalError } from "@goodfaith/paypal";

/** A refusal the API reports as-is: a stable code, an HTTP status, and a message safe to show. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);

export type PayPalErrorInfo = { name: string; issue?: string; debugId?: string; message: string };

/** The parts of a PayPal error worth storing and showing. Built from PayPal's response fields only. */
export function paypalErrorInfo(e: unknown): PayPalErrorInfo {
  if (isPayPalError(e)) {
    return {
      name: e.name,
      ...(e.issue ? { issue: e.issue } : {}),
      ...(e.debugId ? { debugId: e.debugId } : {}),
      message: e.paypalMessage || e.message,
    };
  }
  return { name: "ERROR", message: e instanceof Error ? e.message : String(e) };
}

/** PayPal's issue code (PREVIOUSLY_VOIDED, ORDER_NOT_APPROVED, ...) when `e` is a PayPal error. */
export const paypalIssue = (e: unknown): string | undefined => (isPayPalError(e) ? e.issue : undefined);

/** Wraps a PayPal failure as an AppError the client can act on (422 for a refusal, 502 when PayPal failed). */
export function paypalFailure(action: string, e: unknown): AppError {
  const info = paypalErrorInfo(e);
  const status = isPayPalError(e) && e.status >= 400 && e.status < 500 ? 422 : 502;
  return new AppError(
    "PAYPAL_ERROR",
    `PayPal could not ${action}: ${info.issue ?? info.name}${info.debugId ? ` (debug id ${info.debugId})` : ""}`,
    status,
    { paypal: info },
  );
}
