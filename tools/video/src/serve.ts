/**
 * Runs the web app for local recording: `next build` (optional) then `next start` on a non-default port,
 * with the root .env.local passed through the environment (values are never printed).
 *
 *   pnpm --filter @goodfaith/video serve -- --app <checkout> --port 3100 --mode live --data <file> [--build]
 *
 * --app defaults to this repo; point it at a separate worktree when another `next dev` holds .next/dev.
 * --data gives the recording its own file store, so the console starts clean.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { args, env, REPO_ROOT } from "./env.js";

const a = args();
const app = path.resolve(typeof a.app === "string" ? a.app : REPO_ROOT);
const port = typeof a.port === "string" ? a.port : "3100";
const mode = typeof a.mode === "string" ? a.mode : "live";
const web = path.join(app, "apps", "web");

const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(env())) if (v !== undefined) childEnv[k] = v;
childEnv.GOODFAITH_MODE = mode;
if (typeof a.data === "string") childEnv.GOODFAITH_DATA_FILE = path.resolve(a.data);
childEnv.NEXT_TELEMETRY_DISABLED = "1";

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: web, env: childEnv, stdio: "inherit", shell: process.platform === "win32" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}`))));
  });
}

if (a.build) await run("npx", ["next", "build"]);
await run("npx", ["next", "start", "-p", port]);
