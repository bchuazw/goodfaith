/**
 * JSON-file Store for local development (`.data/`, gitignored): the memory adapter, persisted after
 * every change with an atomic write (temp file + rename). It is single-process by design; hosted
 * deployments use a shared adapter instead.
 */
import fs from "node:fs";
import path from "node:path";
import { createMemoryStore, emptyMemoryState, type MemoryState } from "./memory";
import type { Store } from "./types";

export type FileStore = Store & {
  readonly file: string;
  /** Resolves once every change so far is on disk. */
  flush(): Promise<void>;
};

function load(file: string): MemoryState {
  if (!fs.existsSync(file)) return emptyMemoryState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MemoryState>;
    const base = emptyMemoryState();
    return { docs: { ...base.docs, ...(parsed.docs ?? {}) }, lists: parsed.lists ?? {} };
  } catch {
    // Keep the unreadable file for inspection and start empty rather than refusing to boot.
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    return emptyMemoryState();
  }
}

export function createFileStore(file: string): FileStore {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let latest: MemoryState | undefined;
  let writing: Promise<void> = Promise.resolve();
  let scheduled = false;

  const writeNow = async () => {
    scheduled = false;
    if (!latest) return;
    const json = JSON.stringify(latest);
    const tmp = `${resolved}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, json, "utf8");
      await fs.promises.rename(tmp, resolved);
    } catch (e) {
      // The in-memory state stays authoritative; the next change retries the write.
      console.error(`[goodfaith] could not write ${resolved}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const memory = createMemoryStore({
    initial: load(resolved),
    kind: "file",
    onChange: (state) => {
      latest = state;
      if (scheduled) return;
      scheduled = true;
      // Coalesce bursts (a triage run appends dozens of events) into one write; writes never overlap.
      writing = writing.then(() => new Promise((r) => setTimeout(r, 20))).then(writeNow, writeNow);
    },
  });

  return {
    ...memory,
    kind: "file",
    file: resolved,
    async flush() {
      await writing;
      if (scheduled) await writing;
    },
  };
}
