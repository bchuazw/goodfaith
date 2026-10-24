import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/server/errors";
import { servicesOrError } from "@/lib/server/page";
import { triageEvents } from "@/lib/server/triage";
import { eventsFor, reportView } from "@/lib/server/views";
import { ReportStatus } from "./report-status";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report status" };

export default async function ReportStatusPage({ params }: PageProps<"/r/[id]">) {
  const { id } = await params;
  const { svc, error } = servicesOrError();
  if (!svc) return <p className="mx-auto max-w-6xl px-4 py-16 text-danger-strong">{error}</p>;
  const view = await reportView(svc, id, "researcher").catch((e: unknown) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const attempt = view.triage?.attempt ?? 1;
  const events = eventsFor((await triageEvents(svc, id)).filter((e) => e.attempt === attempt), "researcher");
  return <ReportStatus initial={view} initialEvents={events} paypalMode={svc.mode.paypal} />;
}
