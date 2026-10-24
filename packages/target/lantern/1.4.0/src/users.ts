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
  // NOTE(1.4.0): the handler merges the request body straight onto the stored user record. The
  // intent is to let people edit their display name and bio, but because the whole body is applied
  // the client can also set `role`, promoting itself to administrator. Fixed in 1.4.1, which only
  // copies the known profile fields. (CWE-915: mass assignment of a sensitive field.)
  app.patch("/api/users/me", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = await c.req.json<Partial<User>>().catch(() => ({}) as Partial<User>);
    const id = user.id;
    Object.assign(user, body);
    user.id = id; // the id stays stable regardless of the payload
    return c.json({ user: publicUser(user) });
  });
}
