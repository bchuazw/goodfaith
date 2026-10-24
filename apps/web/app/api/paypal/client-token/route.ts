import { AppError, paypalFailure } from "@/lib/server/errors";
import { api, json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/**
 * A browser-safe client token for the PayPal JS SDK v6 (`paypal.createInstance({ clientToken })`), minted
 * per request. Mock mode has no real SDK to initialize, so it answers 409 and the page uses the mock sheet.
 */
export async function GET() {
  return api(async () => {
    const svc = getServices();
    if (svc.mode.paypal === "mock" || !svc.paypal.createClientToken) {
      throw new AppError("MOCK_MODE", "PayPal is mocked: use the mock approval sheet", 409);
    }
    const token = await svc.paypal
      .createClientToken(svc.config.clientTokenDomains ? { domains: svc.config.clientTokenDomains } : {})
      .catch((e) => {
        throw paypalFailure("create a client token", e);
      });
    return json({ clientToken: token.clientToken, expiresIn: token.expiresIn, environment: svc.mode.paypal === "live" ? "production" : "sandbox" });
  });
}
