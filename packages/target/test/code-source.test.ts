import { describe, expect, it } from "vitest";
import { lanternCodeSource } from "../src/index.js";

const code = lanternCodeSource();

describe("lanternCodeSource", () => {
  it("resolves known versions and rejects unknown ones", async () => {
    expect(await code.resolveVersion("1.4.0")).toBe("1.4.0");
    expect(await code.resolveVersion("v1.4.1")).toBe("1.4.1");
    expect(await code.resolveVersion("1.3.0")).toBeUndefined();
    expect(await code.listVersions()).toEqual(["1.4.0", "1.4.1"]);
  });

  it("lists and reads real bundled files", async () => {
    const files = await code.listFiles("1.4.0");
    expect(files).toContain("src/notes.ts");
    expect(files).toContain("src/attachments.ts");
    expect(files).toContain("README.md");

    const notes = await code.readFile("src/notes.ts", "1.4.0");
    expect(notes).toContain("/api/notes/:id");
    expect(await code.readFile("src/notes.ts", "1.4.1")).toContain("note.ownerId !== user.id");
    expect(await code.readFile("src/does-not-exist.ts", "1.4.0")).toBeUndefined();
  });

  it("tolerates a leading ./ or / in the path", async () => {
    expect(await code.readFile("./src/users.ts", "1.4.0")).toBeDefined();
    expect(await code.readFile("/src/users.ts", "1.4.0")).toBeDefined();
  });

  it("finds definitions of functions, consts, classes and methods", async () => {
    const fn = await code.findSymbol("registerNoteRoutes", "1.4.0");
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ path: "src/notes.ts", symbol: "registerNoteRoutes" });
    expect(fn[0]?.line).toBeGreaterThan(0);

    expect((await code.findSymbol("normalizePath", "1.4.0"))[0]?.path).toBe("src/storage.ts");
    expect((await code.findSymbol("VirtualFileSystem", "1.4.0"))[0]?.path).toBe("src/storage.ts");
    expect((await code.findSymbol("Database", "1.4.0"))[0]?.path).toBe("src/db.ts");
    // A class method is a definition.
    expect((await code.findSymbol("listNotesByOwner", "1.4.0"))[0]?.path).toBe("src/db.ts");
  });

  it("returns [] for symbols that are only mentioned or do not exist", async () => {
    // Hallucinated function from the slop demo report.
    expect(await code.findSymbol("lantern_session_rehydrate", "1.4.0")).toEqual([]);
    // Not defined anywhere.
    expect(await code.findSymbol("totallyMadeUpHelper", "1.4.0")).toEqual([]);
    // Invalid identifiers never match.
    expect(await code.findSymbol("not a symbol", "1.4.0")).toEqual([]);
  });

  it("exposes only the requested version's files: a 1.4.0 read never sees 1.4.1's changelog or fixes", async () => {
    // The CHANGELOG that documents the fixes exists only in 1.4.1; triaging a 1.4.0 claim must not
    // be able to read it, or it would be handed the answer.
    expect(await code.readFile("CHANGELOG.md", "1.4.1")).toContain("CWE-639");
    expect(await code.readFile("CHANGELOG.md", "1.4.0")).toBeUndefined();
    expect(await code.listFiles("1.4.0")).not.toContain("CHANGELOG.md");

    // 1.4.0 source carries no comment hinting at the bug or the fix.
    const notes140 = (await code.readFile("src/notes.ts", "1.4.0")) ?? "";
    expect(notes140).not.toMatch(/CWE|owner check|Fixed in|vulnerab|enumerat/i);
    // The 1.4.0 read handler has no owner check (the IDOR); the 1.4.1 one does.
    expect(await code.readFile("src/notes.ts", "1.4.1")).toMatch(/user\.role !== "admin"/);

    // A path that tries to escape the version directory is refused.
    expect(await code.readFile("../1.4.1/CHANGELOG.md", "1.4.0")).toBeUndefined();
    expect(await code.readFile("../../1.4.1/src/notes.ts", "1.4.0")).toBeUndefined();
  });

  it("returns nothing for an unknown ref", async () => {
    expect(await code.listFiles("9.9.9")).toEqual([]);
    expect(await code.readFile("src/notes.ts", "9.9.9")).toBeUndefined();
    expect(await code.findSymbol("registerNoteRoutes", "9.9.9")).toEqual([]);
  });
});
