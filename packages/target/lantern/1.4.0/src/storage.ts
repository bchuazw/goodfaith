// Lantern storage: a tiny in-memory virtual filesystem used for note attachments.
//
// Everything lives in a Map keyed by an absolute POSIX path. There is deliberately no real disk
// access, so a self-hosted Lantern can run attachments without touching the host filesystem.

export interface StoredFile {
  content: string;
  contentType: string;
}

/** POSIX-style path normalisation. Collapses `.` and `..` segments; keeps a single leading slash. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/** Joins a base directory and a relative path the naive way: concatenate, then normalise. */
export function joinPath(base: string, rel: string): string {
  return normalizePath(`${base}/${rel}`);
}

export class VirtualFileSystem {
  private readonly files = new Map<string, StoredFile>();

  constructor(seed: Record<string, StoredFile | string> = {}) {
    for (const [path, value] of Object.entries(seed)) {
      const file = typeof value === "string" ? { content: value, contentType: "text/plain" } : value;
      this.files.set(normalizePath(path), file);
    }
  }

  exists(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  read(path: string): StoredFile | undefined {
    return this.files.get(normalizePath(path));
  }

  write(path: string, file: StoredFile): void {
    this.files.set(normalizePath(path), file);
  }

  /** Lists files under a directory prefix (non-recursive paths are returned verbatim). */
  list(dir: string): string[] {
    const prefix = `${normalizePath(dir)}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }
}
