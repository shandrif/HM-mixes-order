import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isValidQty } from "../shared/checks";
import { parseCutoff, sheetNameFor } from "../shared/time";
import type { Item, LineTuple, NewAnomaly, Store } from "../shared/types";
import { attemptAllowed, checkPassword, clearFailures, hashPassword, recordFailure, signSession, timingSafeEqual, verifySession, type Session } from "./auth";
import { activeItems, activeStores, audit, checkDay, cutoffAt, dayDetail, getLayout, insertAnomalies, liveLayout, loadSettings, nowIso, openDay, rollover, type Ctx } from "./data";
import { ensureSchema } from "./schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
}

type Vars = { ctx: Ctx; session: Session | null };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Server error: " + (err as Error).message }, 500);
});

// Every request: schema, settings, lazy rollover, session.
app.use("*", async (c, next) => {
  // State-changing requests must be JSON from our own page (blocks cross-site form posts).
  if (c.req.method !== "GET" && !c.req.header("content-type")?.includes("application/json")) fail(415, "JSON required");
  await ensureSchema(c.env.DB);
  const { settings, secret } = await loadSettings(c.env.DB);
  const ctx: Ctx = { db: c.env.DB, settings, secret };
  await rollover(ctx);
  c.set("ctx", ctx);
  const isAdminPath = c.req.path.startsWith("/api/admin");
  c.set("session", await verifySession(getCookie(c, isAdminPath ? "hm_admin" : "hm_store"), secret));
  await next();
  c.header("Cache-Control", "no-store");
});

const cookieOpts = (c: C, maxAge: number) => ({
  httpOnly: true,
  secure: new URL(c.req.url).protocol === "https:",
  sameSite: "Strict" as const,
  path: "/",
  maxAge,
});

async function body<T>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return fail(400, "Invalid JSON");
  }
}

const clientIp = (c: C) => c.req.header("cf-connecting-ip") ?? "local";

// ───────────────────────── Public / store ─────────────────────────

app.get("/public/info", async (c) => {
  const { db, settings } = c.var.ctx;
  const od = openDay(settings);
  const stores = await activeStores(db);
  return c.json({
    open_day: od,
    cutoff_at: cutoffAt(settings, od),
    server_now: nowIso(),
    require_pin: settings.require_pin,
    stores: stores.map((s) => ({ id: s.id, name: s.name, name_ar: s.name_ar, region: s.region })),
  });
});

app.post("/store/login", async (c) => {
  const { db, settings, secret } = c.var.ctx;
  const { store_id, pin } = await body<{ store_id: number; pin?: string }>(c);
  const store = await db.prepare("SELECT * FROM stores WHERE id = ? AND active = 1").bind(store_id).first<Store>();
  if (!store) fail(404, "Store not found");
  const key = `store:${store_id}:${clientIp(c)}`;
  if (settings.require_pin) {
    if (!(await attemptAllowed(db, key))) fail(429, "Too many wrong PINs. Try again in 15 minutes.");
    if (!store!.pin) fail(403, "This store has no PIN yet. Ask the admin to set one.");
    if (!timingSafeEqual(String(pin ?? "").trim(), store!.pin!)) {
      await recordFailure(db, key);
      fail(401, "Wrong PIN");
    }
    await clearFailures(db, key);
  }
  const ttl = 60 * 60 * 24 * 30;
  setCookie(c, "hm_store", await signSession({ kind: "store", sub: String(store_id), exp: Math.floor(Date.now() / 1000) + ttl }, secret), cookieOpts(c, ttl));
  return c.json({ ok: true });
});

app.post("/store/logout", (c) => {
  deleteCookie(c, "hm_store", { path: "/" });
  return c.json({ ok: true });
});

async function requireStore(c: C): Promise<Store> {
  const s = c.var.session;
  if (!s || s.kind !== "store") fail(401, "Not signed in");
  const store = await c.var.ctx.db.prepare("SELECT * FROM stores WHERE id = ? AND active = 1").bind(Number(s!.sub)).first<Store>();
  if (!store) fail(401, "Store no longer active");
  return store!;
}

app.get("/store/order", async (c) => {
  const store = await requireStore(c);
  const { db, settings } = c.var.ctx;
  const od = openDay(settings);
  const items = await activeItems(db);
  const [mine, sub, last] = await db.batch([
    db.prepare("SELECT item_id, qty, source FROM lines WHERE day = ? AND store_id = ?").bind(od, store.id),
    db.prepare("SELECT source, submitted_at FROM submissions WHERE day = ? AND store_id = ?").bind(od, store.id),
    db
      .prepare(
        `SELECT item_id, qty FROM lines WHERE store_id = ?1
         AND day = (SELECT MAX(day) FROM lines WHERE store_id = ?1 AND day < ?2)`,
      )
      .bind(store.id, od),
  ]);
  return c.json({
    store: { id: store.id, name: store.name, name_ar: store.name_ar },
    day: od,
    cutoff_at: cutoffAt(settings, od),
    server_now: nowIso(),
    items: items.map(({ id, name, name_ar, code, step, kind, source_item_id, factor }) => ({ id, name, name_ar, code, step, kind, source_item_id, factor })),
    lines: Object.fromEntries((mine.results as { item_id: number; qty: number | null }[]).map((r) => [r.item_id, r.qty])),
    last: Object.fromEntries((last.results as { item_id: number; qty: number | null }[]).map((r) => [r.item_id, r.qty])),
    submission: (sub.results[0] as { source: string; submitted_at: string } | undefined) ?? null,
  });
});

app.put("/store/order", async (c) => {
  const store = await requireStore(c);
  const { db, settings } = c.var.ctx;
  const { day, qty } = await body<{ day: string; qty: Record<string, number> }>(c);
  const od = openDay(settings);
  if (day !== od) fail(409, "The cutoff has passed — this order is closed. Reload to see the new order day.");
  const items = (await activeItems(db)).filter((i) => i.kind === "input");
  const ts = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const it of items) {
    const v = qty[String(it.id)];
    if (typeof v !== "number" || !isValidQty(v, it.step)) fail(400, `Enter a valid quantity for "${it.name}"`);
    stmts.push(
      db
        .prepare(
          `INSERT INTO lines (day, store_id, item_id, qty, source, updated_at, updated_by) VALUES (?, ?, ?, ?, 'entered', ?, ?)
           ON CONFLICT(day, store_id, item_id) DO UPDATE SET qty = excluded.qty, source = 'entered', updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(od, store.id, it.id, v, ts, `store:${store.id}`),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO submissions (day, store_id, source, submitted_at) VALUES (?, ?, 'entered', ?)
         ON CONFLICT(day, store_id) DO UPDATE SET source = 'entered', submitted_at = excluded.submitted_at`,
      )
      .bind(od, store.id, ts),
  );
  await db.batch(stmts);
  // Keep the admin's anomaly list live while stores are ordering.
  c.executionCtx.waitUntil(checkDay(c.var.ctx, od).catch((e) => console.error("checkDay", e)));
  return c.json({ ok: true, submitted_at: ts });
});

// ───────────────────────── Admin ─────────────────────────

app.post("/admin/login", async (c) => {
  const { db, secret } = c.var.ctx;
  const { email: rawEmail, password } = await body<{ email: string; password: string }>(c);
  const email = String(rawEmail ?? "").trim().toLowerCase();
  const key = `admin:${email}:${clientIp(c)}`;
  if (!(await attemptAllowed(db, key))) fail(429, "Too many attempts. Try again in 15 minutes.");

  let ok = false;
  const row = await db.prepare("SELECT pass_hash FROM admins WHERE email = ?").bind(email).first<{ pass_hash: string }>();
  if (row) ok = await checkPassword(String(password ?? ""), row.pass_hash);
  else {
    // Bootstrap admin from the Worker secrets ADMIN_EMAIL / ADMIN_PASSWORD.
    const envEmail = (c.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
    if (envEmail && c.env.ADMIN_PASSWORD && email === envEmail && timingSafeEqual(String(password ?? ""), c.env.ADMIN_PASSWORD)) {
      ok = true;
      await db.prepare("INSERT OR IGNORE INTO admins (email, pass_hash) VALUES (?, ?)").bind(email, await hashPassword(c.env.ADMIN_PASSWORD)).run();
    }
  }
  if (!ok) {
    await recordFailure(db, key);
    fail(401, "Wrong email or password");
  }
  await clearFailures(db, key);
  const ttl = 60 * 60 * 12;
  setCookie(c, "hm_admin", await signSession({ kind: "admin", sub: email, exp: Math.floor(Date.now() / 1000) + ttl }, secret), cookieOpts(c, ttl));
  return c.json({ ok: true, email });
});

app.post("/admin/logout", (c) => {
  deleteCookie(c, "hm_admin", { path: "/" });
  return c.json({ ok: true });
});

// Guard all other admin routes.
app.use("/admin/*", async (c, next) => {
  if (c.req.path === "/api/admin/login" || c.req.path === "/api/admin/logout") return next();
  const s = c.var.session;
  if (!s || s.kind !== "admin") fail(401, "Admin sign-in required");
  const exists = await c.var.ctx.db.prepare("SELECT 1 FROM admins WHERE email = ?").bind(s!.sub).first();
  if (!exists) fail(401, "Admin account removed");
  await next();
});

const actor = (c: C) => `admin:${c.var.session!.sub}`;

app.get("/admin/me", (c) => c.json({ email: c.var.session!.sub }));

app.get("/admin/overview", async (c) => {
  const { db, settings } = c.var.ctx;
  const od = openDay(settings);
  const [stores, subs, anomalies, days, lines] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM stores WHERE active = 1"),
    db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE day = ? AND source = 'entered'").bind(od),
    db.prepare("SELECT severity, COUNT(*) AS n FROM anomalies WHERE status = 'open' GROUP BY severity"),
    db.prepare("SELECT COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last FROM days"),
    db.prepare("SELECT EXISTS (SELECT 1 FROM lines) AS has"),
  ]);
  return c.json({
    open_day: od,
    cutoff_at: cutoffAt(settings, od),
    server_now: nowIso(),
    stores_active: (stores.results[0] as { n: number }).n,
    submitted_today: (subs.results[0] as { n: number }).n,
    anomalies: Object.fromEntries((anomalies.results as { severity: string; n: number }[]).map((r) => [r.severity, r.n])),
    days: days.results[0],
    has_orders: (lines.results[0] as { has: number }).has === 1,
  });
});

app.get("/admin/days", async (c) => {
  const { db, settings } = c.var.ctx;
  const { results } = await db
    .prepare(
      `SELECT d.day, d.status, d.sheet_name, d.locked_at,
         (SELECT COUNT(*) FROM submissions s WHERE s.day = d.day AND s.source = 'entered') AS entered,
         (SELECT COUNT(*) FROM submissions s WHERE s.day = d.day AND s.source = 'carried_forward') AS carried,
         (SELECT COUNT(*) FROM anomalies a WHERE a.day = d.day AND a.status = 'open' AND a.severity = 'critical') AS critical,
         (SELECT COUNT(*) FROM anomalies a WHERE a.day = d.day AND a.status = 'open' AND a.severity = 'warning') AS warning,
         (SELECT COUNT(*) FROM anomalies a WHERE a.day = d.day AND a.status = 'open' AND a.severity = 'info') AS info
       FROM days d ORDER BY d.day DESC`,
    )
    .all<{ day: string; sheet_name: string | null }>();
  return c.json(results.map((r) => ({ ...r, sheet_name: r.sheet_name ?? sheetNameFor(r.day, settings.sheet_name_format) })));
});

app.get("/admin/days/:day", async (c) => {
  const d = await dayDetail(c.var.ctx, c.req.param("day"));
  if (!d) fail(404, "Day not found");
  return c.json(d);
});

/** Admin cell edits. qty null on an input item = blank; on a derived item = back to the formula. */
app.put("/admin/days/:day/cells", async (c) => {
  const { db } = c.var.ctx;
  const day = c.req.param("day");
  const meta = await getLayout(c.var.ctx, day);
  if (!meta) fail(404, "Day not found");
  const { changes } = await body<{ changes: { store_id: number; item_id: number; qty: number | null }[] }>(c);
  const items = new Map(meta!.layout.items.map((i) => [i.id, i]));
  const stores = new Set(meta!.layout.stores.map((s) => s.id));
  const ts = nowIso();
  const who = actor(c);
  const upserts: [number, number, number | null][] = [];
  const clears: [number, number][] = [];
  for (const ch of changes ?? []) {
    const it = items.get(ch.item_id);
    if (!it || !stores.has(ch.store_id)) fail(400, "Cell is not part of this day's sheet");
    if (ch.qty !== null && (typeof ch.qty !== "number" || !Number.isFinite(ch.qty) || ch.qty < 0 || ch.qty > 99999)) fail(400, `Invalid quantity for ${it!.name}`);
    if (ch.qty === null && it!.kind === "derived") clears.push([ch.store_id, ch.item_id]);
    else upserts.push([ch.store_id, ch.item_id, ch.qty]);
  }
  const touched = JSON.stringify([...upserts.map(([s, i]) => [s, i]), ...clears]);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO lines (day, store_id, item_id, qty, source, updated_at, updated_by)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 'admin_edit', ?2, ?3
         FROM json_each(?4) WHERE true
         ON CONFLICT(day, store_id, item_id) DO UPDATE SET qty = excluded.qty, source = 'admin_edit', updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(day, ts, who, JSON.stringify(upserts)),
    db
      .prepare(
        `DELETE FROM lines WHERE day = ?1 AND EXISTS (SELECT 1 FROM json_each(?2) j
           WHERE json_extract(j.value, '$[0]') = lines.store_id AND json_extract(j.value, '$[1]') = lines.item_id)`,
      )
      .bind(day, JSON.stringify(clears)),
    // Edited cells close any findings imported from the original workbook for that cell.
    db
      .prepare(
        `UPDATE anomalies SET status = 'resolved', resolved_at = ?2, resolved_by = ?3
         WHERE day = ?1 AND status = 'open' AND rule LIKE 'hist_%' AND EXISTS (SELECT 1 FROM json_each(?4) j
           WHERE json_extract(j.value, '$[0]') = anomalies.store_id AND json_extract(j.value, '$[1]') = anomalies.item_id)`,
      )
      .bind(day, ts, who, touched),
  ];
  await db.batch(stmts);
  await audit(db, who, "edit_cells", { day, changes });
  await checkDay(c.var.ctx, day);
  return c.json(await dayDetail(c.var.ctx, day));
});

app.post("/admin/days/:day/check", async (c) => {
  await checkDay(c.var.ctx, c.req.param("day"));
  return c.json(await dayDetail(c.var.ctx, c.req.param("day")));
});

app.get("/admin/anomalies", async (c) => {
  const status = c.req.query("status") ?? "open";
  const { results } = await c.var.ctx.db
    .prepare(
      `SELECT a.*, s.name AS store_name, i.name AS item_name FROM anomalies a
       LEFT JOIN stores s ON s.id = a.store_id LEFT JOIN items i ON i.id = a.item_id
       WHERE (?1 = 'all' OR a.status = ?1)
       ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.day DESC, a.id
       LIMIT 2000`,
    )
    .bind(status)
    .all();
  return c.json(results);
});

app.post("/admin/anomalies/bulk", async (c) => {
  const { ids, status, note } = await body<{ ids: number[]; status: "open" | "resolved" | "ignored"; note?: string }>(c);
  if (!["open", "resolved", "ignored"].includes(status)) fail(400, "Bad status");
  const db = c.var.ctx.db;
  const ts = nowIso();
  const who = actor(c);
  await db
    .prepare("UPDATE anomalies SET status = ?1, note = COALESCE(?2, note), resolved_at = ?3, resolved_by = ?4 WHERE id IN (SELECT value FROM json_each(?5))")
    .bind(status, note ?? null, status === "open" ? null : ts, status === "open" ? null : who, JSON.stringify(ids ?? []))
    .run();
  await audit(db, who, "anomalies_" + status, { ids, note });
  return c.json({ ok: true });
});

// Stores & items
app.get("/admin/stores", async (c) => c.json((await c.var.ctx.db.prepare("SELECT * FROM stores ORDER BY active DESC, sort, id").all()).results));
app.get("/admin/items", async (c) => c.json((await c.var.ctx.db.prepare("SELECT * FROM items ORDER BY active DESC, sort, id").all()).results));

app.post("/admin/stores", async (c) => {
  const { db } = c.var.ctx;
  const s = await body<Partial<Store>>(c);
  if (!s.name?.trim()) fail(400, "Name is required");
  const max = await db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM stores").first<{ n: number }>();
  const pin = s.pin?.trim() || randomPin();
  const r = await db
    .prepare("INSERT INTO stores (name, name_ar, region, sort, active, pin) VALUES (?, ?, ?, ?, 1, ?) RETURNING *")
    .bind(s.name!.trim(), s.name_ar?.trim() || null, s.region?.trim() || null, s.sort ?? max!.n, pin)
    .first();
  await audit(db, actor(c), "add_store", r);
  return c.json(r);
});

app.put("/admin/stores/:id", async (c) => {
  const { db } = c.var.ctx;
  const s = await body<Partial<Store>>(c);
  if (s.pin != null && s.pin !== "" && !/^\d{4,8}$/.test(s.pin)) fail(400, "PIN must be 4–8 digits");
  const r = await db
    .prepare(
      `UPDATE stores SET name = COALESCE(?, name), name_ar = ?, region = ?, active = COALESCE(?, active), pin = COALESCE(?, pin)
       WHERE id = ? RETURNING *`,
    )
    .bind(s.name?.trim() || null, s.name_ar?.trim() || null, s.region?.trim() || null, s.active ?? null, s.pin || null, Number(c.req.param("id")))
    .first();
  if (!r) fail(404, "Store not found");
  await audit(db, actor(c), "update_store", r);
  return c.json(r);
});

app.post("/admin/stores/reorder", async (c) => {
  const { ids } = await body<{ ids: number[] }>(c);
  const db = c.var.ctx.db;
  await db
    .prepare("UPDATE stores SET sort = (SELECT key + 1 FROM json_each(?1) WHERE value = stores.id) WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .run();
  return c.json({ ok: true });
});

app.post("/admin/stores/generate-pins", async (c) => {
  const db = c.var.ctx.db;
  const { all } = await body<{ all?: boolean }>(c);
  const r = await db
    .prepare(`UPDATE stores SET pin = printf('%04d', abs(random()) % 10000) WHERE active = 1 ${all ? "" : "AND (pin IS NULL OR pin = '')"}`)
    .run();
  await audit(db, actor(c), "generate_pins", { count: r.meta.changes, all: !!all });
  return c.json({ updated: r.meta.changes });
});

function randomPin() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
}

function validateItem(it: Partial<Item>) {
  if (it.kind === "derived") {
    if (!it.source_item_id) fail(400, "A calculated item needs a source item");
    if (typeof it.factor !== "number" || !(it.factor >= 0)) fail(400, "A calculated item needs a multiplier");
  }
  if (it.step != null && !(it.step > 0)) fail(400, "Step must be greater than 0");
}

app.post("/admin/items", async (c) => {
  const { db } = c.var.ctx;
  const it = await body<Partial<Item>>(c);
  if (!it.name?.trim()) fail(400, "Name is required");
  validateItem(it);
  const max = await db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM items").first<{ n: number }>();
  const r = await db
    .prepare("INSERT INTO items (name, name_ar, code, step, sort, active, kind, source_item_id, factor) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING *")
    .bind(it.name!.trim(), it.name_ar?.trim() || null, it.code?.toString().trim() || null, it.step ?? 1, it.sort ?? max!.n, it.kind ?? "input", it.kind === "derived" ? it.source_item_id : null, it.kind === "derived" ? it.factor : null)
    .first();
  await audit(db, actor(c), "add_item", r);
  return c.json(r);
});

app.put("/admin/items/:id", async (c) => {
  const { db } = c.var.ctx;
  const it = await body<Partial<Item>>(c);
  validateItem(it);
  const id = Number(c.req.param("id"));
  if (it.kind === "derived" && it.source_item_id === id) fail(400, "An item cannot be calculated from itself");
  const r = await db
    .prepare(
      `UPDATE items SET name = COALESCE(?, name), name_ar = ?, code = ?, step = COALESCE(?, step), active = COALESCE(?, active),
         kind = COALESCE(?, kind), source_item_id = ?, factor = ?
       WHERE id = ? RETURNING *`,
    )
    .bind(it.name?.trim() || null, it.name_ar?.trim() || null, it.code?.toString().trim() || null, it.step ?? null, it.active ?? null, it.kind ?? null, it.kind === "derived" ? it.source_item_id : null, it.kind === "derived" ? it.factor : null, id)
    .first();
  if (!r) fail(404, "Item not found");
  await audit(db, actor(c), "update_item", r);
  return c.json(r);
});

app.post("/admin/items/reorder", async (c) => {
  const { ids } = await body<{ ids: number[] }>(c);
  const db = c.var.ctx.db;
  await db
    .prepare("UPDATE items SET sort = (SELECT key + 1 FROM json_each(?1) WHERE value = items.id) WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .run();
  return c.json({ ok: true });
});

// Settings
app.get("/admin/settings", (c) => c.json(c.var.ctx.settings));

app.put("/admin/settings", async (c) => {
  const s = await body<Record<string, unknown>>(c);
  const db = c.var.ctx.db;
  const allowed: Record<string, (v: unknown) => string> = {
    cutoff: (v) => {
      const str = String(v);
      if (!/^\d{1,2}:\d{2}$/.test(str) || parseCutoff(str) >= 24 * 60) fail(400, "Cutoff must look like 18:30");
      return str;
    },
    require_pin: (v) => (v ? "1" : "0"),
    total_label: (v) => String(v).slice(0, 80),
    sheet_name_format: (v) => String(v).slice(0, 31),
    history_days: (v) => String(Math.max(7, Math.min(90, Number(v) || 28))),
  };
  const stmts = Object.entries(s)
    .filter(([k]) => k in allowed)
    .map(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, allowed[k](v)));
  if (stmts.length) await db.batch(stmts);
  await audit(db, actor(c), "update_settings", s);
  return c.json((await loadSettings(db)).settings);
});

// Admin accounts
app.get("/admin/admins", async (c) => c.json((await c.var.ctx.db.prepare("SELECT email, created_at FROM admins ORDER BY created_at").all()).results));

app.post("/admin/admins", async (c) => {
  const { email, password } = await body<{ email: string; password: string }>(c);
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) fail(400, "Enter a valid email");
  if (String(password ?? "").length < 8) fail(400, "Password must be at least 8 characters");
  await c.var.ctx.db
    .prepare("INSERT INTO admins (email, pass_hash) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET pass_hash = excluded.pass_hash")
    .bind(e, await hashPassword(password))
    .run();
  await audit(c.var.ctx.db, actor(c), "set_admin", { email: e });
  return c.json({ ok: true });
});

app.delete("/admin/admins/:email", async (c) => {
  const e = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (e === c.var.session!.sub) fail(400, "You cannot remove yourself");
  await c.var.ctx.db.prepare("DELETE FROM admins WHERE email = ?").bind(e).run();
  await audit(c.var.ctx.db, actor(c), "remove_admin", { email: e });
  return c.json({ ok: true });
});

app.post("/admin/rollover", async (c) => c.json(await rollover(c.var.ctx)));

app.get("/admin/audit", async (c) => c.json((await c.var.ctx.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 300").all()).results));

/** Export: list of days with layouts; the browser then fetches each day and builds the .xlsx. */
app.get("/admin/export/days", async (c) => {
  const { results } = await c.var.ctx.db.prepare("SELECT day FROM days ORDER BY day").all<{ day: string }>();
  return c.json(results.map((r) => r.day));
});

// ───────────────────────── Import of the existing workbook ─────────────────────────

interface ImportBegin {
  replace: boolean;
  items: (Partial<Item> & { key: string; source_key?: string })[];
  stores: (Partial<Store> & { key: string })[];
}

app.post("/admin/import/begin", async (c) => {
  const { db } = c.var.ctx;
  const req = await body<ImportBegin>(c);
  const has = await db.prepare("SELECT COUNT(*) AS n FROM lines").first<{ n: number }>();
  if (has!.n > 0 && !req.replace) fail(409, "There is already order data. Tick “Replace existing data” to import again.");
  // Import always starts from a clean slate (stores, items and history come from the workbook).
  await db.batch(["lines", "submissions", "anomalies", "days", "stores", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  // One statement per table (the free plan allows 50 queries per request).
  const itemRows = req.items.map((it, i) => ({ sort: i + 1, name: it.name, code: it.code ?? null, step: it.step ?? 1, active: it.active ?? 1, kind: it.kind ?? "input", factor: it.factor ?? null }));
  const storeRows = req.stores.map((s, i) => ({ sort: i + 1, name: s.name, region: s.region ?? null, active: s.active ?? 1 }));
  const [, , itemsR, storesR] = await db.batch([
    db
      .prepare(
        `INSERT INTO items (name, code, step, sort, active, kind, factor)
         SELECT json_extract(value, '$.name'), json_extract(value, '$.code'), json_extract(value, '$.step'), json_extract(value, '$.sort'),
                json_extract(value, '$.active'), json_extract(value, '$.kind'), json_extract(value, '$.factor')
         FROM json_each(?1)`,
      )
      .bind(JSON.stringify(itemRows)),
    db
      .prepare(
        `INSERT INTO stores (name, region, sort, active, pin)
         SELECT json_extract(value, '$.name'), json_extract(value, '$.region'), json_extract(value, '$.sort'), json_extract(value, '$.active'),
                printf('%04d', abs(random()) % 10000)
         FROM json_each(?1)`,
      )
      .bind(JSON.stringify(storeRows)),
    db.prepare("SELECT id, sort FROM items"),
    db.prepare("SELECT id, sort FROM stores"),
  ]);
  const itemBySort = new Map((itemsR.results as { id: number; sort: number }[]).map((r) => [r.sort, r.id]));
  const storeBySort = new Map((storesR.results as { id: number; sort: number }[]).map((r) => [r.sort, r.id]));
  const itemIds: Record<string, number> = {};
  req.items.forEach((it, i) => (itemIds[it.key] = itemBySort.get(i + 1)!));
  const storeIds: Record<string, number> = {};
  req.stores.forEach((s, i) => (storeIds[s.key] = storeBySort.get(i + 1)!));
  const links = req.items
    .filter((it) => it.kind === "derived" && it.source_key && itemIds[it.source_key])
    .map((it) => [itemIds[it.key], itemIds[it.source_key!]]);
  if (links.length)
    await db
      .prepare("UPDATE items SET source_item_id = (SELECT json_extract(value, '$[1]') FROM json_each(?1) WHERE json_extract(value, '$[0]') = items.id) WHERE id IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))")
      .bind(JSON.stringify(links))
      .run();
  await audit(db, actor(c), "import_begin", { items: req.items.length, stores: req.stores.length, replace: req.replace });
  return c.json({ itemIds, storeIds });
});

app.post("/admin/import/day", async (c) => {
  const { db, settings } = c.var.ctx;
  const req = await body<{ day: string; sheet_name: string; layout: unknown; lines: LineTuple[]; anomalies: NewAnomaly[] }>(c);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.day)) fail(400, "Bad day");
  const od = openDay(settings);
  const status = req.day < od ? "locked" : "open";
  const ts = nowIso();
  await db.batch([
    db.prepare("DELETE FROM lines WHERE day = ?").bind(req.day),
    db.prepare("DELETE FROM submissions WHERE day = ?").bind(req.day),
    db.prepare("DELETE FROM anomalies WHERE day = ?").bind(req.day),
    db
      .prepare("INSERT INTO days (day, status, layout, sheet_name, locked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET status = excluded.status, layout = excluded.layout, sheet_name = excluded.sheet_name, locked_at = excluded.locked_at")
      .bind(req.day, status, status === "locked" ? JSON.stringify(req.layout) : null, req.sheet_name, status === "locked" ? ts : null),
    db
      .prepare(
        `INSERT INTO lines (day, store_id, item_id, qty, source, updated_at, updated_by)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 'imported', ?2, 'import'
         FROM json_each(?3)`,
      )
      .bind(req.day, ts, JSON.stringify(req.lines)),
    db
      .prepare(
        `INSERT OR IGNORE INTO submissions (day, store_id, source, submitted_at)
         SELECT DISTINCT ?1, json_extract(value, '$[0]'), 'imported', ?2 FROM json_each(?3)`,
      )
      .bind(req.day, ts, JSON.stringify(req.lines)),
  ]);
  await insertAnomalies(db, req.day, req.anomalies ?? []);
  return c.json({ ok: true });
});

app.post("/admin/import/finish", async (c) => {
  const ctx = c.var.ctx;
  const { recheck } = await body<{ recheck?: string[] }>(c);
  const r = await rollover(ctx);
  for (const d of (recheck ?? []).slice(-14)) await checkDay(ctx, d);
  await audit(ctx.db, actor(c), "import_finish", r);
  return c.json(r);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        const { settings, secret } = await loadSettings(env.DB);
        const r = await rollover({ db: env.DB, settings, secret });
        if (r.locked.length) console.log("Locked", r.locked, "open", r.open);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

export { liveLayout };
