// Signed session tokens (HMAC-SHA256), password hashing (PBKDF2) and
// a simple attempt limiter, all on WebCrypto.

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface Session {
  kind: "admin" | "store";
  sub: string; // admin email or store id
  exp: number; // epoch seconds
}

export async function signSession(s: Session, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(s)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined, secret: string): Promise<Session | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    if (!s.exp || s.exp < Date.now() / 1000) return null;
    return s;
  } catch {
    return null;
  }
}

// Kept modest so a login stays within the free plan's CPU budget; logins are
// also rate limited below.
const ITER = 20_000;

export async function hashPassword(password: string, saltIn?: Uint8Array): Promise<string> {
  const salt = saltIn ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(bits)}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, , salt] = stored.split("$");
  if (!salt) return false;
  const again = await hashPassword(password, fromB64url(salt));
  return timingSafeEqual(again, stored);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const WINDOW = 15 * 60; // seconds
const MAX_ATTEMPTS = 8;

/** Returns false when `key` has failed too many times in the last 15 minutes. */
export async function attemptAllowed(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare("SELECT count, first_at FROM login_attempts WHERE key = ?").bind(key).first<{ count: number; first_at: number }>();
  if (!row) return true;
  if (row.first_at + WINDOW < Date.now() / 1000) return true;
  return row.count < MAX_ATTEMPTS;
}

export async function recordFailure(db: D1Database, key: string) {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO login_attempts (key, count, first_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN first_at + ${WINDOW} < ?2 THEN 1 ELSE count + 1 END,
         first_at = CASE WHEN first_at + ${WINDOW} < ?2 THEN ?2 ELSE first_at END`,
    )
    .bind(key, now)
    .run();
}

export async function clearFailures(db: D1Database, key: string) {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}
