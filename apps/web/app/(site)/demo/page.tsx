import type { Metadata } from "next";
import { HERO_REPORTS, type HeroKey } from "@/lib/hero-reports";
import { latestScenarioReports } from "@/lib/server/demo";
import { servicesOrError } from "@/lib/server/page";
import { triageEvents } from "@/lib/server/triage";
import { reportView } from "@/lib/server/views";
import type { ReportView, StreamTriageEvent } from "@/lib/view-types";
import { JudgeMode } from "./judge-mode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge mode" };

export default async function DemoPage() {
  const { svc, error } = servicesOrError();
  if (!svc) return <p className="mx-auto max-w-6xl px-4 py-16 text-danger-strong">{error}</p>;
  const latest = await latestScenarioReports(svc);
  const runs: Partial<Record<HeroKey, { view: ReportView; events: StreamTriageEvent[] }>> = {};
  for (const key of Object.keys(HERO_REPORTS) as HeroKey[]) {
    const id = latest[key];
    if (!id) continue;
    const view = await reportView(svc, id, "maintainer").catch(() => undefined);
    if (!view) continue;
    const attempt = view.triage?.attempt ?? 1;
    runs[key] = { view, events: (await triageEvents(svc, id)).filter((e) => e.attempt === attempt) };
  }
  return (
    <JudgeMode
      runs={runs}
      bounties={svc.program.bounties}
      deposit={svc.program.deposit}
      mode={{ app: svc.mode.app, paypal: svc.mode.paypal, vault: !!svc.config.sandboxVaultId, model: svc.mode.llm.model }}
    />
  );
}
