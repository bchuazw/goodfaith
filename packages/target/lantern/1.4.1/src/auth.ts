// Lantern sessions and authentication.
//
// Sessions are opaque tokens held in memory and presented either as a `lantern_session` cookie or as
// a Bearer token. Passwords are compared against a seeded table; this demo build keeps them in memory.

import type { Context, Hono } from "hono";
import type { AppEnv } from "./app.js";
import type { Database, User } from "./db.js";

const SESSION_COOKIE = "lantern_session";

export class SessionStore {
  private readonly tokens = new Map<string, string>();

  /** Registers a session token for a user id (used to seed logged-in test accounts). */
  register(token: string, userId: string): void {
    this.tokens.set(token, userId);
  }

  issue(userId: string): string {
    const token = `sess_${userId}_${this.tokens.size + 1}`;
    this.tokens.set(token, userId);
    return token;
  }

  resolve(token: string | undefined): string | undefined {
    return token ? this.tokens.get(token) : undefined;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return undefined;
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

/** Reads the session token from the request (cookie first, then Authorization). */
export function tokenFromRequest(cookieHeader: string | undefined, authHeader: string | undefined): string | undefined {
  return readCookie(cookieHeader, SESSION_COOKIE) ?? bearer(authHeader);
}

interface AuthDeps {
  db: Database;
  sessions: SessionStore;
}

/** Populates `c.var.user` from the session on every request; unauthenticated requests get null. */
export function authMiddleware(deps: AuthDeps) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const token = tokenFromRequest(c.req.header("cookie"), c.req.header("authorization"));
    const userId = deps.sessions.resolve(token);
    const user: User | null = userId ? (deps.db.getUser(userId) ?? null) : null;
    c.set("user", user);
    await next();
  };
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
    const user = body.email ? deps.db.findUserByEmail(body.email) : undefined;
    // Demo credential check: every seeded account uses the shared password below.
    if (!user || body.password !== "lantern-dev") return c.json({ error: "invalid credentials" }, 401);
    const token = deps.sessions.issue(user.id);
    c.header("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return c.json({ token, user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName } });
  });

  app.post("/api/auth/logout", (c) => {
    const token = tokenFromRequest(c.req.header("cookie"), c.req.header("authorization"));
    if (token) deps.sessions.revoke(token);
    c.header("set-cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return c.json({ ok: true });
  });
}

/** Returns the current user or sends a 401; use at the top of a protected handler. */
export function requireUser(c: Context<AppEnv>): User | Response {
  const user = c.var.user;
  if (!user) return c.json({ error: "authentication required" }, 401);
  return user;
}
