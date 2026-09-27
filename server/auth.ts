import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { one, query } from "./db.js";
import { platform } from "./env.js";

export const COOKIE = "eedbe_session";
const SESSION_DAYS = 7;

function secret() {
  const s = platform.sessionSecret || (platform.isProduction ? "" : "development-session-secret");
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

export function validatePassword(p: unknown) {
  if (typeof p !== "string" || p.length < 10) throw new Error("Password must be at least 10 characters");
}
export function normalizeEmail(e: unknown) {
  const s = String(e ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error("Enter a valid email address");
  return s;
}

export async function startSession(c: Context, userId: string) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export function endSession(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export interface SessionUser { id: string; email: string; name: string }

export async function currentUser(c: Context): Promise<SessionUser | undefined> {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  try {
    const { payload } = await jwtVerify(token, secret());
    return await one<SessionUser>(`SELECT id, email, name FROM users WHERE id=$1`, [payload.sub]);
  } catch {
    return undefined;
  }
}

/** Too many failed logins for this email in 15 minutes? */
export async function loginLocked(email: string) {
  const r = await one<{ n: number }>(
    `SELECT count(*) AS n FROM login_attempts WHERE email=$1 AND NOT ok AND at > now() - interval '15 minutes'`, [email]);
  return (r?.n ?? 0) >= 10;
}
export async function recordLogin(email: string, ok: boolean) {
  await query(`INSERT INTO login_attempts (email, ok) VALUES ($1,$2)`, [email, ok]);
}

export type Role = "owner" | "admin" | "staff";
const RANK: Record<Role, number> = { staff: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** Requires a signed-in user; sets c.var.user. */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Please sign in" }, 401);
  c.set("user" as never, user as never);
  await next();
};

/** Requires membership of :orgId with at least `min` role; sets c.var.role. */
export function requireRole(min: Role): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user" as never) as SessionUser;
    const m = await one<{ role: Role }>(`SELECT role FROM memberships WHERE user_id=$1 AND org_id=$2`, [user.id, c.req.param("orgId")]);
    if (!m) return c.json({ error: "Workspace not found" }, 404);
    if (!atLeast(m.role, min)) return c.json({ error: "You don't have permission to do that" }, 403);
    c.set("role" as never, m.role as never);
    await next();
  };
}
