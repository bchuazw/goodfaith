import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileStore, createMemoryStore, KEEP, openDb, type Store, StoreConflictError } from "@/lib/server/store";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-store-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const adapters: Array<[string, () => Store]> = [
  ["memory", () => createMemoryStore()],
  ["file", () => createFileStore(path.join(tmp, `${Math.random().toString(36).slice(2)}.json`))],
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

describe("repo.update (compare-and-set read-modify-write)", () => {
  it("re-runs the update function after losing a race and never loses a write", async () => {
    const db = openDb(createMemoryStore());
    await db.reports.put("c", { n: 0 } as never);
    // 20 concurrent increments through CAS: every one lands.
    await Promise.all(Array.from({ length: 20 }, () => db.reports.update("c", (cur) => ({ n: ((cur as unknown as { n: number }).n ?? 0) + 1 }) as never)));
    expect(((await db.reports.value("c")) as unknown as { n: number }).n).toBe(20);
  });

  it("KEEP leaves the document and its version alone", async () => {
    const db = openDb(createMemoryStore());
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
