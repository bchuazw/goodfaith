// Lantern 1.4.0 — a small self-hosted notes app (Hono).
//
// This module wires the data store, the virtual filesystem, the session store and the route modules
// into a single Hono application. Create one with `createLanternApp(config)` and serve `app.fetch`.

import { Hono } from "hono";
import { registerAdminRoutes } from "./admin.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { authMiddleware, registerAuthRoutes, SessionStore } from "./auth.js";
import { Database, type Seed, type User } from "./db.js";
import { registerNoteRoutes } from "./notes.js";
import { registerUserRoutes } from "./users.js";
import type { StoredFile } from "./storage.js";
import { VirtualFileSystem } from "./storage.js";

export const LANTERN_VERSION = "1.4.0";

/** Hono environment: every request carries the resolved user (or null when anonymous). */
export type AppEnv = { Variables: { user: User | null } };

export interface AppConfig {
  seed: Seed;
  /** Virtual filesystem contents (absolute POSIX paths), e.g. the server's secrets.env. */
  files?: Record<string, string | StoredFile>;
  /** Pre-registered session tokens (token -> user id), for seeded logged-in accounts. */
  sessions?: Array<{ token: string; userId: string }>;
}

export function createLanternApp(config: AppConfig): Hono<AppEnv> {
  const db = new Database(config.seed);
  const vfs = new VirtualFileSystem(config.files ?? {});
  const sessions = new SessionStore();
  for (const s of config.sessions ?? []) sessions.register(s.token, s.userId);

  const app = new Hono<AppEnv>();

  app.use("/api/*", authMiddleware({ db, sessions }));

  app.get("/", (c) => c.json({ app: "lantern", version: LANTERN_VERSION }));
  app.get("/api/health", (c) => c.json({ ok: true, version: LANTERN_VERSION }));

  registerAuthRoutes(app, { db, sessions });
  registerUserRoutes(app);
  registerNoteRoutes(app, { db });
  registerAttachmentRoutes(app, { db, vfs });
  registerAdminRoutes(app, { db });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
