import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileStore, createMemoryStore, createRedisStore, KEEP, openDb, type Store, StoreConflictError, storeFromEnv } from "@/lib/server/store";
import { upstashCredentials } from "@/lib/server/store/redis";
import { createFakeRedis } from "./fake-redis";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-store-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const adapters: Array<[string, () => Store]> = [
  ["memory", () => createMemoryStore()],
  ["file", () => createFileStore(path.join(tmp, `${Math.random().toString(36).slice(2)}.json`))],
  ["redis (fake Upstash)", () => createRedisStore(createFakeRedis())],
];

describe.each(adapters)("%s store", (_name, make) => {
  it("versions documents and compare-and-sets on ifVersion", async () => {
    const s = make();
    expect(await s.get("reports", "r1")).toBeUndefined();
    expect(await s.put("reports", "r1", { n: 1 }, { ifVersion: 0 })).toBe(1);
    await expect(s.put("reports", "r1", { n: 2 }, { ifVersion: 0 })).rejects.toBeInstanceOf(StoreConflictError);
    expect(await s.put("reports", "r1", { n: 2 }, { ifVersion: 1 })).toBe(2);
    await expect(s.put("reports", "r1", { n: 3 }, { ifVersion: 1 })).rejects.toMatchObject({ code: "STORE_CONFLICT", expected: 1, actual: 2 });
    expect(await s.get("reports", "r1")).toEqual({ id: "r1", version: 2, value: { n: 2 } });
    expect(await s.put("reports", "r1", { n: 4 })).toBe(3); // unconditional
    await s.delete("reports", "r1");
    expect(await s.get("reports", "r1")).toBeUndefined();
  });

  it("hands out copies, so callers cannot mutate stored state", async () => {
    const s = make();
    const value = { list: [1, 2] };
    await s.put("deposits", "d1", value);
    value.list.push(3);
    const read = await s.get<{ list: number[] }>("deposits", "d1");
    read?.value.list.push(4);
    expect((await s.get<{ list: number[] }>("deposits", "d1"))?.value.list).toEqual([1, 2]);
  });

  it("rejects values that are not JSON", async () => {
    const s = make();
    await expect(s.put("reports", "x", undefined)).rejects.toThrow(/JSON/);
  });

  it("lists, appends with per-list sequence numbers, reads after a cursor, and resets", async () => {
    const s = make();
    await s.put("payouts", "a", 1);
    await s.put("payouts", "b", 2);
    expect((await s.list("payouts")).map((d) => d.id).sort()).toEqual(["a", "b"]);
    expect(await s.append("events:r1", { e: 1 })).toBe(1);
    expect(await s.append("events:r1", { e: 2 })).toBe(2);
    expect(await s.append("events:r2", { e: 9 })).toBe(1);
    expect(await s.append("events:r1", { e: 3 })).toBe(3);
    expect(await s.read("events:r1")).toEqual([
      { seq: 1, value: { e: 1 } },
      { seq: 2, value: { e: 2 } },
      { seq: 3, value: { e: 3 } },
    ]);
    expect(await s.read("events:r1", 1, 1)).toEqual([{ seq: 2, value: { e: 2 } }]);
    expect(await s.read("events:missing", 0)).toEqual([]);
    await s.reset();
    expect(await s.list("payouts")).toEqual([]);
    expect(await s.read("events:r1")).toEqual([]);
  });
});

describe.each([
  ["memory", () => createMemoryStore()],
  ["redis (fake Upstash)", () => createRedisStore(createFakeRedis())],
] as Array<[string, () => Store]>)("repo.update on the %s store (compare-and-set read-modify-write)", (_name, make) => {
  it("re-runs the update function after losing a race and never loses a write", async () => {
    const db = openDb(make());
    await db.reports.put("c", { n: 0 } as never);
    // 20 concurrent increments through CAS: every one lands.
    await Promise.all(Array.from({ length: 20 }, () => db.reports.update("c", (cur) => ({ n: ((cur as unknown as { n: number }).n ?? 0) + 1 }) as never)));
    expect(((await db.reports.value("c")) as unknown as { n: number }).n).toBe(20);
  });

  it("KEEP leaves the document and its version alone", async () => {
    const db = openDb(make());
    await db.deposits.create("d", { status: "AUTHORIZED" } as never);
    const res = await db.deposits.update("d", () => KEEP);
    expect(res).toMatchObject({ changed: false, version: 1 });
  });
});

describe("file store", () => {
  it("survives a restart", async () => {
    const file = path.join(tmp, "restart.json");
    const a = createFileStore(file);
    await a.put("reports", "r1", { title: "persisted" });
    await a.append("events:r1", { n: 1 });
    await a.flush();
    const b = createFileStore(file);
    expect((await b.get("reports", "r1"))?.value).toEqual({ title: "persisted" });
    expect(await b.read("events:r1")).toEqual([{ seq: 1, value: { n: 1 } }]);
  });

  it("starts empty (and keeps the bad file) when the JSON is corrupt", async () => {
    const file = path.join(tmp, "corrupt.json");
    fs.writeFileSync(file, "{not json");
    const s = createFileStore(file);
    expect(await s.list("reports")).toEqual([]);
    expect(fs.readdirSync(tmp).some((f) => f.startsWith("corrupt.json.corrupt-"))).toBe(true);
  });
});

describe("redis store", () => {
  it("two instances on one Redis: of two racing creates exactly one wins, and the loser sees the winner's version", async () => {
    const redis = createFakeRedis();
    const [a, b] = [createRedisStore(redis), createRedisStore(redis)];
    const results = await Promise.allSettled([a.put("deposits", "d1", { by: "a" }, { ifVersion: 0 }), b.put("deposits", "d1", { by: "b" }, { ifVersion: 0 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "STORE_CONFLICT", expected: 0, actual: 1 });
    expect((await a.get("deposits", "d1"))?.version).toBe(1);
  });

  it("keeps everything under its prefix, so reset never touches another app's keys", async () => {
    const redis = createFakeRedis();
    const mine = createRedisStore(redis, { prefix: "gftest:a:" });
    const other = createRedisStore(redis, { prefix: "gftest:b:" });
    await mine.put("reports", "r", 1);
    await mine.append("events:r", 1);
    await other.put("reports", "r", 2);
    expect(redis.keys().sort()).toEqual(["gftest:a:doc:reports", "gftest:a:list:events:r", "gftest:b:doc:reports"]);
    await mine.reset();
    expect(redis.keys()).toEqual(["gftest:b:doc:reports"]);
    expect((await other.get("reports", "r"))?.value).toBe(2);
  });

  it("reads Upstash credentials from Vercel's KV_* names or Upstash's own, never mixing them", () => {
    expect(upstashCredentials({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t1", KV_REST_API_READ_ONLY_TOKEN: "ro" })).toEqual({ url: "https://kv.example", token: "t1" });
    expect(upstashCredentials({ UPSTASH_REDIS_REST_URL: "https://up.example", UPSTASH_REDIS_REST_TOKEN: "t2" })).toEqual({ url: "https://up.example", token: "t2" });
    expect(upstashCredentials({ KV_REST_API_URL: "https://kv.example", UPSTASH_REDIS_REST_TOKEN: "t2" })).toBeUndefined();
    expect(upstashCredentials({ KV_REST_API_URL: "https://kv.example", KV_REST_API_READ_ONLY_TOKEN: "ro" })).toBeUndefined();
  });
});

describe("storeFromEnv", () => {
  const kv = { KV_REST_API_URL: "https://example-kv.upstash.io", KV_REST_API_TOKEN: "token" };

  it("picks Upstash Redis whenever its credentials are set", () => {
    expect(storeFromEnv(kv, "live").kind).toBe("redis");
    expect(storeFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }, "mock").kind).toBe("redis");
    expect(storeFromEnv({ ...kv, GOODFAITH_STORE: "memory" }, "live").kind).toBe("memory");
  });

  it("keeps memory (mock) and file (live) locally", () => {
    expect(storeFromEnv({}, "mock").kind).toBe("memory");
    expect(storeFromEnv({ GOODFAITH_DATA_FILE: path.join(tmp, "env.json") }, "live").kind).toBe("file");
  });

  it("on Vercel without Redis it fails fast instead of touching the read-only filesystem", () => {
    expect(() => storeFromEnv({ VERCEL: "1" }, "live")).toThrow(/hosted store is not configured/i);
    expect(() => storeFromEnv({ VERCEL: "1", GOODFAITH_STORE: "file" }, "live")).toThrow(/hosted store is not configured/i);
    expect(() => storeFromEnv({ VERCEL: "1", GOODFAITH_STORE: "redis" }, "mock")).toThrow(/KV_REST_API_URL/);
    expect(storeFromEnv({ VERCEL: "1", ...kv }, "live").kind).toBe("redis");
    expect(storeFromEnv({ VERCEL: "1" }, "mock").kind).toBe("memory"); // mock mode never needed a disk
  });
});
