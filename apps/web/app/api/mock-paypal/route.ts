import { isMockPayPal } from "@goodfaith/paypal";
import { z } from "zod";
import { AppError } from "@/lib/server/errors";
import { api, json, readJson } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().trim().min(1).max(64),
  action: z.enum(["approve", "cancel"]),
  email: z.email().max(254).optional(),
});

/** MOCK ONLY: the buyer's click on the simulated PayPal approval sheet (/mock-paypal/checkoutnow). */
export async function POST(req: Request) {
  return api(async () => {
    const svc = getServices();
    if (!isMockPayPal(svc.paypal)) throw new AppError("NOT_MOCK", "The simulated approval sheet exists only in mock mode", 404);
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) throw new AppError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request", 422);
    const { token, action, email } = parsed.data;
    try {
      const result = action === "approve" ? svc.paypal.simulateBuyerApproval(token, email ? { email } : undefined) : svc.paypal.simulateBuyerCancel(token);
      return json(result);
    } catch (e) {
      throw new AppError("MOCK_SIMULATION_ERROR", e instanceof Error ? e.message : "Simulation failed", 409);
    }
  });
}
