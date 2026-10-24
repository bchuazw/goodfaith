/**
 * In-memory Store for development and tests. Values are kept as JSON text, so callers always get
 * fresh copies, and anything that would not survive a hosted adapter fails here first. Each method does
 * its check and its write without awaiting in between, which makes compare-and-set atomic in-process.
 */
import { COLLECTIONS, type CollectionName, type Doc, type Store, StoreConflictError } from "./types";

type Row = { version: number; json: string };

/** The whole store as plain JSON (what the file adapter writes to disk). */
export type MemoryState = {
  docs: Record<string, Record<string, Row>>;
  lists: Record<string, string[]>;
};

export function emptyMemoryState(): MemoryState {
  return { docs: Object.fromEntries(COLLECTIONS.map((c) => [c, {}])), lists: {} };
}

export type MemoryStoreOptions = {
  initial?: MemoryState;
  /** Called after every mutation (the file adapter schedules a write). */
  onChange?: (state: MemoryState) => void;
  kind?: string;
};

export function createMemoryStore(opts: MemoryStoreOptions = {}): Store {
  let state = opts.initial ?? emptyMemoryState();
  const changed = () => opts.onChange?.(state);
  const bucket = (c: CollectionName): Record<string, Row> => {
    if (!COLLECTIONS.includes(c)) throw new Error(`unknown collection ${c}`);
    state.docs[c] ??= {};
    return state.docs[c] as Record<string, Row>;
  };
  const toJson = (where: string, value: unknown): string => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError(`${where}: value is not JSON-serializable`);
    return json;
  };

  return {
    kind: opts.kind ?? "memory",

    async get<T>(collection: CollectionName, id: string): Promise<Doc<T> | undefined> {
      const row = bucket(collection)[id];
      return row ? { id, version: row.version, value: JSON.parse(row.json) as T } : undefined;
    },

    async list<T>(collection: CollectionName): Promise<Doc<T>[]> {
      return Object.entries(bucket(collection)).map(([id, row]) => ({ id, version: row.version, value: JSON.parse(row.json) as T }));
    },

    async put<T>(collection: CollectionName, id: string, value: T, putOpts?: { ifVersion?: number }): Promise<number> {
      const json = toJson(`${collection}/${id}`, value);
      const rows = bucket(collection);
      const current = rows[id]?.version ?? 0;
      if (putOpts?.ifVersion !== undefined && putOpts.ifVersion !== current) {
        throw new StoreConflictError(collection, id, putOpts.ifVersion, current);
      }
      rows[id] = { version: current + 1, json };
      changed();
      return current + 1;
    },

    async delete(collection: CollectionName, id: string): Promise<void> {
      const rows = bucket(collection);
      if (Object.hasOwn(rows, id)) {
        delete rows[id];
        changed();
      }
    },

    async append<T>(list: string, value: T): Promise<number> {
      const json = toJson(list, value);
      state.lists[list] ??= [];
      const entries = state.lists[list] as string[];
      entries.push(json);
      changed();
      return entries.length;
    },

    async read<T>(list: string, afterSeq = 0, limit = Number.POSITIVE_INFINITY): Promise<Array<{ seq: number; value: T }>> {
      const entries = state.lists[list] ?? [];
      const out: Array<{ seq: number; value: T }> = [];
      for (let i = Math.max(0, Math.floor(afterSeq)); i < entries.length && out.length < limit; i++) {
        out.push({ seq: i + 1, value: JSON.parse(entries[i] as string) as T });
      }
      return out;
    },

    async reset(): Promise<void> {
      state = emptyMemoryState();
      changed();
    },
  };
}
