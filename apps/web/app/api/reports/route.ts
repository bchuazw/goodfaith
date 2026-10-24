import { submitReport } from "@/lib/server/reports";
import { api, json, readJson } from "@/lib/server/http";
import { getServices } from "@/lib/server/runtime";
import { queueRows, reportView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
// A free report is triaged inside this request's after(): give it the whole function budget.
export const maxDuration = 300;

/** Submit a report: a free report starts triage at once; a bounty claim waits for its deposit. */
export async function POST(req: Request) {
  return api(async () => {
    const svc = getServices();
    const { report, depositRequired } = await submitReport(svc, await readJson(req));
    return json({ report: await reportView(svc, report.id, "researcher"), depositRequired }, { status: 201 });
  });
}

/** The maintainer queue. */
export async function GET() {
  return api(async () => json({ rows: await queueRows(getServices()) }));
}
