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

  // Update the signed-in user's profile with the fields supplied in the request body.
  app.patch("/api/users/me", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = await c.req.json<Partial<User>>().catch(() => ({}) as Partial<User>);
    const id = user.id;
    Object.assign(user, body);
    user.id = id; // keep the id stable
    return c.json({ user: publicUser(user) });
  });
}
