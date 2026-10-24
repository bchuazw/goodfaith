import type { NextRequest } from "next/server";
import { api, json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One report. `?view=maintainer` adds the settlement options, the PayPal trail and unmasked emails. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/reports/[id]">) {
  return api(async () => {
    const { id } = await ctx.params;
    const audience = req.nextUrl.searchParams.get("view") === "maintainer" ? "maintainer" : "researcher";
    return json(await reportView(getServices(), id, audience));
  });
}
