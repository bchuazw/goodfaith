import { json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { handleWebhook } from "@/lib/server/webhooks";

export const dynamic = "force-dynamic";
// CHECKOUT.ORDER.APPROVED may authorize a deposit, which starts triage in this request's after().
export const maxDuration = 300;

/**
 * PayPal webhook receiver. The raw body is verified byte for byte with PayPal's postback (PayPal warns
 * that re-serialised JSON can fail verification), so it is read as text and never re-encoded.
 */
export async function POST(req: Request) {
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  try {
    const result = await handleWebhook(getServices(), { headers, body });
    if (result.status >= 400) console.warn(`[goodfaith] webhook refused (${result.status}): ${result.outcome}`);
    return json({ outcome: result.outcome }, { status: result.status });
  } catch (e) {
    // Verification could not reach PayPal (5xx/network): answer 502 so PayPal redelivers later.
    console.error(`[goodfaith] webhook verification failed: ${e instanceof Error ? e.message : String(e)}`);
    return json({ outcome: "Verification unavailable; retry later" }, { status: 502 });
  }
}
