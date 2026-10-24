import type { HttpPoc } from "@goodfaith/core";
import { describe, expect, it, vi } from "vitest";
import { createLanternRunner, LANTERN_PROGRAM, LANTERN_VERSIONS } from "../src/index.js";

const runner = createLanternRunner();

// --- PoCs for each of the three real 1.4.0 bugs -------------------------------------------------

const idorPoc: HttpPoc = { steps: [{ method: "GET", path: "/api/notes/note_2", as: "alice" }] };

const traversalPoc: HttpPoc = {
  steps: [{ method: "GET", path: "/api/attachments/download?file=../secrets.env", as: "alice" }],
};

const massAssignPoc: HttpPoc = {
  steps: [
    { method: "PATCH", path: "/api/users/me", as: "alice", body: JSON.stringify({ role: "admin" }) },
    { method: "GET", path: "/api/admin/users", as: "alice" },
  ],
};

describe("createLanternRunner: the three bugs reproduce on 1.4.0 and not on 1.4.1", () => {
  it("(a) IDOR on GET /api/notes/:id leaks Bob's private note to Alice", async () => {
    const bad = await runner.replay(idorPoc, "1.4.0");
    expect(bad.canaryHits.map((h) => h.canaryId)).toContain("note");
    expect(bad.steps[0]?.status).toBe(200);
    expect(bad.steps[0]?.bodyExcerpt).toContain("[CANARY:note]");
    expect(bad.steps[0]?.bodyExcerpt).not.toMatch(/CANARY-note-[0-9a-f]/);

    const fixed = await runner.replay(idorPoc, "1.4.1");
    expect(fixed.canaryHits).toEqual([]);
    expect(fixed.steps[0]?.status).toBe(404);
  });

  it("(b) path traversal in attachment download leaks secrets.env", async () => {
    const bad = await runner.replay(traversalPoc, "1.4.0");
    expect(bad.canaryHits.map((h) => h.canaryId)).toContain("env");
    expect(bad.steps[0]?.status).toBe(200);
    expect(bad.steps[0]?.bodyExcerpt).toContain("[CANARY:env]");

    const fixed = await runner.replay(traversalPoc, "1.4.1");
    expect(fixed.canaryHits).toEqual([]);
    expect(fixed.steps[0]?.status).toBe(400);

    // The legitimate download still works on the fixed version.
    const legit = await runner.replay({ steps: [{ method: "GET", path: "/api/attachments/download?file=welcome.txt", as: "alice" }] }, "1.4.1");
    expect(legit.steps[0]?.status).toBe(200);
    expect(legit.canaryHits).toEqual([]);
  });

  it("(c) mass assignment of role escalates Alice to admin and leaks the directory", async () => {
    const bad = await runner.replay(massAssignPoc, "1.4.0");
    expect(bad.steps[1]?.status).toBe(200);
    expect(bad.canaryHits.map((h) => h.canaryId)).toContain("admin");

    const fixed = await runner.replay(massAssignPoc, "1.4.1");
    // Alice is never promoted, so the admin directory stays 403 and no canary leaks.
    expect(fixed.steps[1]?.status).toBe(403);
    expect(fixed.canaryHits).toEqual([]);
  });
});

describe("canaries", () => {
  it("are minted fresh per run and never leak raw into excerpts", async () => {
    // Each replay builds a new instance with new canaries. The raw secret is never echoed into an
    // excerpt (always redacted to the placeholder), so "reproduced" is a fact about this very run and
    // a report cannot have pre-baked the value. Two back-to-back runs both reproduce independently.
    for (const run of [await runner.replay(traversalPoc, "1.4.0"), await runner.replay(traversalPoc, "1.4.0")]) {
      expect(run.canaryHits.map((h) => h.canaryId)).toEqual(["env"]);
      expect(run.steps[0]?.bodyExcerpt).toContain("[CANARY:env]");
      expect(run.steps[0]?.bodyExcerpt).not.toMatch(/CANARY-[a-z]+-[0-9a-f]{4,}/);
    }
    // A seeded runner is reproducible but still mints a distinct secret per replay (the counter
    // advances), so even with a fixed seed successive runs reproduce on their own canaries.
    const seeded = createLanternRunner({ seed: "demo" });
    expect((await seeded.replay(traversalPoc, "1.4.0")).canaryHits).toHaveLength(1);
    expect((await seeded.replay(traversalPoc, "1.4.0")).canaryHits).toHaveLength(1);
  });

  it("are entitled correctly: Bob reading his own note, and the admin reading the directory, are not hits", async () => {
    const bobReadsOwn = await runner.replay({ steps: [{ method: "GET", path: "/api/notes/note_2", as: "bob" }] }, "1.4.0");
    expect(bobReadsOwn.canaryHits).toEqual([]);
    expect(bobReadsOwn.steps[0]?.status).toBe(200);

    const adminReadsDir = await runner.replay({ steps: [{ method: "GET", path: "/api/admin/users", as: "admin" }] }, "1.4.0");
    expect(adminReadsDir.canaryHits).toEqual([]);
    expect(adminReadsDir.steps[0]?.status).toBe(200);
  });
});

describe("limits and input validation", () => {
  it("rejects a PoC with too many steps", async () => {
    const steps = Array.from({ length: 21 }, () => ({ method: "GET" as const, path: "/api/health" }));
    const res = await runner.replay({ steps }, "1.4.0");
    expect(res.error).toMatch(/limit is 20/);
    expect(res.steps).toEqual([]);
  });

  it("rejects reserved headers", async () => {
    const res = await runner.replay({ steps: [{ method: "GET", path: "/api/notes/note_2", headers: { Cookie: "lantern_session=gf_sess_bob" } }] }, "1.4.0");
    expect(res.error).toMatch(/header "Cookie" is set by the sandbox/);
  });

  it("rejects absolute URLs and protocol-relative paths", async () => {
    const abs = await runner.replay({ steps: [{ method: "GET", path: "http://evil.test/x" as string }] }, "1.4.0");
    expect(abs.error).toMatch(/starting with "\/"/);
    const protoRel = await runner.replay({ steps: [{ method: "GET", path: "//evil.test/x" }] }, "1.4.0");
    expect(protoRel.error).toMatch(/starting with "\/"/);
  });

  it("rejects oversized bodies", async () => {
    const res = await runner.replay({ steps: [{ method: "POST", path: "/api/notes", body: "x".repeat(64 * 1024 + 1) }] }, "1.4.0");
    expect(res.error).toMatch(/larger than the/);
  });

  it("honours a custom per-replay time limit", async () => {
    const tiny = createLanternRunner({ limits: { timeoutMs: 0 } });
    const res = await tiny.replay(idorPoc, "1.4.0");
    expect(res.error).toMatch(/time limit/);
  });

  it("rejects an unknown version", async () => {
    const res = await runner.replay(idorPoc, "9.9.9");
    expect(res.error).toMatch(/Unknown Lantern version/);
  });
});

describe("no network access", () => {
  it("never calls global fetch during a replay", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await runner.replay(massAssignPoc, "1.4.0");
    await runner.replay(traversalPoc, "1.4.1");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("metadata", () => {
  it("exposes versions, accounts and the program descriptor", () => {
    expect(runner.versions()).toEqual([...LANTERN_VERSIONS]);
    expect(runner.accounts().map((a) => a.id)).toEqual(["alice", "bob", "admin"]);
    expect(LANTERN_PROGRAM.id).toBe("lantern");
    expect(LANTERN_PROGRAM.bounties.high.value).toBe("500.00");
  });
});
