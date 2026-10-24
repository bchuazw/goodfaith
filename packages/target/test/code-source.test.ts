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

  it("returns nothing for an unknown ref", async () => {
    expect(await code.listFiles("9.9.9")).toEqual([]);
    expect(await code.readFile("src/notes.ts", "9.9.9")).toBeUndefined();
    expect(await code.findSymbol("registerNoteRoutes", "9.9.9")).toEqual([]);
  });
});
