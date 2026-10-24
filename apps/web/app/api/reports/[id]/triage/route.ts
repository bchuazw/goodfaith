import { api, json, requireMaintainer } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { rerunTriage } from "@/lib/server/triage";
import { reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Maintainer: run triage again (after a failure, or to re-check before settling). */
export async function POST(req: Request, ctx: RouteContext<"/api/reports/[id]/triage">) {
  return api(async () => {
    const { id } = await ctx.params;
    const svc = getServices();
    requireMaintainer(req, svc);
    await rerunTriage(svc, id);
    return json(await reportView(svc, id, "maintainer"), { status: 202 });
  });
}
