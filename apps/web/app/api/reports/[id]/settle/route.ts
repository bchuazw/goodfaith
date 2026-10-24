import { api, json, readJson, requireMaintainer } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { settle } from "@/lib/server/settlement";
import { reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
// After "pay", this request's after() polls the payout batch until PayPal finishes it.
export const maxDuration = 300;

/**
 * The maintainer's decision: `{ action: "pay", severity?, overrideReason? }`, `{ action: "release", note? }`
 * or `{ action: "capture", confirm: true }`. The money rules live in lib/server/settlement.ts.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/reports/[id]/settle">) {
  return api(async () => {
    const { id } = await ctx.params;
    const svc = getServices();
    requireMaintainer(req, svc);
    await settle(svc, id, await readJson(req));
    return json(await reportView(svc, id, "maintainer"));
  });
}
