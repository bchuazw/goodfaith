/**
 * The whole pipeline in one command:
 *   pnpm --filter @goodfaith/video all -- --base https://goodfaith-bounties.vercel.app
 * Steps: narration (cached) -> cards and thumbnails -> recording -> assembly -> gallery and youtube.md.
 * --skip-record reuses out/raw; --only slop,real,proof re-records some segments.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { args, VIDEO_DIR } from "./env.js";

const a = args();
const pass = process.argv.slice(2);

function step(script: string, extra: string[] = []): Promise<void> {
  console.log(`\n== ${script}`);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", path.join(VIDEO_DIR, "src", script), ...extra], { cwd: VIDEO_DIR, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

await step("tts.ts");
await step("cards.ts");
if (!a["skip-record"]) await step("record.ts", pass);
await step("assemble.ts");
await step("assets.ts");
