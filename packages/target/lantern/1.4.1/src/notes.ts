// Lantern notes API: list, read, create and update a user's notes.

import type { Hono } from "hono";
import type { AppEnv } from "./app.js";
import { requireUser } from "./auth.js";
import type { Database, Note } from "./db.js";

interface NotesDeps {
  db: Database;
}

function noteView(note: Note) {
  return {
    id: note.id,
    ownerId: note.ownerId,
    title: note.title,
    body: note.body,
    visibility: note.visibility,
    updatedAt: note.updatedAt,
  };
}

export function registerNoteRoutes(app: Hono<AppEnv>, deps: NotesDeps): void {
  // List the signed-in user's own notes.
  app.get("/api/notes", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return c.json({ notes: deps.db.listNotesByOwner(user.id).map(noteView) });
  });

  // Read a single note by id. Only the owner (or an administrator) may read it; other ids are
  // reported as not found so note ids cannot be probed for existence.
  app.get("/api/notes/:id", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const note = deps.db.getNote(c.req.param("id"));
    if (!note || (note.ownerId !== user.id && user.role !== "admin")) return c.json({ error: "note not found" }, 404);
    return c.json({ note: noteView(note) });
  });

  // Create a note owned by the signed-in user.
  app.post("/api/notes", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = await c.req.json<{ title?: string; body?: string; visibility?: string }>().catch(() => ({}) as { title?: string; body?: string; visibility?: string });
    const note = deps.db.createNote({
      id: deps.db.nextId("note_"),
      ownerId: user.id,
      title: typeof body.title === "string" ? body.title : "Untitled",
      body: typeof body.body === "string" ? body.body : "",
      visibility: body.visibility === "shared" ? "shared" : "private",
      updatedAt: new Date(0).toISOString(),
    });
    return c.json({ note: noteView(note) }, 201);
  });

  // Update a note. Owner-only in every version.
  app.patch("/api/notes/:id", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const note = deps.db.getNote(c.req.param("id"));
    if (!note || note.ownerId !== user.id) return c.json({ error: "note not found" }, 404);
    const body = await c.req.json<{ title?: string; body?: string; visibility?: string }>().catch(() => ({}) as { title?: string; body?: string; visibility?: string });
    if (typeof body.title === "string") note.title = body.title;
    if (typeof body.body === "string") note.body = body.body;
    if (body.visibility === "shared" || body.visibility === "private") note.visibility = body.visibility;
    return c.json({ note: noteView(note) });
  });
}
