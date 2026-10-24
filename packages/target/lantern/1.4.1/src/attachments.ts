// Lantern attachments API: upload a file to a note and download it again.
//
// Files are stored in the virtual filesystem under UPLOAD_DIR. The server's own configuration,
// including secrets.env, lives one level up in SERVER_ROOT and is never meant to be downloadable.

import type { Hono } from "hono";
import type { AppEnv } from "./app.js";
import { requireUser } from "./auth.js";
import type { Database } from "./db.js";
import { joinPath, normalizePath, type VirtualFileSystem } from "./storage.js";

export const SERVER_ROOT = "/srv/lantern";
export const UPLOAD_DIR = "/srv/lantern/uploads";

interface AttachmentDeps {
  db: Database;
  vfs: VirtualFileSystem;
}

function basename(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] ?? name;
}

export function registerAttachmentRoutes(app: Hono<AppEnv>, deps: AttachmentDeps): void {
  // Upload a file and attach it to a note the caller owns.
  app.post("/api/notes/:id/attachments", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const note = deps.db.getNote(c.req.param("id"));
    if (!note || note.ownerId !== user.id) return c.json({ error: "note not found" }, 404);
    const body = await c.req.json<{ filename?: string; content?: string; contentType?: string }>().catch(() => ({}) as { filename?: string; content?: string; contentType?: string });
    const filename = basename(typeof body.filename === "string" ? body.filename : "upload.txt");
    const content = typeof body.content === "string" ? body.content : "";
    const storedPath = `${UPLOAD_DIR}/${filename}`;
    deps.vfs.write(storedPath, { content, contentType: body.contentType ?? "text/plain" });
    const attachment = deps.db.addAttachment({
      id: deps.db.nextId("att_"),
      noteId: note.id,
      ownerId: user.id,
      filename,
      storedPath,
      contentType: body.contentType ?? "text/plain",
      size: content.length,
    });
    return c.json({ attachment: { id: attachment.id, filename, size: attachment.size } }, 201);
  });

  // Download a previously uploaded file by name. The resolved path must stay inside the upload
  // directory, so names like `../secrets.env` are rejected.
  app.get("/api/attachments/download", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const name = c.req.query("file") ?? "";
    if (!name) return c.json({ error: "file is required" }, 400);
    if (name.includes("\0")) return c.json({ error: "invalid file name" }, 400);
    const base = normalizePath(UPLOAD_DIR);
    const target = joinPath(UPLOAD_DIR, name);
    if (target !== base && !target.startsWith(`${base}/`)) return c.json({ error: "invalid file name" }, 400);
    const file = deps.vfs.read(target);
    if (!file) return c.json({ error: "file not found" }, 404);
    c.header("content-type", file.contentType);
    c.header("content-disposition", `attachment; filename="${basename(name)}"`);
    return c.body(file.content);
  });
}
