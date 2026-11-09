/**
 * Submission assets from a recording run: the six 1920x1080 gallery screenshots (out/gallery), the
 * thumbnails (cards step) and the YouTube title and description (out/youtube.md).
 *   pnpm --filter @goodfaith/video assets
 */
import fs from "node:fs";
import path from "node:path";
import { CARDS, ensureDir, OUT, RAW, SHOTS } from "./env.js";
import { ff } from "./ffmpeg.js";
import type { SegmentLog } from "./record.js";
import { closeRenderer, renderOverlay } from "./render.js";
import { HEADLINES, popupFrame } from "./templates.js";

const GALLERY = path.join(OUT, "gallery");

/** The PayPal approval window composed over the dimmed report form, like the video does it. */
async function paypalSheet(dest: string): Promise<boolean> {
  const popupShot = path.join(SHOTS, "paypal-popup.png");
  const logFile = path.join(RAW, "slop.json");
  if (!fs.existsSync(popupShot) || !fs.existsSync(logFile)) return false;
  const log = JSON.parse(fs.readFileSync(logFile, "utf8")) as SegmentLog;
  const at = (log.markers["popup-open"] ?? 0) + 0.4;
  const pw = Math.round((log.popup?.cssSize.width ?? 500) * (4 / 3));
  const ph = Math.round((log.popup?.cssSize.height ?? 760) * (4 / 3));
  const scale = Math.min(1, (1080 - 190) / ph);
  const sw = Math.round((pw * scale) / 2) * 2;
  const sh = Math.round((ph * scale) / 2) * 2;
  const frame = await renderOverlay(popupFrame(sw, sh, log.popup?.host ?? "www.sandbox.paypal.com"), "popupframe");
  const fx = Math.round((1920 - frame.w) / 2);
  const fy = Math.round((1080 - frame.h) / 2);
  await ff([
    "-ss", String(at), "-i", log.video, "-i", frame.file, "-i", popupShot,
    "-filter_complex",
    `[0:v]scale=1920:1080,setsar=1,gblur=sigma=7,eq=brightness=-0.16:saturation=0.7[bg];[2:v]scale=${sw}:${sh}:flags=lanczos[pp];[bg][1:v]overlay=${fx}:${fy}[bf];[bf][pp]overlay=${fx + 8}:${fy + 52}`,
    "-frames:v", "1", dest,
  ]);
  return true;
}

export async function gallery(): Promise<void> {
  ensureDir(GALLERY);
  const pick: Array<[string, string]> = [
    ["1-report-form", "01-report-form"],
    ["3-live-triage", "03-live-triage"],
    ["4-slop-evidence", "04-slop-evidence"],
    ["5-reproduced-replay", "05-reproduced-replay"],
    ["6-console", "06-console"],
    ["7-transparency", "07-transparency"],
  ];
  for (const [src, dst] of pick) {
    const f = path.join(SHOTS, `${src}.png`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(GALLERY, `${dst}.png`));
    else console.log(`  missing screenshot ${src} (record that segment)`);
  }
  if (await paypalSheet(path.join(GALLERY, "02-paypal-sheet.png"))) console.log("  02-paypal-sheet composed");
  await closeRenderer();
  console.log(`gallery -> ${GALLERY}`);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function youtube(): void {
  const timingsFile = path.join(OUT, "timings.json");
  const timings = fs.existsSync(timingsFile)
    ? (JSON.parse(fs.readFileSync(timingsFile, "utf8")) as { seconds: number; scenes: Array<{ scene: string; start: number }> })
    : undefined;
  const names: Record<string, string> = {
    hook: "AI slop broke bug bounties",
    idea: "The idea: a refundable PayPal deposit",
    slop: "A polished slop report gets caught",
    real: "A real IDOR gets reproduced and paid",
    proof: "Console, transparency and eval numbers",
    close: "Good Faith",
  };
  const chapters = timings?.scenes.map((s, i) => `${mmss(i === 0 ? 0 : s.start)} ${names[s.scene] ?? s.scene}`).join("\n") ?? "(run the assemble step for chapters)";
  const md = `# YouTube upload: Good Faith demo

Upload \`goodfaith-demo.mp4\`${timings ? ` (${mmss(timings.seconds)})` : ""}, then add \`goodfaith-demo.srt\` under Subtitles (English) so the captions are searchable too (they are also burned in).
Thumbnail: \`thumbnail-youtube-16x9.png\`. Devpost thumbnail: \`thumbnail-devpost-3x2.png\`. Gallery: \`gallery/\`.
Visibility: Public or Unlisted (the Devpost link must play without sign-in). Category: Science & Technology. Not made for kids.

## Title (${"Good Faith: bug bounties that survive the AI-slop era | PayPal + Claude".length} chars)
Good Faith: bug bounties that survive the AI-slop era | PayPal + Claude

## Description
AI made convincing vulnerability reports free to write, and open-source maintainers got buried. curl ended its bug bounty; HackerOne paused the Internet Bug Bounty.

Good Faith brings bounties back. Reporting stays free. Claiming a bounty takes a refundable $20 PayPal deposit, an authorization hold rather than a charge. Before anyone pays, Claude reproduces the claim against a sandboxed copy of the project seeded with secret canaries. Reproduced bugs are paid through PayPal Payouts in minutes; fabricated reports lose the deposit, only after a maintainer confirms. The AI recommends; it never moves money.

Everything in this video is the real app on the PayPal sandbox (test money only) with live Claude triage. Waiting time is sped up and labelled on screen.

Try it: https://goodfaith-bounties.vercel.app
Judge mode (three claims settle end to end): https://goodfaith-bounties.vercel.app/demo
Code (Apache-2.0): REPO_LINK_HERE

Chapters
${chapters}

Measured results (packages/triage/evals)
- curl's real reports: 0 of 5 real CVE reports flagged as slop; 2 of 10 published AI-slop reports caught on hard evidence (they cite code that doesn't exist); the other 8 cite real code and go to a human.
- Lantern test corpus: 30/30 with live Claude Opus 5.5, and 30/30 scripted; 0 honest reports called slop.

Built with
PayPal Orders v2 (AUTHORIZE and CAPTURE), Payments v2 (void, capture), Payouts, Disputes, Webhooks, JS SDK v6 · Claude Opus 5.5 (Anthropic API) · TypeScript · Next.js · React · AG Grid · Hono · zod · Vitest

Sources
- ${HEADLINES.curl.outlet}, ${HEADLINES.curl.date}: "${HEADLINES.curl.headline}" https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/
- ${HEADLINES.ibb.outlet}, ${HEADLINES.ibb.date}: "${HEADLINES.ibb.headline}" https://www.infoworld.com/article/4154210/internet-bug-bounty-program-hits--on-payouts.html

Narration: synthetic voice (Gemini TTS). No music. News outlets are cited as text only; no third-party logos.
Built for the PayPal AI Hackathon.

## Tags
bug bounty, AI slop, open source security, PayPal, PayPal Payouts, Claude, Anthropic, vulnerability disclosure, hackathon
`;
  fs.writeFileSync(path.join(OUT, "youtube.md"), md);
  console.log(`youtube.md -> ${path.join(OUT, "youtube.md")}`);
}

if (process.argv[1]?.endsWith("assets.ts")) {
  if (!fs.existsSync(path.join(OUT, "thumbnail-youtube-16x9.png"))) console.log(`  thumbnails missing: run the cards step (${CARDS})`);
  await gallery();
  youtube();
}
