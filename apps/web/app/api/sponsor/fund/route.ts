import { api, json, readJson, requestOrigin } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { createFundingOrder } from "@/lib/server/sponsor";

export const dynamic = "force-dynamic";

/** A sponsor funds the bounty pool: creates an Orders v2 CAPTURE order for `{ amount, sponsor }`. */
export async function POST(req: Request) {
  return api(async () => {
    const svc = getServices();
    const { funding, approveUrl } = await createFundingOrder(svc, await readJson(req), { origin: requestOrigin(req, svc) });
    return json({ orderId: funding.id, amount: funding.amount, sponsor: funding.sponsor, ...(approveUrl ? { approveUrl } : {}) }, { status: 201 });
  });
}
