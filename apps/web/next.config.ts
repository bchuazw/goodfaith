import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

/**
 * Local secrets live in the monorepo root's .env.local (gitignored), shared with the packages' live tests.
 * Next only reads apps/web/.env*, so the root files are loaded here as well: variables already set in the
 * environment (or by apps/web/.env*) win, and values are never logged. Hosted deployments set their
 * variables in the platform instead. GOODFAITH_MODE stays "mock" unless it is set.
 */
function loadRootEnv() {
  const root = path.resolve(process.cwd(), "../..");
  if (!fs.existsSync(path.join(root, "pnpm-workspace.yaml"))) return;
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) {
      if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
    }
  }
}
loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The workspace packages export TypeScript source from src/index.ts, so Next compiles them.
  transpilePackages: ["@goodfaith/core", "@goodfaith/paypal", "@goodfaith/llm", "@goodfaith/triage", "@goodfaith/target"],
  turbopack: {
    rules: {
      // NodeNext-style "./x.js" imports between the packages' .ts files (see the loader for why).
      "*.ts": {
        condition: { path: /(^|\/)packages\/[^/]+\/(src|lantern)\// },
        loaders: [path.join(process.cwd(), "build-tools", "workspace-ts-imports-loader.cjs")],
      },
    },
  },
  // Lantern's bundled source is read at runtime by the code-reference checks: ship it with the functions.
  outputFileTracingIncludes: { "/**": ["../../packages/target/lantern/**/*"] },
};

export default nextConfig;
