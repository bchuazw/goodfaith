/**
 * Live check of the Upstash Redis Store adapter: the real Lua compare-and-set, racing instances and the
 * event lists. Runs only with KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*). Under test:live it
 * also reads them from the repo-root .env.vercel.local / .env.local without printing them. Every key lives
 * under a fresh "gftest:<run>:" prefix and is deleted afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisStore, KEEP, openDb, StoreConflictError, upstashCredentials } from "@/lib/server/store";

function loadKvEnv(): void {
  const root = path.resolve(__dirname, "../../../..");
  for (const file of [path.join(root, ".env.vercel.local"), path.join(root, ".env.local")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*((?:KV_REST_API|UPSTASH_REDIS_REST)_(?:URL|TOKEN))\s*=\s*(.*)\s*$/.exec(line);
      if (!m?.[1] || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
if (process.env.npm_lifecycle_event === "test:live") loadKvEnv();

const creds = upstashCredentials(process.env);
const prefix = `gftest:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`;
const redis = creds ? new Redis({ url: creds.url, token: creds.token, automaticDeserialization: false, enableTelemetry: false }) : undefined;
const store = () => createRedisStore(redis as Redis, { prefix });

describe.skipIf(!creds)("Upstash Redis store (live)", () => {
  afterAll(async () => {
    if (!redis) return;
    await store().reset();
    const [, left] = await redis.scan(0, { match: `${prefix}*`, count: 1000 });
    console.log(`[redis-live] prefix ${prefix} cleaned up; keys left: ${left.length}`);
  });

  it("versions documents and compare-and-sets with the Lua script", async () => {
    const s = store();
    expect(await s.get("reports", "r1")).toBeUndefined();
    expect(await s.put("reports", "r1", { n: 1, note: "unicode ✓ | pipes | quotes \"'" }, { ifVersion: 0 })).toBe(1);
    await expect(s.put("reports", "r1", { n: 2 }, { ifVersion: 0 })).rejects.toBeInstanceOf(StoreConflictError);
    expect(await s.put("reports", "r1", { n: 2 }, { ifVersion: 1 })).toBe(2);
    await expect(s.put("reports", "r1", { n: 3 }, { ifVersion: 1 })).rejects.toMatchObject({ code: "STORE_CONFLICT", expected: 1, actual: 2 });
    expect(await s.get("reports", "r1")).toEqual({ id: "r1", version: 2, value: { n: 2 } });
    expect(await s.put("reports", "r1", { n: 4 })).toBe(3);
    expect((await s.list("reports")).map((d) => [d.id, d.version])).toEqual([["r1", 3]]);
    await s.delete("reports", "r1");
    expect(await s.get("reports", "r1")).toBeUndefined();
    await s.put("reports", "r2", { note: "unicode ✓ | pipes | quotes \"'" });
    expect((await s.get<{ note: string }>("reports", "r2"))?.value.note).toBe("unicode ✓ | pipes | quotes \"'");
  });

  it("two instances racing to create the same deposit: exactly one wins", async () => {
    const [a, b] = [store(), store()];
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).put("deposits", "race", { by: i }, { ifVersion: 0 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof StoreConflictError)).toBe(true);
    expect((await a.get("deposits", "race"))?.version).toBe(1);
  });

  it("concurrent read-modify-writes through repo.update never lose a write", async () => {
    const [a, b] = [openDb(store()), openDb(store())];
    await a.reports.put("counter", { n: 0 } as never);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).reports.update("counter", (cur) => ({ n: ((cur as unknown as { n: number }).n ?? 0) + 1 }) as never)));
    expect(((await a.reports.value("counter")) as unknown as { n: number }).n).toBe(12);
    expect((await b.reports.update("counter", () => KEEP)).changed).toBe(false);
  });

  it("appends triage events with per-list sequence numbers and reads after a cursor", async () => {
    const db = openDb(store());
    const ev = (n: number) => ({ attempt: 1, event: { type: "stage" as const, stage: "claims" as const, status: "start" as const, note: `n${n}`, at: new Date(0).toISOString() } });
    const seqs = [];
    for (let n = 1; n <= 4; n++) seqs.push(await db.events.append("rpt_live", ev(n)));
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect((await db.events.read("rpt_live", 2)).map((e) => [e.seq, (e.value.event as { note?: string }).note])).toEqual([
      [3, "n3"],
      [4, "n4"],
    ]);
    expect((await store().read("events:rpt_live", 1, 2)).map((e) => e.seq)).toEqual([2, 3]);
    expect(await store().read("events:none")).toEqual([]);
  });
});
