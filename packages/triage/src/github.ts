// githubCodeSource(): a CodeSource backed by the GitHub REST API, with a disk cache.
//
// Used for the real-world corpus (curl): we check that files/symbols cited by publicly disclosed
// reports exist at the cited version. A GITHUB_TOKEN raises the rate limit; it is never logged.
// Responses are cached under cacheDir so re-runs do not hit the API.

import { createHash } from "node:crypto";
import { mkdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeLocation, CodeSource } from "@goodfaith/core";

export interface GithubCodeSourceOptions {
  owner: string;
  repo: string;
  token?: string;
  cacheDir?: string;
  fetch?: typeof fetch;
}

const API = "https://api.github.com";

export function githubCodeSource(opts: GithubCodeSourceOptions): CodeSource {
  const doFetch = opts.fetch ?? fetch;
  const cacheDir = opts.cacheDir ?? ".cache/github";
  const slug = `${opts.owner}/${opts.repo}`;
  const refCache = new Map<string, string | undefined>();
  const treeCache = new Map<string, string[]>();

  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "goodfaith-triage" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  async function cachedJson(path: string): Promise<unknown | undefined> {
    return cached(path, headers, "json", doFetch, cacheDir);
  }

  return {
    id: `github:${slug}`,

    async resolveVersion(version: string): Promise<string | undefined> {
      if (refCache.has(version)) return refCache.get(version);
      // Try the version as given and a few common tag spellings (e.g. curl uses curl-8_5_0).
      const candidates = [version, `v${version}`, `curl-${version.replace(/\./g, "_")}`, version.replace(/\./g, "_")];
      let resolved: string | undefined;
      for (const ref of candidates) {
        const commit = (await cachedJson(`/repos/${slug}/commits/${encodeURIComponent(ref)}`)) as { sha?: string } | undefined;
        if (commit?.sha) {
          resolved = commit.sha;
          break;
        }
      }
      refCache.set(version, resolved);
      return resolved;
    },

    async listVersions(): Promise<string[]> {
      const tags = (await cachedJson(`/repos/${slug}/tags?per_page=100`)) as Array<{ name: string }> | undefined;
      return (tags ?? []).map((t) => t.name);
    },

    async listFiles(ref: string): Promise<string[]> {
      const cached = treeCache.get(ref);
      if (cached) return cached;
      const tree = (await cachedJson(`/repos/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`)) as
        | { tree?: Array<{ path: string; type: string }> }
        | undefined;
      const files = (tree?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
      treeCache.set(ref, files);
      return files;
    },

    async readFile(path: string, ref: string): Promise<string | undefined> {
      const rel = path.replace(/^\.?\//, "");
      const text = await cached(`/repos/${slug}/contents/${rel.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { ...headers, accept: "application/vnd.github.raw+json" }, "text", doFetch, cacheDir);
      return typeof text === "string" ? text : undefined;
    },

    // Symbol-only lookups are not feasible over the API without cloning. The triage code-ref check
    // reads the cited file and verifies the definition there, so this is a best-effort fallback.
    async findSymbol(_name: string, _ref: string): Promise<CodeLocation[]> {
      return [];
    },
  };
}

async function cached(apiPath: string, headers: Record<string, string>, kind: "json" | "text", doFetch: typeof fetch, cacheDir: string): Promise<unknown> {
  const key = createHash("sha256").update(`${kind}:${apiPath}`).digest("hex").slice(0, 32);
  const file = join(cacheDir, `${key}.${kind === "json" ? "json" : "txt"}`);
  try {
    const hit = await fsReadFile(file, "utf8");
    if (hit === "\0__404__") return undefined;
    return kind === "json" ? JSON.parse(hit) : hit;
  } catch {
    // not cached yet
  }
  const res = await doFetch(`${API}${apiPath}`, { headers });
  if (res.status === 404) {
    await persist(file, "\0__404__");
    return undefined;
  }
  if (!res.ok) {
    // Do not cache transient errors (rate limits etc.).
    throw new Error(`GitHub API ${res.status} for ${apiPath}`);
  }
  const body = await res.text();
  await persist(file, body);
  return kind === "json" ? JSON.parse(body) : body;
}

async function persist(file: string, content: string): Promise<void> {
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  } catch {
    // caching is best-effort
  }
}
