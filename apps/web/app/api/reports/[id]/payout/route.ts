import { api, json } from "@/lib/server/http";
import { refreshPayout } from "@/lib/server/payouts";
import { getServices } from "@/lib/server/runtime";
import { reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

/** Re-reads the payout batch from PayPal now ("Refresh from PayPal" in the console). */
export async function POST(_req: Request, ctx: RouteContext<"/api/reports/[id]/payout">) {
  return api(async () => {
    const { id } = await ctx.params;
    const svc = getServices();
    await refreshPayout(svc, id);
    return json(await reportView(svc, id, "maintainer"));
  });
}
