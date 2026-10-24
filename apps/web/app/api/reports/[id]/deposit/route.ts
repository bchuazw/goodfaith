import { createDepositOrder } from "@/lib/server/deposits";
import { api, json, requestOrigin } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Creates the deposit's AUTHORIZE order (or returns the open one). The browser hands `orderId` to the
 * PayPal JS SDK v6 session; in mock mode it opens `approveUrl`, the mock approval sheet.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/reports/[id]/deposit">) {
  return api(async () => {
    const { id } = await ctx.params;
    const svc = getServices();
    const { deposit, approveUrl } = await createDepositOrder(svc, id, { origin: requestOrigin(req, svc) });
    return json({ orderId: deposit.orderId, status: deposit.status, amount: deposit.amount, ...(approveUrl ? { approveUrl } : {}) });
  });
}
