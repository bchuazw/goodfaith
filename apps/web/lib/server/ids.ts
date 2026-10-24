/** Crockford base32 without I, L, O, U: readable aloud, no lookalikes. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

/**
 * Report ids carry 50 random bits. They also name the PayPal payout batch ("gf-" + id), and PayPal pays a
 * sender_batch_id at most once per 30 days, so ids must never repeat, not even across store resets.
 */
export const newReportId = () => `r_${randomToken(10)}`;

export const senderBatchIdFor = (reportId: string) => `gf-${reportId}`;

/** Fixed PayPal-Request-Ids: a retried call with the same id is a replay, never a second charge or void. */
export const requestIds = {
  depositOrder: (reportId: string, attempt: number) => `gf-dep-${reportId}-${attempt}`,
  authorize: (reportId: string, attempt: number) => `gf-auth-${reportId}-${attempt}`,
  void: (reportId: string) => `gf-void-${reportId}`,
  capture: (reportId: string) => `gf-cap-${reportId}`,
  fundingOrder: (key: string) => `gf-fund-${key}`,
  fundingCapture: (orderId: string) => `gf-fundcap-${orderId}`,
};
