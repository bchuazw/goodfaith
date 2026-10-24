/**
 * Judge mode: one click submits a hero report as a bounty claim and posts its deposit, then the page
 * streams triage and offers the settlement. Mock mode simulates the researcher's PayPal approval; live
 * mode places a real sandbox hold on the demo researcher's saved wallet.
 */
import { isMockPayPal } from "@goodfaith/paypal";
import { postDemoDeposit } from "./deposits";
import { AppError } from "./errors";
import { HERO_REPORTS, type HeroKey } from "../hero-reports";
import { submitReport } from "./reports";
import type { Services } from "./services";

export function isHeroKey(key: string): key is HeroKey {
  return Object.hasOwn(HERO_REPORTS, key);
}

/** The latest judge-mode round and its report per scenario. */
export async function latestScenarioReports(svc: Services): Promise<{ round?: string; reports: Partial<Record<HeroKey, string>> }> {
  const reports = (await svc.db.reports.list()).filter((r) => r.demoScenario && isHeroKey(r.demoScenario)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const round = reports[0]?.demoRound;
  const out: Partial<Record<HeroKey, string>> = {};
  for (const r of reports) {
    if (r.demoRound === round && !out[r.demoScenario as HeroKey]) out[r.demoScenario as HeroKey] = r.id;
  }
  return { ...(round ? { round } : {}), reports: out };
}

export async function runScenario(svc: Services, key: HeroKey, opts: { origin: string; round: string }): Promise<{ reportId: string }> {
  const hero = HERO_REPORTS[key];
  if (key === "duplicate") {
    // A duplicate needs an original: this round's IDOR must already be reproduced.
    const inRound = (await svc.db.reports.list()).filter((r) => r.demoRound === opts.round && r.demoScenario === "idor");
    let reproduced = false;
    for (const r of inRound) if ((await svc.db.verdicts.value(r.id))?.verdict === "REPRODUCED") reproduced = true;
    if (!reproduced) throw new AppError("NEEDS_ORIGINAL", "Run the real IDOR first: a duplicate needs a reproduced original to match", 409);
  }
  const mock = isMockPayPal(svc.paypal);
  const { report, depositRequired } = await submitReport(svc, {
    programId: svc.program.id,
    kind: "bounty",
    title: hero.title,
    claimedVersion: hero.claimedVersion,
    ...(hero.claimedSeverity ? { claimedSeverity: hero.claimedSeverity } : {}),
    body: hero.body,
    ...(hero.poc ? { poc: hero.poc } : {}),
    reporter: { handle: hero.handle },
    demoScenario: key,
    demoRound: opts.round,
  });
  if (depositRequired) {
    // Live: the payout goes back to the sandbox account that posted the deposit, which is registered,
    // so the sandbox shows SUCCESS. Mock: the mock buyer takes the hero's address.
    await postDemoDeposit(svc, report.id, { origin: opts.origin, ...(mock ? { payerEmail: hero.payoutEmail } : {}) });
  }
  return { reportId: report.id };
}
