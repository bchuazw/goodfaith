/**
 * Hosted Store on Redis (Upstash, over its REST API), so every serverless instance shares one truth.
 *
 * Layout under `prefix` (default "gf:" in live mode):
 * - `<prefix>doc:<collection>`: one hash per collection; field = document id, value = "<version>|<json>".
 *   A collection lists in one HGETALL.
 * - `<prefix>list:<name>`: one Redis list per append-only list; RPUSH returns the new length, which is
 *   the entry's sequence number (1, 2, 3, ...), and LRANGE reads after a cursor.
 *
 * Every put runs one Lua script (EVAL), which Redis executes atomically: it reads the stored version,
 * checks `ifVersion` and writes version + 1 in a single step. So two instances racing to settle the same
 * deposit cannot both win the compare-and-set, and the repo's retry loop sees a StoreConflictError.
 */
import { COLLECTIONS, type CollectionName, type Doc, type Store, StoreConflictError } from "./types";

/** The few Redis commands the adapter uses (a subset of @upstash/redis, so tests can pass a fake). */
export interface RedisLike {
  hget(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Compare-and-set put. KEYS[1] = collection hash; ARGV = id, json, expected version ("" = unconditional).
 * Returns {1, newVersion} on success or {0, storedVersion} on a conflict.
 */
export const CAS_PUT_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local ver = 0
if cur then ver = tonumber(string.match(cur, '^(%d+)|')) or 0 end
if ARGV[3] ~= '' and tonumber(ARGV[3]) ~= ver then return {0, ver} end
redis.call('HSET', KEYS[1], ARGV[1], tostring(ver + 1) .. '|' .. ARGV[2])
return {1, ver + 1}
`.trim();

export type RedisStoreOptions = { prefix?: string; kind?: string };

export function createRedisStore(redis: RedisLike, opts: RedisStoreOptions = {}): Store {
  const prefix = opts.prefix ?? "gf:";
  const docKey = (c: CollectionName) => {
    if (!COLLECTIONS.includes(c)) throw new Error(`unknown collection ${c}`);
    return `${prefix}doc:${c}`;
  };
  const listKey = (name: string) => `${prefix}list:${name}`;
  const toJson = (where: string, value: unknown): string => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError(`${where}: value is not JSON-serializable`);
    return json;
  };
  const decode = <T>(id: string, raw: unknown): Doc<T> | undefined => {
    if (typeof raw !== "string") return undefined;
    const bar = raw.indexOf("|");
    const version = Number(raw.slice(0, bar));
    if (bar < 1 || !Number.isInteger(version)) throw new Error(`corrupt document ${id} in the Redis store`);
    return { id, version, value: JSON.parse(raw.slice(bar + 1)) as T };
  };

  return {
    kind: opts.kind ?? "redis",

    async get<T>(collection: CollectionName, id: string): Promise<Doc<T> | undefined> {
      return decode<T>(id, await redis.hget(docKey(collection), id));
    },

    async list<T>(collection: CollectionName): Promise<Doc<T>[]> {
      const reply: unknown = await redis.hgetall(docKey(collection));
      // With automaticDeserialization off, @upstash/redis returns HGETALL as the raw flat [field, value, ...] array.
      const pairs: Array<[string, unknown]> = Array.isArray(reply)
        ? Array.from({ length: Math.floor(reply.length / 2) }, (_, i) => [String(reply[2 * i]), reply[2 * i + 1]] as [string, unknown])
        : Object.entries((reply as Record<string, unknown> | null) ?? {});
      return pairs.flatMap(([id, raw]) => {
        const doc = decode<T>(id, raw);
        return doc ? [doc] : [];
      });
    },

    async put<T>(collection: CollectionName, id: string, value: T, putOpts?: { ifVersion?: number }): Promise<number> {
      const json = toJson(`${collection}/${id}`, value);
      const expected = putOpts?.ifVersion;
      const res = await redis.eval(CAS_PUT_SCRIPT, [docKey(collection)], [id, json, expected === undefined ? "" : String(expected)]);
      const [ok, version] = Array.isArray(res) ? res.map(Number) : [Number.NaN, Number.NaN];
      if (!Number.isInteger(version)) throw new Error(`unexpected reply from the Redis store: ${JSON.stringify(res)}`);
      if (ok !== 1) throw new StoreConflictError(collection, id, expected ?? -1, version as number);
      return version as number;
    },

    async delete(collection: CollectionName, id: string): Promise<void> {
      await redis.hdel(docKey(collection), id);
    },

    async append<T>(list: string, value: T): Promise<number> {
      return redis.rpush(listKey(list), toJson(list, value));
    },

    async read<T>(list: string, afterSeq = 0, limit = Number.POSITIVE_INFINITY): Promise<Array<{ seq: number; value: T }>> {
      const start = Math.max(0, Math.floor(afterSeq));
      if (limit <= 0) return [];
      const stop = Number.isFinite(limit) ? start + Math.floor(limit) - 1 : -1;
      const raw = await redis.lrange(listKey(list), start, stop);
      return raw.map((entry, i) => ({ seq: start + i + 1, value: (typeof entry === "string" ? JSON.parse(entry) : entry) as T }));
    },

    async reset(): Promise<void> {
      let cursor: string | number = 0;
      do {
        const [next, keys]: [string | number, string[]] = await redis.scan(cursor, { match: `${prefix}*`, count: 200 });
        if (keys.length > 0) await redis.del(...keys);
        cursor = next;
      } while (String(cursor) !== "0");
    },
  };
}

/** The Upstash REST credentials in `env`: Vercel's KV_* names first, then Upstash's own. */
export function upstashCredentials(env: Record<string, string | undefined>): { url: string; token: string } | undefined {
  for (const [u, t] of [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ] as const) {
    const url = env[u]?.trim();
    const token = env[t]?.trim(); // never the KV_REST_API_READ_ONLY_TOKEN: the store writes
    if (url && token) return { url, token };
  }
  return undefined;
}
