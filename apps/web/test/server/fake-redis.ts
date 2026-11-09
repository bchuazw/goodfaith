import { CAS_PUT_SCRIPT, type RedisLike } from "@/lib/server/store/redis";

/**
 * An in-memory stand-in for Upstash Redis with the commands the Store adapter uses. Every command yields
 * to the event loop first, like a network round trip, so concurrent callers really interleave. EVAL runs
 * a JavaScript port of CAS_PUT_SCRIPT atomically (no await inside), as Redis runs Lua; any other script
 * is refused, so a script change without a matching port here fails loudly. The live suite
 * (test/live/store.redis.live.test.ts) runs the real Lua on Upstash.
 */
export function createFakeRedis(): RedisLike & { keys(): string[] } {
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const hash = (k: string) => {
    let h = hashes.get(k);
    if (!h) hashes.set(k, (h = new Map()));
    return h;
  };
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

  return {
    keys: () => [...[...hashes.entries()].filter(([, h]) => h.size > 0).map(([k]) => k), ...[...lists.entries()].filter(([, l]) => l.length > 0).map(([k]) => k)],
    async hget(key, field) {
      await tick();
      return hashes.get(key)?.get(field) ?? null;
    },
    async hgetall(key) {
      await tick();
      const h = hashes.get(key);
      // Like @upstash/redis with automaticDeserialization off: the raw flat [field, value, ...] reply.
      return (h && h.size > 0 ? [...h.entries()].flat() : null) as never;
    },
    async hdel(key, ...fields) {
      await tick();
      let n = 0;
      for (const f of fields) if (hashes.get(key)?.delete(f)) n++;
      return n;
    },
    async rpush(key, ...values) {
      await tick();
      const l = lists.get(key) ?? [];
      l.push(...values);
      lists.set(key, l);
      return l.length;
    },
    async lrange(key, start, stop) {
      await tick();
      const l = lists.get(key) ?? [];
      return l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1);
    },
    async eval(script, keys, args) {
      await tick();
      if (script !== CAS_PUT_SCRIPT) throw new Error("fake redis: unknown script");
      const h = hash(keys[0] as string);
      const [id, json, expected] = args as [string, string, string];
      const cur = h.get(id);
      const ver = cur ? Number(/^(\d+)\|/.exec(cur)?.[1] ?? 0) : 0;
      if (expected !== "" && Number(expected) !== ver) return [0, ver];
      h.set(id, `${ver + 1}|${json}`);
      return [1, ver + 1];
    },
    async scan(_cursor, opts) {
      await tick();
      const re = glob(opts.match);
      return ["0", [...hashes.keys(), ...lists.keys()].filter((k) => re.test(k))];
    },
    async del(...keys) {
      await tick();
      let n = 0;
      for (const k of keys) {
        if (hashes.delete(k)) n++;
        if (lists.delete(k)) n++;
      }
      return n;
    },
  };
}
