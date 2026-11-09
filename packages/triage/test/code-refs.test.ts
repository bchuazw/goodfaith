import { lanternCodeSource } from "@goodfaith/target";
import { describe, expect, it } from "vitest";
import { checkCodeRefs, normaliseComponent } from "../src/code-refs.js";

describe("normaliseComponent", () => {
  it("drops a route or an HTTP verb that the extractor put in symbol", () => {
    expect(normaliseComponent({ path: "src/notes.ts", symbol: "GET /api/notes/:id" })).toEqual({ path: "src/notes.ts" });
    expect(normaliseComponent({ path: "src/notes.ts", symbol: "get" })).toEqual({ path: "src/notes.ts" });
    expect(normaliseComponent({ path: "src/notes.ts", symbol: "/api/notes/:id" })).toEqual({ path: "src/notes.ts" });
  });

  it("keeps real identifiers, without trailing parentheses", () => {
    expect(normaliseComponent({ path: "src/notes.ts", symbol: "getNote()" })).toEqual({ path: "src/notes.ts", symbol: "getNote" });
    expect(normaliseComponent({ path: "src/session.ts", symbol: "lantern_session_rehydrate" })).toEqual({ path: "src/session.ts", symbol: "lantern_session_rehydrate" });
  });
});

describe("checkCodeRefs with a cited route", () => {
  const code = lanternCodeSource();

  it("checks the file alone and is not a hard failure", async () => {
    const res = await checkCodeRefs([{ path: "src/notes.ts", symbol: "GET /api/notes/:id" }], "1.4.0", code);
    expect(res.hardFailure).toBe(false);
    expect(res.findings.map((f) => f.status)).toEqual(["pass"]);
  });

  it("still treats an invented function in a real file as hard evidence", async () => {
    const res = await checkCodeRefs([{ path: "src/notes.ts", symbol: "getNoteBackdoorUnsafe" }], "1.4.0", code);
    expect(res.hardFailure).toBe(true);
    expect(res.findings[0]?.status).toBe("fail");
  });
});
