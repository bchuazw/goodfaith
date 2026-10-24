import { api, json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { captureFunding, poolBalance } from "@/lib/server/sponsor";

export const dynamic = "force-dynamic";

/** The sponsor approved in PayPal: capture the contribution into the pool. */
export async function POST(_req: Request, ctx: RouteContext<"/api/sponsor/fund/[orderId]/capture">) {
  return api(async () => {
    const { orderId } = await ctx.params;
    const svc = getServices();
    const funding = await captureFunding(svc, orderId);
    return json({ funding, pool: await poolBalance(svc) });
  });
}
