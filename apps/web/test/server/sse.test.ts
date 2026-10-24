import { describe, expect, it } from "vitest";
import { submitReport } from "@/lib/server/reports";
import { reportEventStream } from "@/lib/server/sse";
import { heroInput, testEnv, triagedClaim } from "./helpers";

type Frame = { id?: number; event: string; data: unknown };

async function readFrames(stream: ReadableStream<Uint8Array>): Promise<Frame[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: "))
    .map((block) => {
      const lines = block.split("\n");
      const id = lines.find((l) => l.startsWith("id: "))?.slice(4);
      return {
        ...(id ? { id: Number(id) } : {}),
        event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "",
        data: JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null"),
      };
    });
}

describe("report event stream (tails the Store)", () => {
  it("streams a run another instance performs, then ends after the verdict", async () => {
    const env = testEnv();
    const { report } = await submitReport(env.svc, heroInput("idor", "free"));
    // The stream reads the Store only; triage runs separately (as on another instance).
    const framesP = readFrames(reportEventStream(env.svc, report.id, { pollMs: 5, maxMs: 10_000 }));
    await env.drain();
    const frames = await framesP;

    const triage = frames.filter((f) => f.event === "triage");
    expect(triage.length).toBeGreaterThan(10);
    expect(triage.map((f) => f.id)).toEqual(triage.map((_, i) => i + 1));
    expect((triage.at(-1)?.data as { event: { type: string } }).event.type).toBe("verdict");
    const reports = frames.filter((f) => f.event === "report").map((f) => (f.data as { status: string }).status);
    expect(["queued", "triaging"]).toContain(reports[0]);
    expect(reports.at(-1)).toBe("triaged");
    expect(frames.at(-1)).toEqual({ event: "end", data: { reason: "done" } });
  });

  it("resumes after Last-Event-ID without repeating events", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "slop");
    const all = (await readFrames(reportEventStream(env.svc, id, { pollMs: 5 }))).filter((f) => f.event === "triage");
    const resumed = (await readFrames(reportEventStream(env.svc, id, { pollMs: 5, afterSeq: 5 }))).filter((f) => f.event === "triage");
    expect(resumed[0]?.id).toBe(6);
    expect(resumed.length).toBe(all.length - 5);
  });

  it("times out with a final frame when nothing happens (a claim still waiting for its deposit)", async () => {
    const env = testEnv();
    const { report } = await submitReport(env.svc, heroInput("slop"));
    const frames = await readFrames(reportEventStream(env.svc, report.id, { pollMs: 5, maxMs: 60 }));
    expect((frames[0]?.data as { status: string }).status).toBe("awaiting_deposit");
    expect(frames.at(-1)).toEqual({ event: "end", data: { reason: "timeout" } });
  });

  it("researcher frames never carry the maintainer's notes or the full payout address", async () => {
    const env = testEnv();
    const id = await triagedClaim(env, "idor");
    const frames = await readFrames(reportEventStream(env.svc, id, { pollMs: 5 }));
    const view = frames.filter((f) => f.event === "report").at(-1)?.data as { verdict: { summary: string; researcherSummary: string }; options?: unknown; ledger?: unknown };
    expect(view.verdict.summary).toBe(view.verdict.researcherSummary);
    const verdictFrame = frames.find((f) => f.event === "triage" && (f.data as { event: { type: string } }).event.type === "verdict")?.data as {
      event: { verdict: { summary: string; researcherSummary: string } };
    };
    expect(verdictFrame.event.verdict.summary).toBe(verdictFrame.event.verdict.researcherSummary);
    const maintainer = await readFrames(reportEventStream(env.svc, id, { pollMs: 5, audience: "maintainer" }));
    const mv = maintainer.find((f) => f.event === "triage" && (f.data as { event: { type: string } }).event.type === "verdict")?.data as typeof verdictFrame;
    expect(mv.event.verdict.summary).not.toBe(mv.event.verdict.researcherSummary);
    expect(view.options).toBeUndefined();
    expect(view.ledger).toBeUndefined();
  });
});
