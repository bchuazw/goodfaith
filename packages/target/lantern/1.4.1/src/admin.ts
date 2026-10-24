// Lantern administration API: the user directory, visible to administrators only.

import type { Hono } from "hono";
import type { AppEnv } from "./app.js";
import { requireUser } from "./auth.js";
import type { Database } from "./db.js";

interface AdminDeps {
  db: Database;
}

export function registerAdminRoutes(app: Hono<AppEnv>, deps: AdminDeps): void {
  // The full user directory. Includes recovery codes, so it is restricted to administrators.
  app.get("/api/admin/users", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    if (user.role !== "admin") return c.json({ error: "administrator access required" }, 403);
    return c.json({
      users: deps.db.listUsers().map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        backupCode: u.backupCode,
        createdAt: u.createdAt,
      })),
    });
  });
}
