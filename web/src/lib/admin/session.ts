/**
 * Admin panel sessions.
 *
 * A signed, expiring cookie rather than a stored session: there is one
 * operator and no user table, so anything more would be infrastructure without
 * a purpose. HMAC over an expiry timestamp gives a token that cannot be forged
 * without the secret and cannot be replayed after it lapses.
 *
 * Deliberately separate from the worker's ADMIN_TOKEN. This proves someone got
 * past the login; that one authorises moving money. One leaking must not
 * imply the other.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "autopilot_admin";

/** Eight hours: a working day, and short enough that a stolen laptop lapses. */
const TTL_MS = 8 * 60 * 60 * 1000;

const secret = (): string | null =>
  process.env.ADMIN_SESSION_SECRET?.trim() ||
  process.env.ADMIN_PANEL_PASSWORD?.trim() ||
  null;

const sign = (payload: string, key: string): string =>
  createHmac("sha256", key).update(payload).digest("base64url");

export function createSession(): string | null {
  const key = secret();
  if (!key) return null;
  const expiresAt = String(Date.now() + TTL_MS);
  return `${expiresAt}.${sign(expiresAt, key)}`;
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  const key = secret();
  if (!key || !token) return false;

  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature) return false;

  const expected = sign(expiresAt, key);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  return Number(expiresAt) > Date.now();
}

/**
 * Checks the login password.
 *
 * An unset password locks the panel rather than opening it. A deployment that
 * forgot to configure the secret must not be a deployment with no front door.
 */
export function checkPassword(input: string): boolean {
  const expected = process.env.ADMIN_PANEL_PASSWORD?.trim();
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
