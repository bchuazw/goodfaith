import { describe, expect, it } from "vitest";
import { latestScenarioReports, runScenario } from "@/lib/server/demo";
import { settle, settlementContext } from "@/lib/server/settlement";
import { testEnv } from "./helpers";

const ORIGIN = "http://localhost:3000";

describe("judge mode", () => {
  it("runs the three hero scenarios to their expected verdicts and settlements", async () => {
    const env = testEnv();
    const round = "round-test-a";
    await expect(runScenario(env.svc, "duplicate", { origin: ORIGIN, round })).rejects.toMatchObject({ code: "NEEDS_ORIGINAL" });
    const ids: Record<string, string> = {};
    for (const key of ["slop", "idor", "duplicate"] as const) {
      ids[key] = (await runScenario(env.svc, key, { origin: ORIGIN, round })).reportId;
      await env.drain();
    }
    const verdict = async (id: string) => (await settlementContext(env.svc, id)).verdict?.verdict;
    expect([await verdict(ids.slop as string), await verdict(ids.idor as string), await verdict(ids.duplicate as string)]).toEqual(["SLOP", "REPRODUCED", "DUPLICATE"]);
    await settle(env.svc, ids.slop as string, { action: "capture", confirm: true });
    await settle(env.svc, ids.idor as string, { action: "pay" });
    await settle(env.svc, ids.duplicate as string, { action: "release" });
    expect((await latestScenarioReports(env.svc)).round).toBe(round);
  });

  it("keeps rounds apart: a new round's IDOR reproduces again instead of being a duplicate of the last round's", async () => {
    const env = testEnv();
    const first = (await runScenario(env.svc, "idor", { origin: ORIGIN, round: "round-one" })).reportId;
    await env.drain();
    const again = (await runScenario(env.svc, "idor", { origin: ORIGIN, round: "round-one" })).reportId;
    await env.drain();
    const second = (await runScenario(env.svc, "idor", { origin: ORIGIN, round: "round-two" })).reportId;
    await env.drain();
    const v = async (id: string) => (await settlementContext(env.svc, id)).verdict?.verdict;
    expect(await v(first)).toBe("REPRODUCED");
    expect(await v(again)).toBe("DUPLICATE"); // same round: an honest duplicate
    expect(await v(second)).toBe("REPRODUCED");
    // The duplicate scenario needs this round's original.
    await expect(runScenario(env.svc, "duplicate", { origin: ORIGIN, round: "round-three" })).rejects.toMatchObject({ code: "NEEDS_ORIGINAL" });
  });
});
