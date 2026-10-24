import { api, json } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { transparencyStats } from "@/lib/server/stats";

export const dynamic = "force-dynamic";

/** The public transparency numbers for the program. */
export async function GET() {
  return api(async () => json(await transparencyStats(getServices())));
}
