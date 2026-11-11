import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isValidQty } from "../shared/checks";
import { parseCutoff, sheetNameFor } from "../shared/time";
import type { Item, Layout, LineTuple, NewAnomaly, Store } from "../shared/types";
import { checkPassword, hashPassword, signSession, timingSafeEqual, verifySession, type Session } from "./auth";
import {
  audit,
  emptyData,
  ensureSchema,
  getSheet,
  loadCfg,
  MAX_SENDS_PER_STORE_PER_DAY,
  nowIso,
  openCounts,
  parseData,
  summary,
  updateCfg,
  updateSheet,
  type Config,
  type Decision,
  type Finding,
} from "./db";
import { brevoEvents, buildOrderEmail, EMAIL_RE, emailConfigured, publicEmailSettings, sendBrevo } from "./email";
import { anomaliesOf, checkDay, cutoffAt, dayDetail, decide, layoutOf, openDay, rollover, type Ctx } from "./logic";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  /** Cloudflare rate limiter (free, no database writes). Optional. */
  LOGIN_LIMIT?: RateLimit;
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

// Every request: schema (once per instance), config (1 row), lazy rollover (0 rows normally), session.
app.use("*", async (c, next) => {
  // State-changing requests must be JSON from our own page (blocks cross-site form posts).
  if (c.req.method !== "GET" && !c.req.header("content-type")?.includes("application/json")) fail(415, "JSON required");
  await ensureSchema(c.env.DB);
  const { cfg, open_day } = await loadCfg(c.env.DB);
  const ctx: Ctx = { db: c.env.DB, cfg, open_day };
  await rollover(ctx);
  c.set("ctx", ctx);
  const isAdminPath = c.req.path.startsWith("/api/admin") || c.req.path === "/api/session/admin";
  c.set("session", await verifySession(getCookie(c, isAdminPath ? "hm_admin" : "hm_store"), cfg.secret));
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

async function rateLimit(c: C, key: string, message: string) {
  if (!c.env.LOGIN_LIMIT) return;
  const { success } = await c.env.LOGIN_LIMIT.limit({ key });
  if (!success) fail(429, message);
}

const activeStores = (cfg: Config) => cfg.stores.filter((s) => s.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
const activeItems = (cfg: Config) => cfg.items.filter((i) => i.active).sort((a, b) => a.sort - b.sort || a.id - b.id);

// ───────────────────────── Public / store ─────────────────────────

app.get("/public/info", (c) => {
  const { cfg } = c.var.ctx;
  const od = openDay(cfg.settings);
  return c.json({
    open_day: od,
    cutoff_at: cutoffAt(cfg.settings, od),
    server_now: nowIso(),
    require_pin: cfg.settings.require_pin,
    stores: activeStores(cfg).map((s) => ({ id: s.id, name: s.name, name_ar: s.name_ar, region: s.region })),
  });
});

/**
 * Read-only order sheet for the store link ("View order sheet").
 * which=open: the sheet stores are filling now; which=last: the latest locked
 * (reviewed) sheet. 2 rows read (config + one day).
 */
app.get("/public/sheet", async (c) => {
  const { db, cfg } = c.var.ctx;
  const od = openDay(cfg.settings);
  const which = c.req.query("which") === "last" ? "last" : "open";
  const row =
    which === "open"
      ? await db.prepare("SELECT day, status, layout, data, emailed_at FROM sheets WHERE day = ?").bind(od).first<{ day: string; status: "open" | "locked"; layout: string | null; data: string; emailed_at: string | null }>()
      : await db.prepare("SELECT day, status, layout, data, emailed_at FROM sheets WHERE status = 'locked' AND day < ? ORDER BY day DESC LIMIT 1").bind(od).first<{ day: string; status: "open" | "locked"; layout: string | null; data: string; emailed_at: string | null }>();
  if (!row) return c.json({ day: which === "open" ? od : null, status: which, items: [], stores: [], total_label: cfg.settings.total_label, cutoff_at: cutoffAt(cfg.settings, od), sent_at: null });
  const layout = layoutOf(c.var.ctx, row);
  const data = parseData(row.data);
  const value = (sid: number, it: Layout["items"][number]): number | null => {
    const q = data.q[sid]?.[it.id];
    if (it.kind === "derived" && (q === undefined || q === null)) return data.sub[sid] ? (data.q[sid]?.[it.source_item_id ?? -1] ?? 0) * (it.factor ?? 0) : null;
    return q ?? null;
  };
  const names = new Map(cfg.items.map((i) => [i.id, i.name_ar]));
  const snames = new Map(cfg.stores.map((s) => [s.id, s.name_ar]));
  return c.json({
    day: row.day,
    status: row.status,
    cutoff_at: cutoffAt(cfg.settings, row.day),
    sent_at: row.emailed_at,
    total_label: layout.total_label,
    items: layout.items.map((i) => ({ id: i.id, name: i.name, name_ar: names.get(i.id) ?? null, step: i.step })),
    stores: layout.stores.map((s) => ({
      id: s.id,
      name: s.name,
      name_ar: snames.get(s.id) ?? null,
      status: data.sub[s.id]?.[0] ?? null,
      at: data.sub[s.id]?.[1] ?? null,
      q: layout.items.map((it) => value(s.id, it)),
    })),
  });
});

app.post("/store/login", async (c) => {
  const { cfg } = c.var.ctx;
  const { store_id, pin } = await body<{ store_id: number; pin?: string }>(c);
  const store = cfg.stores.find((s) => s.id === Number(store_id) && s.active);
  if (!store) fail(404, "Store not found");
  if (cfg.settings.require_pin) {
    await rateLimit(c, `store:${store_id}:${clientIp(c)}`, "Too many attempts. Wait a minute and try again.");
    if (!store!.pin) fail(403, "This store has no PIN yet. Ask the admin to set one.");
    if (!timingSafeEqual(String(pin ?? "").trim(), store!.pin!)) fail(401, "Wrong PIN");
  }
  const ttl = 60 * 60 * 24 * 30;
  setCookie(c, "hm_store", await signSession({ kind: "store", sub: String(store!.id), exp: Math.floor(Date.now() / 1000) + ttl }, cfg.secret), cookieOpts(c, ttl));
  return c.json({ ok: true });
});

app.post("/store/logout", (c) => {
  deleteCookie(c, "hm_store", { path: "/" });
  return c.json({ ok: true });
});

function requireStore(c: C): Store {
  const s = c.var.session;
  if (!s || s.kind !== "store") fail(401, "Not signed in");
  const store = c.var.ctx.cfg.stores.find((x) => x.id === Number(s!.sub) && x.active);
  if (!store) fail(401, "Store no longer active");
  return store!;
}

app.get("/store/order", async (c) => {
  // ?probe=1: the store page asking "am I signed in?" — answer null instead of
  // a 401 so a normal first visit doesn't log a console error.
  if (c.req.query("probe")) {
    const s = c.var.session;
    if (!s || s.kind !== "store" || !c.var.ctx.cfg.stores.some((x) => x.id === Number(s.sub) && x.active)) return c.json(null);
  }
  const store = requireStore(c);
  const { db, cfg } = c.var.ctx;
  const od = openDay(cfg.settings);
  const sid = String(store.id);
  const [cur, prev] = await db.batch([
    db.prepare("SELECT data FROM sheets WHERE day = ?").bind(od),
    db.prepare("SELECT data FROM sheets WHERE day < ? ORDER BY day DESC LIMIT 1").bind(od),
  ]);
  const data = parseData((cur.results[0] as { data: string } | undefined)?.data);
  const last = parseData((prev.results[0] as { data: string } | undefined)?.data).q[sid] ?? {};
  const sub = data.sub[sid];
  return c.json({
    store: { id: store.id, name: store.name, name_ar: store.name_ar },
    day: od,
    cutoff_at: cutoffAt(cfg.settings, od),
    server_now: nowIso(),
    items: activeItems(cfg).map(({ id, name, name_ar, code, step, kind, source_item_id, factor, buttons_only }) => ({ id, name, name_ar, code, step, kind, source_item_id, factor, buttons_only })),
    lines: data.q[sid] ?? {},
    last,
    submission: sub ? { source: sub[0], submitted_at: sub[1] } : null,
  });
});

/**
 * A store sends its order: ONE atomic UPDATE of the day's row (1 row written),
 * capped at MAX_SENDS_PER_STORE_PER_DAY per store so writes stay bounded.
 */
app.put("/store/order", async (c) => {
  const store = requireStore(c);
  const ctx = c.var.ctx;
  const { day, qty } = await body<{ day: string; qty: Record<string, number> }>(c);
  const od = openDay(ctx.cfg.settings);
  if (day !== od) fail(409, "The cutoff has passed — this order is closed. Reload to see the new order day.");
  const items = activeItems(ctx.cfg).filter((i) => i.kind === "input");
  const mine: Record<string, number> = {};
  for (const it of items) {
    const v = qty?.[String(it.id)];
    if (typeof v !== "number" || !isValidQty(v, it.step)) fail(400, `Enter a valid quantity for "${it.name}"`);
    mine[it.id] = v;
  }
  const sid = Number(store.id); // integer, safe inside the JSON path below
  const P = (p: string) => `'$.${p}'`;
  const subPath = `sub."${sid}"`;
  const cellPaths = items.map((i) => P(`cell."${sid}:${i.id}"`)).join(", ");
  const ts = nowIso();
  const r = await ctx.db
    .prepare(
      `UPDATE sheets SET
         data = json_set(json_remove(data, ${cellPaths}),
                         ${P(`q."${sid}"`)}, json(?1),
                         ${P(subPath)}, json_array('entered', ?2, COALESCE(json_extract(data, ${P(subPath + "[2]")}), 0) + 1)),
         n_entered = n_entered + (CASE WHEN json_extract(data, ${P(subPath + "[0]")}) = 'entered' THEN 0 ELSE 1 END),
         n_carried = n_carried - (CASE WHEN json_extract(data, ${P(subPath + "[0]")}) = 'carried_forward' THEN 1 ELSE 0 END),
         rev = rev + 1
       WHERE day = ?3 AND status = 'open' AND COALESCE(json_extract(data, ${P(subPath + "[2]")}), 0) < ${MAX_SENDS_PER_STORE_PER_DAY}`,
    )
    .bind(JSON.stringify(mine), ts, od)
    .run();
  if (!r.meta.changes) {
    const row = await getSheet(ctx.db, od);
    if (!row || row.status !== "open") fail(409, "The cutoff has passed — this order is closed.");
    fail(429, "This order was changed too many times today. Ask the admin to update it.");
  }
  // Keep the admin's anomaly list live (reads ~30 rows, writes at most 1).
  c.executionCtx.waitUntil(checkDay(ctx, od).catch((e) => console.error("checkDay", e)));
  return c.json({ ok: true, submitted_at: ts });
});

// ───────────────────────── Admin ─────────────────────────

app.post("/admin/login", async (c) => {
  const { cfg } = c.var.ctx;
  const { email: rawEmail, password } = await body<{ email: string; password: string }>(c);
  const email = String(rawEmail ?? "").trim().toLowerCase();
  await rateLimit(c, `admin:${clientIp(c)}`, "Too many attempts. Wait a minute and try again.");
  let ok = false;
  const admin = cfg.admins.find((a) => a.email === email);
  if (admin) ok = await checkPassword(String(password ?? ""), admin.pass_hash);
  else {
    // Bootstrap admin from the optional Worker secrets ADMIN_EMAIL / ADMIN_PASSWORD.
    const envEmail = (c.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
    if (envEmail && c.env.ADMIN_PASSWORD && email === envEmail && timingSafeEqual(String(password ?? ""), c.env.ADMIN_PASSWORD)) {
      ok = true;
      const hash = await hashPassword(c.env.ADMIN_PASSWORD);
      await updateCfg(c.var.ctx.db, (k) => {
        if (!k.admins.some((a) => a.email === email)) k.admins.push({ email, pass_hash: hash, created_at: nowIso() });
      });
    }
  }
  if (!ok) fail(401, "Wrong email or password");
  const ttl = 60 * 60 * 12;
  setCookie(c, "hm_admin", await signSession({ kind: "admin", sub: email, exp: Math.floor(Date.now() / 1000) + ttl }, cfg.secret), cookieOpts(c, ttl));
  return c.json({ ok: true, email });
});

// First-run setup: while no admin exists (and no ADMIN_EMAIL secret is set),
// the first person to open /admin creates the admin account.
const needsSetup = (c: C) => !c.env.ADMIN_EMAIL && c.var.ctx.cfg.admins.length === 0;

app.get("/admin/setup", (c) => c.json({ needs_setup: needsSetup(c) }));

app.post("/admin/setup", async (c) => {
  if (!needsSetup(c)) fail(403, "Setup is already done. Please sign in.");
  const { email: rawEmail, password } = await body<{ email: string; password: string }>(c);
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, "Enter a valid email");
  if (String(password ?? "").length < 8) fail(400, "Password must be at least 8 characters");
  const hash = await hashPassword(password);
  const { result: created } = await updateCfg(c.var.ctx.db, (k) => {
    if (k.admins.length) return false;
    k.admins.push({ email, pass_hash: hash, created_at: nowIso() });
    return true;
  });
  if (!created) fail(403, "Setup is already done. Please sign in.");
  await audit(c.var.ctx.db, `admin:${email}`, "first_admin_setup", { email });
  const ttl = 60 * 60 * 12;
  setCookie(c, "hm_admin", await signSession({ kind: "admin", sub: email, exp: Math.floor(Date.now() / 1000) + ttl }, c.var.ctx.cfg.secret), cookieOpts(c, ttl));
  return c.json({ ok: true, email });
});

app.post("/admin/logout", (c) => {
  deleteCookie(c, "hm_admin", { path: "/" });
  return c.json({ ok: true });
});

// "Am I signed in as admin?" — null instead of a 401, so opening /admin
// signed out doesn't log a console error. (Outside the /admin/* guard.)
app.get("/session/admin", (c) => {
  const s = c.var.session;
  const ok = !!s && s.kind === "admin" && c.var.ctx.cfg.admins.some((a) => a.email === s.sub);
  return c.json(ok ? { email: s!.sub } : null);
});

// Guard all other admin routes.
app.use("/admin/*", async (c, next) => {
  if (["/api/admin/login", "/api/admin/logout", "/api/admin/setup"].includes(c.req.path)) return next();
  const s = c.var.session;
  if (!s || s.kind !== "admin") fail(401, "Admin sign-in required");
  if (!c.var.ctx.cfg.admins.some((a) => a.email === s!.sub)) fail(401, "Admin account removed");
  await next();
});

const actor = (c: C) => `admin:${c.var.session!.sub}`;

app.get("/admin/me", (c) => c.json({ email: c.var.session!.sub }));

app.get("/admin/overview", async (c) => {
  const { db, cfg } = c.var.ctx;
  const od = openDay(cfg.settings);
  const [cur, agg, last] = await db.batch([
    db.prepare("SELECT n_entered FROM sheets WHERE day = ?").bind(od),
    db.prepare("SELECT COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last, SUM(n_crit) AS critical, SUM(n_warn) AS warning, SUM(n_info) AS info, SUM(n_entered + n_carried) AS orders FROM sheets"),
    db.prepare("SELECT day, n_entered AS entered, n_carried AS carried, n_crit AS critical, n_warn AS warning, emailed_at AS sent_at FROM sheets WHERE status = 'locked' ORDER BY day DESC LIMIT 1"),
  ]);
  const a = agg.results[0] as { n: number; first: string | null; last: string | null; critical: number | null; warning: number | null; info: number | null; orders: number | null };
  const hasHistory = a.n > 1 || (a.orders ?? 0) > 0;
  return c.json({
    open_day: od,
    cutoff_at: cutoffAt(cfg.settings, od),
    server_now: nowIso(),
    stores_active: activeStores(cfg).length,
    submitted_today: (cur.results[0] as { n_entered: number } | undefined)?.n_entered ?? 0,
    anomalies: { critical: a.critical ?? 0, warning: a.warning ?? 0, info: a.info ?? 0 },
    days: { n: a.n, first: a.first, last: a.last },
    has_orders: hasHistory,
    last_locked: last.results[0] ?? null,
  });
});

app.get("/admin/days", async (c) => {
  const { db, cfg } = c.var.ctx;
  const { results } = await db
    .prepare("SELECT day, status, sheet_name, locked_at, n_entered AS entered, n_carried AS carried, n_crit AS critical, n_warn AS warning, n_info AS info FROM sheets ORDER BY day DESC")
    .all<{ day: string; sheet_name: string | null }>();
  return c.json(results.map((r) => ({ ...r, sheet_name: r.sheet_name ?? sheetNameFor(r.day, cfg.settings.sheet_name_format) })));
});

app.get("/admin/days/:day", async (c) => {
  const d = await dayDetail(c.var.ctx, c.req.param("day"));
  if (!d) fail(404, "Day not found");
  return c.json(d);
});

/** Admin cell edits. qty null on an input item = blank; on a calculated item = back to the formula. */
app.put("/admin/days/:day/cells", async (c) => {
  const ctx = c.var.ctx;
  const day = c.req.param("day");
  const detail = await dayDetail(ctx, day);
  if (!detail) fail(404, "Day not found");
  const { changes } = await body<{ changes: { store_id: number; item_id: number; qty: number | null }[] }>(c);
  const items = new Map(detail!.layout.items.map((i) => [i.id, i]));
  const stores = new Set(detail!.layout.stores.map((s) => s.id));
  for (const ch of changes ?? []) {
    const it = items.get(ch.item_id);
    if (!it || !stores.has(ch.store_id)) fail(400, "Cell is not part of this day's sheet");
    if (ch.qty !== null && (typeof ch.qty !== "number" || !Number.isFinite(ch.qty) || ch.qty < 0 || ch.qty > 99999)) fail(400, `Invalid quantity for ${it!.name}`);
  }
  const who = actor(c);
  const ts = nowIso();
  await updateSheet(ctx.db, day, (row, data) => {
    const decisions = JSON.parse(row.decisions) as Record<string, Decision>;
    const hist = JSON.parse(row.hist) as Finding[];
    for (const ch of changes ?? []) {
      const sid = String(ch.store_id);
      const iid = String(ch.item_id);
      const mine = (data.q[sid] ??= {});
      if (ch.qty === null && items.get(ch.item_id)!.kind === "derived") delete mine[iid];
      else mine[iid] = ch.qty;
      data.cell[`${sid}:${iid}`] = "admin_edit";
      // Edited cells close findings from the original workbook for that cell.
      for (const h of hist) if (h.store_id === ch.store_id && h.item_id === ch.item_id && !decisions[h.key]) decisions[h.key] = { status: "resolved", at: ts, by: who };
    }
    const cnt = openCounts(JSON.parse(row.found), hist, decisions);
    return { data, set: { decisions: JSON.stringify(decisions), n_crit: cnt.critical, n_warn: cnt.warning, n_info: cnt.info } };
  });
  await audit(ctx.db, who, "edit_cells", { day, changes });
  await checkDay(ctx, day);
  return c.json(await dayDetail(ctx, day));
});

app.post("/admin/days/:day/check", async (c) => {
  await checkDay(c.var.ctx, c.req.param("day"));
  return c.json(await dayDetail(c.var.ctx, c.req.param("day")));
});

app.get("/admin/anomalies", async (c) => {
  const { db, cfg } = c.var.ctx;
  const status = c.req.query("status") ?? "open";
  const where = status === "open" ? "n_crit + n_warn + n_info > 0" : status === "all" ? "found != '[]' OR hist != '[]'" : "decisions != '{}'";
  const { results } = await db.prepare(`SELECT day, found, hist, decisions FROM sheets WHERE ${where} ORDER BY day DESC`).all<{ day: string; found: string; hist: string; decisions: string }>();
  const storeName = new Map(cfg.stores.map((s) => [s.id, s.name]));
  const itemName = new Map(cfg.items.map((i) => [i.id, i.name]));
  const sev = { critical: 0, warning: 1, info: 2 };
  const list = results
    .flatMap((r) => anomaliesOf(r.day, JSON.parse(r.found), JSON.parse(r.hist), JSON.parse(r.decisions)))
    .filter((a) => status === "all" || a.status === status)
    .sort((a, b) => sev[a.severity] - sev[b.severity] || b.day.localeCompare(a.day))
    .slice(0, 2000)
    .map((a) => ({ ...a, store_name: a.store_id != null ? storeName.get(a.store_id) ?? null : null, item_name: a.item_id != null ? itemName.get(a.item_id) ?? null : null }));
  return c.json(list);
});

app.post("/admin/anomalies/bulk", async (c) => {
  const { ids, status, note } = await body<{ ids: string[]; status: "open" | "resolved" | "ignored"; note?: string }>(c);
  if (!["open", "resolved", "ignored"].includes(status)) fail(400, "Bad status");
  const byDay = new Map<string, string[]>();
  for (const id of ids ?? []) {
    const [day, , key] = String(id).split("~");
    if (!day || !key) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), key]);
  }
  const who = actor(c);
  for (const [day, keys] of byDay) await decide(c.var.ctx, day, keys, { status, note: note ?? null, at: nowIso(), by: who });
  await audit(c.var.ctx.db, who, "anomalies_" + status, { count: ids?.length ?? 0, note });
  return c.json({ ok: true });
});

// Stores & items (kept in the single config row)
const sortedForAdmin = <T extends { active: number; sort: number; id: number }>(l: T[]) => [...l].sort((a, b) => b.active - a.active || a.sort - b.sort || a.id - b.id);
app.get("/admin/stores", (c) => c.json(sortedForAdmin(c.var.ctx.cfg.stores)));
app.get("/admin/items", (c) => c.json(sortedForAdmin(c.var.ctx.cfg.items)));

function randomPin() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
}

app.post("/admin/stores", async (c) => {
  const s = await body<Partial<Store>>(c);
  if (!s.name?.trim()) fail(400, "Name is required");
  const { result } = await updateCfg(c.var.ctx.db, (k) => {
    const store: Store = {
      id: k.next_store_id++,
      name: s.name!.trim(),
      name_ar: s.name_ar?.trim() || null,
      region: s.region?.trim() || null,
      sort: Math.max(0, ...k.stores.map((x) => x.sort)) + 1,
      active: 1,
      pin: s.pin?.trim() || randomPin(),
    };
    k.stores.push(store);
    return store;
  });
  await audit(c.var.ctx.db, actor(c), "add_store", result);
  return c.json(result);
});

app.put("/admin/stores/:id", async (c) => {
  const s = await body<Partial<Store>>(c);
  if (s.pin != null && s.pin !== "" && !/^\d{4,8}$/.test(s.pin)) fail(400, "PIN must be 4–8 digits");
  const id = Number(c.req.param("id"));
  const { result } = await updateCfg(c.var.ctx.db, (k) => {
    const st = k.stores.find((x) => x.id === id);
    if (!st) return null;
    if (s.name?.trim()) st.name = s.name.trim();
    st.name_ar = s.name_ar?.trim() || null;
    st.region = s.region?.trim() || null;
    if (s.active != null) st.active = s.active ? 1 : 0;
    if (s.pin) st.pin = s.pin;
    return st;
  });
  if (!result) fail(404, "Store not found");
  await audit(c.var.ctx.db, actor(c), "update_store", result);
  return c.json(result);
});

app.post("/admin/stores/reorder", async (c) => {
  const { ids } = await body<{ ids: number[] }>(c);
  await updateCfg(c.var.ctx.db, (k) => ids.forEach((id, i) => {
    const s = k.stores.find((x) => x.id === id);
    if (s) s.sort = i + 1;
  }));
  return c.json({ ok: true });
});

app.post("/admin/stores/generate-pins", async (c) => {
  const { all } = await body<{ all?: boolean }>(c);
  const { result } = await updateCfg(c.var.ctx.db, (k) => {
    let n = 0;
    for (const s of k.stores) if (s.active && (all || !s.pin)) (s.pin = randomPin()), n++;
    return n;
  });
  await audit(c.var.ctx.db, actor(c), "generate_pins", { count: result, all: !!all });
  return c.json({ updated: result });
});

function validateItem(it: Partial<Item>, id?: number) {
  if (it.kind === "derived") {
    if (!it.source_item_id) fail(400, "A calculated item needs a source item");
    if (typeof it.factor !== "number" || !(it.factor >= 0)) fail(400, "A calculated item needs a multiplier");
    if (id != null && it.source_item_id === id) fail(400, "An item cannot be calculated from itself");
  }
  if (it.step != null && !(it.step > 0)) fail(400, "Step must be greater than 0");
}

app.post("/admin/items", async (c) => {
  const it = await body<Partial<Item>>(c);
  if (!it.name?.trim()) fail(400, "Name is required");
  validateItem(it);
  const { result } = await updateCfg(c.var.ctx.db, (k) => {
    const item: Item = {
      id: k.next_item_id++,
      name: it.name!.trim(),
      name_ar: it.name_ar?.trim() || null,
      code: it.code?.toString().trim() || null,
      step: it.step ?? 1,
      sort: Math.max(0, ...k.items.map((x) => x.sort)) + 1,
      active: 1,
      kind: it.kind ?? "input",
      source_item_id: it.kind === "derived" ? it.source_item_id ?? null : null,
      factor: it.kind === "derived" ? it.factor ?? null : null,
      buttons_only: it.buttons_only ? 1 : 0,
    };
    k.items.push(item);
    return item;
  });
  await audit(c.var.ctx.db, actor(c), "add_item", result);
  return c.json(result);
});

app.put("/admin/items/:id", async (c) => {
  const it = await body<Partial<Item>>(c);
  const id = Number(c.req.param("id"));
  validateItem(it, id);
  const { result } = await updateCfg(c.var.ctx.db, (k) => {
    const x = k.items.find((i) => i.id === id);
    if (!x) return null;
    if (it.name?.trim()) x.name = it.name.trim();
    x.name_ar = it.name_ar?.trim() || null;
    x.code = it.code?.toString().trim() || null;
    if (it.step != null) x.step = it.step;
    if (it.active != null) x.active = it.active ? 1 : 0;
    if (it.kind) x.kind = it.kind;
    x.source_item_id = x.kind === "derived" ? it.source_item_id ?? null : null;
    x.factor = x.kind === "derived" ? it.factor ?? null : null;
    if (it.buttons_only != null) x.buttons_only = it.buttons_only ? 1 : 0;
    return x;
  });
  if (!result) fail(404, "Item not found");
  await audit(c.var.ctx.db, actor(c), "update_item", result);
  return c.json(result);
});

app.post("/admin/items/reorder", async (c) => {
  const { ids } = await body<{ ids: number[] }>(c);
  await updateCfg(c.var.ctx.db, (k) => ids.forEach((id, i) => {
    const s = k.items.find((x) => x.id === id);
    if (s) s.sort = i + 1;
  }));
  return c.json({ ok: true });
});

// Settings
app.get("/admin/settings", (c) => c.json(c.var.ctx.cfg.settings));

app.put("/admin/settings", async (c) => {
  const s = await body<Record<string, unknown>>(c);
  if (s.cutoff != null) {
    const str = String(s.cutoff);
    if (!/^\d{1,2}:\d{2}$/.test(str) || parseCutoff(str) >= 24 * 60) fail(400, "Cutoff must look like 18:30");
  }
  const { cfg } = await updateCfg(c.var.ctx.db, (k) => {
    if (s.cutoff != null) k.settings.cutoff = String(s.cutoff);
    if (s.require_pin != null) k.settings.require_pin = !!s.require_pin;
    if (s.total_label != null) k.settings.total_label = String(s.total_label).slice(0, 80);
    if (s.sheet_name_format != null) k.settings.sheet_name_format = String(s.sheet_name_format).slice(0, 31);
    if (s.history_days != null) k.settings.history_days = Math.max(7, Math.min(90, Number(s.history_days) || 28));
  });
  await audit(c.var.ctx.db, actor(c), "update_settings", s);
  return c.json(cfg.settings);
});

// Admin accounts
app.get("/admin/admins", (c) => c.json(c.var.ctx.cfg.admins.map(({ email, created_at }) => ({ email, created_at }))));

app.post("/admin/admins", async (c) => {
  const { email, password } = await body<{ email: string; password: string }>(c);
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) fail(400, "Enter a valid email");
  if (String(password ?? "").length < 8) fail(400, "Password must be at least 8 characters");
  const hash = await hashPassword(password);
  await updateCfg(c.var.ctx.db, (k) => {
    const a = k.admins.find((x) => x.email === e);
    if (a) a.pass_hash = hash;
    else k.admins.push({ email: e, pass_hash: hash, created_at: nowIso() });
  });
  await audit(c.var.ctx.db, actor(c), "set_admin", { email: e });
  return c.json({ ok: true });
});

app.delete("/admin/admins/:email", async (c) => {
  const e = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (e === c.var.session!.sub) fail(400, "You cannot remove yourself");
  await updateCfg(c.var.ctx.db, (k) => {
    k.admins = k.admins.filter((a) => a.email !== e);
  });
  await audit(c.var.ctx.db, actor(c), "remove_admin", { email: e });
  return c.json({ ok: true });
});

// Order email (Brevo): settings, test, and send a reviewed day.
app.get("/admin/email", (c) => c.json(publicEmailSettings(c.var.ctx.cfg)));

const parseEmails = (v: string[] | string | undefined) => {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((x) => !EMAIL_RE.test(x));
  if (bad.length) fail(400, `Not a valid email: ${bad.join(", ")}`);
  if (list.length > 50) fail(400, "At most 50 recipients");
  return [...new Set(list)];
};

app.put("/admin/email", async (c) => {
  const b = await body<{ api_key?: string; sender_email?: string; sender_name?: string; recipients?: string[] | string }>(c);
  const key = b.api_key?.replace(/\s+/g, "") ?? "";
  if (key && key.startsWith("xsmtpsib-")) fail(400, "That is a Brevo SMTP key. Use an API key instead: Brevo → Settings → SMTP & API → API Keys tab → Generate a new API key (it starts with “xkeysib-”).");
  if (key && !key.startsWith("xkeysib-")) fail(400, "That doesn't look like a Brevo API key. It should start with “xkeysib-”. Copy it again from Brevo → Settings → SMTP & API → API Keys.");
  const recipients = parseEmails(b.recipients);
  const sender = String(b.sender_email ?? "").trim();
  if (sender && !EMAIL_RE.test(sender)) fail(400, "Sender email is not valid");
  const { cfg } = await updateCfg(c.var.ctx.db, (k) => {
    k.email = {
      api_key: key || (k.email?.api_key ?? ""),
      sender_email: sender,
      sender_name: String(b.sender_name ?? "HM Mixes Order").trim().slice(0, 60) || "HM Mixes Order",
      recipients,
      site_url: new URL(c.req.url).origin,
    };
  });
  await audit(c.var.ctx.db, actor(c), "update_email", { recipients: recipients.length });
  return c.json(publicEmailSettings(cfg));
});

/** Check the Brevo connection with a short email (no attachment). */
app.post("/admin/email/test", async (c) => {
  const e = c.var.ctx.cfg.email;
  if (!emailConfigured(e) || !e.recipients.length) fail(400, "Save the API key, sender email and recipients first.");
  let messageId: string | null = null;
  try {
    messageId = await sendBrevo(e!, {
      subject: "HM Mixes Order — test email",
      html: `<p style="font-family:Arial,sans-serif">Brevo is connected. Reviewed orders will be sent from <b>${e!.sender_email}</b> to these recipients.</p>`,
      to: e!.recipients,
    });
  } catch (err) {
    fail(502, (err as Error).message);
  }
  return c.json({ ok: true, recipients: e!.recipients, message_id: messageId, sender: e!.sender_email });
});

/** What Brevo did with recent emails from this app (delivered / bounced / blocked …). */
app.get("/admin/email/events", async (c) => {
  const e = c.var.ctx.cfg.email;
  if (!emailConfigured(e)) fail(400, "Save the API key and sender email first.");
  try {
    return c.json({ sender: e!.sender_email, events: await brevoEvents(e!) });
  } catch (err) {
    return fail(502, (err as Error).message);
  }
});

/**
 * Send a reviewed day to the factory & stores. The browser builds the branded
 * .xlsx and posts it here; the Worker only forwards it (2 rows read, 1 written).
 */
app.post("/admin/days/:day/send", async (c) => {
  const ctx = c.var.ctx;
  const day = c.req.param("day");
  const e = ctx.cfg.email;
  if (!emailConfigured(e)) fail(400, "Set up the Brevo email first (Settings → Order email).");
  const b = await body<{ recipients?: string[] | string; note?: string; filename?: string; file_base64?: string; allow_warnings?: boolean }>(c);
  const to = parseEmails(b.recipients);
  if (!to.length) fail(400, "Add at least one recipient.");
  const row = await ctx.db.prepare("SELECT status, n_crit, n_warn FROM sheets WHERE day = ?").bind(day).first<{ status: string; n_crit: number; n_warn: number }>();
  if (!row) fail(404, "Day not found");
  if (row!.status !== "locked") fail(409, "This day is still open for stores. Send it after the cutoff.");
  if (row!.n_crit > 0) fail(409, `Fix or ignore the ${row!.n_crit} critical issue(s) first.`);
  const filename = String(b.filename ?? "");
  if (!/^[\w.\- ]{1,120}\.xlsx$/.test(filename)) fail(400, "Bad file name");
  const file = String(b.file_base64 ?? "");
  if (!file || file.length > 8_000_000 || !/^[A-Za-z0-9+/=]+$/.test(file)) fail(400, "The Excel file is missing or too large");
  const who = c.var.session!.sub;
  const note = String(b.note ?? "").slice(0, 2000);
  const mail = await buildOrderEmail(ctx, day, note, who);
  try {
    await sendBrevo(e!, { ...mail!, to, attachments: [{ name: filename, content: file }] });
  } catch (err) {
    fail(502, (err as Error).message);
  }
  const at = nowIso();
  await ctx.db.prepare("UPDATE sheets SET emailed_at = ?, emailed_by = ? WHERE day = ?").bind(at, who, day).run();
  await audit(ctx.db, actor(c), "send_order", { day, to, note: note.slice(0, 200) });
  return c.json({ ok: true, sent: { at, by: who }, to });
});

app.post("/admin/rollover", async (c) => {
  c.var.ctx.open_day = null; // force a full check
  return c.json(await rollover(c.var.ctx));
});

app.get("/admin/audit", async (c) => c.json((await c.var.ctx.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 300").all()).results));

/** Export: list of days; the browser then fetches each day and builds the .xlsx. */
app.get("/admin/export/days", async (c) => {
  const { results } = await c.var.ctx.db.prepare("SELECT day FROM sheets ORDER BY day").all<{ day: string }>();
  return c.json(results.map((r) => r.day));
});

// ───────────────────────── Import of the existing workbook ─────────────────────────

interface ImportBegin {
  replace: boolean;
  items: (Partial<Item> & { key: string; source_key?: string })[];
  stores: (Partial<Store> & { key: string })[];
}

app.post("/admin/import/begin", async (c) => {
  const db = c.var.ctx.db;
  const req = await body<ImportBegin>(c);
  const has = await db.prepare("SELECT 1 FROM sheets WHERE n_entered + n_carried > 0 OR data != '{\"q\":{},\"sub\":{},\"cell\":{}}' LIMIT 1").first();
  if (has && !req.replace) fail(409, "There is already order data. Tick “Replace existing data” to import again.");
  // Import starts from a clean slate (stores, items and history come from the workbook).
  await db.batch([db.prepare("DELETE FROM sheets"), db.prepare("UPDATE cfg SET open_day = NULL WHERE id = 1")]);
  const { result } = await updateCfg(db, (k) => {
    const itemIds: Record<string, number> = {};
    const storeIds: Record<string, number> = {};
    k.items = req.items.map((it, i) => {
      const id = i + 1;
      itemIds[it.key] = id;
      return { id, name: it.name ?? "", name_ar: null, code: it.code ?? null, step: it.step ?? 1, sort: i + 1, active: it.active ?? 1, kind: it.kind ?? "input", source_item_id: null, factor: it.factor ?? null, buttons_only: it.buttons_only ? 1 : 0 };
    });
    for (const it of req.items) if (it.kind === "derived" && it.source_key && itemIds[it.source_key]) k.items.find((x) => x.id === itemIds[it.key])!.source_item_id = itemIds[it.source_key];
    k.stores = req.stores.map((s, i) => {
      const id = i + 1;
      storeIds[s.key] = id;
      return { id, name: s.name ?? "", name_ar: null, region: s.region ?? null, sort: i + 1, active: s.active ?? 1, pin: randomPin() };
    });
    k.next_item_id = k.items.length + 1;
    k.next_store_id = k.stores.length + 1;
    return { itemIds, storeIds };
  });
  await audit(db, actor(c), "import_begin", { items: req.items.length, stores: req.stores.length, replace: req.replace });
  return c.json(result);
});

app.post("/admin/import/day", async (c) => {
  const { db, cfg } = c.var.ctx;
  const req = await body<{ day: string; sheet_name: string; layout: Layout; lines: LineTuple[]; anomalies: NewAnomaly[] }>(c);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.day)) fail(400, "Bad day");
  const status = req.day < openDay(cfg.settings) ? "locked" : "open";
  const ts = nowIso();
  const data = emptyData();
  for (const [s, i, q] of req.lines ?? []) {
    (data.q[s] ??= {})[i] = q;
    data.sub[s] ??= ["imported", ts, 0];
  }
  const hist: Finding[] = (req.anomalies ?? []).map((a, i) => ({ ...a, key: `h${i}|${a.rule}|${a.store_id ?? ""}|${a.item_id ?? ""}` }));
  const cnt = openCounts([], hist, {});
  const s = summary(data);
  await db
    .prepare(
      `INSERT OR REPLACE INTO sheets (day, status, sheet_name, layout, data, found, hist, decisions, locked_at, rev, n_entered, n_carried, n_crit, n_warn, n_info)
       VALUES (?, ?, ?, ?, ?, '[]', ?, '{}', ?, 0, ?, ?, ?, ?, ?)`,
    )
    .bind(req.day, status, req.sheet_name, status === "locked" ? JSON.stringify(req.layout) : null, JSON.stringify(data), JSON.stringify(hist), status === "locked" ? ts : null, s.entered, s.carried, cnt.critical, cnt.warning, cnt.info)
    .run();
  return c.json({ ok: true });
});

app.post("/admin/import/finish", async (c) => {
  const ctx = c.var.ctx;
  ctx.open_day = null;
  const r = await rollover(ctx);
  await audit(ctx.db, actor(c), "import_finish", r);
  return c.json(r);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        const { cfg, open_day } = await loadCfg(env.DB);
        const ctx: Ctx = { db: env.DB, cfg, open_day };
        const r = await rollover(ctx);
        if (r.locked.length) console.log("Locked", r.locked, "open", r.open);

      })(),
    );
  },
} satisfies ExportedHandler<Env>;
