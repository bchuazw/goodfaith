import { z } from "zod";
import { approveDeposit } from "@/lib/server/deposits";
import { AppError } from "@/lib/server/errors";
import { api, json, readJson } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
// Authorizing the deposit makes triage due; it runs in this request's after().
export const maxDuration = 300;

const bodySchema = z.object({ orderId: z.string().trim().min(1).max(64) });

/** The researcher approved the deposit in PayPal (JS SDK v6 onApprove, or the mock sheet). */
export async function POST(req: Request, ctx: RouteContext<"/api/reports/[id]/deposit/approve">) {
  return api(async () => {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) throw new AppError("INVALID_REQUEST", "orderId is required", 422);
    const svc = getServices();
    await approveDeposit(svc, id, { orderId: parsed.data.orderId });
    return json(await reportView(svc, id, "researcher"));
  });
}
