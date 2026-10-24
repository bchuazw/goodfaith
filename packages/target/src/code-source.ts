// lanternCodeSource(): read-only access to Lantern's bundled source at a given version.
//
// Triage cites files and symbols ("src/notes.ts", "registerNoteRoutes") and we check they actually
// exist at the claimed version. findSymbol finds *definitions* (functions, consts, classes, methods,
// interfaces, types), not mere mentions, so a hallucinated function name returns [].

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeLocation, CodeSource } from "@goodfaith/core";

const LANTERN_ROOT = fileURLToPath(new URL("../lantern/", import.meta.url));
const VERSIONS = ["1.4.0", "1.4.1"] as const;

function canonicalVersion(version: string): string | undefined {
  const v = version.trim().replace(/^v/i, "");
  return (VERSIONS as readonly string[]).includes(v) ? v : undefined;
}

export function lanternCodeSource(): CodeSource {
  const fileListCache = new Map<string, string[]>();
  const fileCache = new Map<string, string | undefined>();

  async function listFilesFor(ref: string): Promise<string[]> {
    const cached = fileListCache.get(ref);
    if (cached) return cached;
    const dir = join(LANTERN_ROOT, ref);
    const files = (await walk(dir)).map((p) => relative(dir, p).split(sep).join("/")).sort();
    fileListCache.set(ref, files);
    return files;
  }

  async function read(path: string, ref: string): Promise<string | undefined> {
    const rel = path.replace(/^\.?\//, "");
    const key = `${ref}::${rel}`;
    if (fileCache.has(key)) return fileCache.get(key);
    const full = join(LANTERN_ROOT, ref, rel);
    // Containment check: never read outside the version directory.
    const base = join(LANTERN_ROOT, ref);
    let content: string | undefined;
    if (full === base || full.startsWith(base + sep)) {
      content = await fsReadFile(full, "utf8").catch(() => undefined);
    }
    fileCache.set(key, content);
    return content;
  }

  return {
    id: "lantern@bundled",

    async resolveVersion(version: string): Promise<string | undefined> {
      return canonicalVersion(version);
    },

    async listVersions(): Promise<string[]> {
      return [...VERSIONS];
    },

    async listFiles(ref: string): Promise<string[]> {
      const canonical = canonicalVersion(ref);
      return canonical ? listFilesFor(canonical) : [];
    },

    async readFile(path: string, ref: string): Promise<string | undefined> {
      const canonical = canonicalVersion(ref);
      return canonical ? read(path, canonical) : undefined;
    },

    async findSymbol(name: string, ref: string): Promise<CodeLocation[]> {
      const canonical = canonicalVersion(ref);
      if (!canonical || !/^[A-Za-z_$][\w$]*$/.test(name)) return [];
      const matchers = definitionMatchers(name);
      const out: CodeLocation[] = [];
      for (const file of await listFilesFor(canonical)) {
        if (!file.endsWith(".ts")) continue;
        const content = await read(file, canonical);
        if (content === undefined || !content.includes(name)) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          if (matchers.some((re) => re.test(line))) out.push({ path: file, line: i + 1, symbol: name });
        }
      }
      return out;
    },
  };
}

/** Regexes that match a *definition* of `name` on a single line of TypeScript. */
function definitionMatchers(name: string): RegExp[] {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = "^\\s*(?:export\\s+)?(?:default\\s+)?";
  return [
    new RegExp(`${prefix}(?:async\\s+)?function\\s+${n}\\b`),
    new RegExp(`${prefix}(?:const|let|var)\\s+${n}\\b`),
    new RegExp(`${prefix}(?:abstract\\s+)?(?:class|interface|type|enum|namespace)\\s+${n}\\b`),
    // Class / object method or accessor declaration: `name(...) {`, `async name(...) {`, `get name() {`.
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|override\\s+|async\\s+|get\\s+|set\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::[^;{]+)?\\{`),
  ];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
