// Lantern user profile API: read and update your own profile.

import type { Hono } from "hono";
import type { AppEnv } from "./app.js";
import { requireUser } from "./auth.js";
import { publicUser, type User } from "./db.js";

export function registerUserRoutes(app: Hono<AppEnv>): void {
  // The signed-in user's own profile (recovery code withheld).
  app.get("/api/users/me", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return c.json({ user: publicUser(user) });
  });

  // Update the signed-in user's profile.
  //
  // FIXED(1.4.1): only the editable profile fields are copied from the request body. Sensitive
  // fields such as `role`, `id` and `backupCode` can no longer be set through this endpoint.
  app.patch("/api/users/me", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = await c.req.json<Partial<User>>().catch(() => ({}) as Partial<User>);
    if (typeof body.displayName === "string") user.displayName = body.displayName;
    if (typeof body.bio === "string") user.bio = body.bio;
    if (typeof body.email === "string") user.email = body.email;
    return c.json({ user: publicUser(user) });
  });
}
