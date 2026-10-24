/**
 * Turbopack loader for the workspace packages (packages/*), applied to packages/<name>/src and
 * packages/target/lantern only (see next.config.ts). Two build-time adaptations:
 *
 * 1. The packages are written for Node's NodeNext resolution, so a .ts file imports its siblings as
 *    "./client.js". Webpack maps that with resolve.extensionAlias; Turbopack does not support extension
 *    aliasing, so this drops the ".js" from relative specifiers and lets normal resolution find the .ts.
 *
 * 2. @goodfaith/target's code source finds Lantern's bundled files with
 *    `fileURLToPath(new URL("../lantern/", import.meta.url))`. Turbopack treats `new URL(..., import.meta.url)`
 *    as an asset import and cannot bundle a directory, and a build-time file URL would not exist on the
 *    deployed function anyway. It is rewritten to a runtime lookup: GOODFAITH_LANTERN_ROOT, else the
 *    monorepo layout next to the app's working directory (where outputFileTracingIncludes ships the files).
 *    If the pattern ever changes, the build fails loudly again instead of silently misbehaving.
 */
const RELATIVE_JS = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'])(\.{1,2}\/[^"'\n]+?)\.js(["'])/g;
const LANTERN_ROOT_URL = /fileURLToPath\(\s*new URL\(\s*["']\.\.\/lantern\/["']\s*,\s*import\.meta\.url\s*\)\s*\)/;

const RUNTIME_LANTERN_ROOT = `(() => {
  const candidates = [
    process.env.GOODFAITH_LANTERN_ROOT,
    join(process.cwd(), "..", "..", "packages", "target", "lantern"),
    join(process.cwd(), "packages", "target", "lantern"),
  ].filter((p): p is string => !!p);
  return (candidates.find((p) => __goodfaithExistsSync(p)) ?? candidates[0]) + sep;
})()`;

module.exports = function workspaceTsImportsLoader(source) {
  let out = source.replace(RELATIVE_JS, "$1$2$3");
  if (LANTERN_ROOT_URL.test(out)) {
    out = `import { existsSync as __goodfaithExistsSync } from "node:fs";\n${out.replace(LANTERN_ROOT_URL, RUNTIME_LANTERN_ROOT)}`;
  }
  return out;
};
