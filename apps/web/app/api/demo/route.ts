import { z } from "zod";
import { isHeroKey, latestScenarioReports, runScenario } from "@/lib/server/demo";
import { AppError } from "@/lib/server/errors";
import { api, json, readJson, requestOrigin } from "@/lib/server/http";
import { getServices, resetMockData } from "@/lib/server/runtime";
import { fundWithMockApproval } from "@/lib/server/sponsor";

export const dynamic = "force-dynamic";
// Posting the deposit makes triage due; it runs in this request's after().
export const maxDuration = 300;

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), scenario: z.string(), round: z.string().regex(/^[a-z0-9-]{4,40}$/) }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("fund"), amount: z.string().default("1000") }),
]);

/** Judge mode: run a hero scenario, fund the pool (mock), or reset the mock data. */
export async function POST(req: Request) {
  return api(async () => {
    const svc = getServices();
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) throw new AppError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request", 422);
    const body = parsed.data;
    if (body.action === "run") {
      if (!isHeroKey(body.scenario)) throw new AppError("UNKNOWN_SCENARIO", `No scenario "${body.scenario}"`, 404);
      return json(await runScenario(svc, body.scenario, { origin: requestOrigin(req, svc), round: body.round }), { status: 201 });
    }
    if (body.action === "reset") {
      if (svc.mode.app !== "mock") throw new AppError("MOCK_ONLY", "Reset exists only in mock mode", 409);
      await resetMockData();
      return json({ ok: true });
    }
    const funding = await fundWithMockApproval(svc, { amount: body.amount, sponsor: "Judge-mode sponsor (mock)" }, { origin: requestOrigin(req, svc) });
    return json({ funding }, { status: 201 });
  });
}

/** The latest report id per scenario (judge mode resumes where it left off). */
export async function GET() {
  return api(async () => json({ scenarios: await latestScenarioReports(getServices()) }));
}
