// Storage designed so the free D1 limits (5M rows read, 100k rows written per
// day) cannot be reached:
//
//   cfg     ONE row: settings, stores, items, admins (+ the current open day).
//   sheets  ONE row per day: every store's quantities for that day as JSON,
//           the anomaly findings, admin decisions and small summary counters.
//
// D1 bills rows, not bytes, so a store request touches ~3 rows and an anomaly
// check ~30 (one per past day). See README "Free-plan limits".
import type { Item, Layout, NewAnomaly, Settings, Store } from "../shared/types";

export interface Admin {
  email: string;
  pass_hash: string;
  created_at: string;
}

export interface Config {
  settings: Settings;
  secret: string;
  stores: Store[];
  items: Item[];
  admins: Admin[];
  next_store_id: number;
  next_item_id: number;
  email?: EmailSettings;
}

/** Order email via Brevo (https://www.brevo.com). Sent by an admin after review. */
export interface EmailSettings {
  api_key: string; // never sent to the browser
  sender_email: string; // must be a verified sender in Brevo
  sender_name: string;
  recipients: string[]; // default recipients (editable per send)
  site_url: string; // for links in the email (taken from the admin's browser)
}

/** Quantities for one day. */
export interface SheetData {
  q: Record<string, Record<string, number | null>>; // store -> item -> qty (null = blank)
  sub: Record<string, [string, string, number]>; // store -> [source, at, times sent]
  cell: Record<string, string>; // "store:item" -> source for single cells (admin_edit)
}

export interface Decision {
  status: "resolved" | "ignored" | "open";
  note?: string | null;
  at: string;
  by: string;
}

export interface SheetRow {
  day: string;
  status: "open" | "locked";
  sheet_name: string | null;
  layout: string | null;
  data: string;
  found: string; // NewAnomaly[] from the automatic checks
  hist: string; // NewAnomaly[] found in the original workbook
  decisions: string; // key -> Decision
  locked_at: string | null;
  rev: number;
  emailed_at?: string | null;
  emailed_by?: string | null;
}

export type Finding = NewAnomaly & { key: string };

export const MAX_SENDS_PER_STORE_PER_DAY = 300;

export const DEFAULT_SETTINGS: Settings = {
  cutoff: "18:30",
  tz_offset_minutes: 180,
  require_pin: false,
  total_label: "Total Riyadh Production",
  sheet_name_format: "MMM- DD",
  history_days: 28,
};

export const emptyData = (): SheetData => ({ q: {}, sub: {}, cell: {} });
export const nowIso = () => new Date().toISOString();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cfg (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     json TEXT NOT NULL,
     v INTEGER NOT NULL DEFAULT 0,
     open_day TEXT)`,
  `CREATE TABLE IF NOT EXISTS sheets (
     day TEXT PRIMARY KEY,
     status TEXT NOT NULL DEFAULT 'open',
     sheet_name TEXT,
     layout TEXT,
     data TEXT NOT NULL DEFAULT '{"q":{},"sub":{},"cell":{}}',
     found TEXT NOT NULL DEFAULT '[]',
     hist TEXT NOT NULL DEFAULT '[]',
     decisions TEXT NOT NULL DEFAULT '{}',
     locked_at TEXT,
     emailed_at TEXT,
     emailed_by TEXT,
     rev INTEGER NOT NULL DEFAULT 0,
     n_entered INTEGER NOT NULL DEFAULT 0,
     n_carried INTEGER NOT NULL DEFAULT 0,
     n_crit INTEGER NOT NULL DEFAULT 0,
     n_warn INTEGER NOT NULL DEFAULT 0,
     n_info INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT)`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.batch(SCHEMA.map((s) => db.prepare(s)));
      const cols = (await db.prepare("PRAGMA table_info(sheets)").all<{ name: string }>()).results;
      if (!cols.some((c) => c.name === "emailed_at")) await db.prepare("ALTER TABLE sheets ADD COLUMN emailed_at TEXT").run();
      if (!cols.some((c) => c.name === "emailed_by")) await db.prepare("ALTER TABLE sheets ADD COLUMN emailed_by TEXT").run();
      const has = await db.prepare("SELECT 1 FROM cfg WHERE id = 1").first();
      if (!has) {
        const migrated = await migrateFromRowsPerLine(db);
        if (!migrated) {
          const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
          const cfg: Config = { settings: DEFAULT_SETTINGS, secret, stores: [], items: [], admins: [], next_store_id: 1, next_item_id: 1 };
          await db.prepare("INSERT OR IGNORE INTO cfg (id, json, v) VALUES (1, ?, 0)").bind(JSON.stringify(cfg)).run();
        }
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// ───────────── config ─────────────

export async function loadCfg(db: D1Database): Promise<{ cfg: Config; v: number; open_day: string | null }> {
  const r = await db.prepare("SELECT json, v, open_day FROM cfg WHERE id = 1").first<{ json: string; v: number; open_day: string | null }>();
  if (!r) throw new Error("Configuration missing");
  const cfg = JSON.parse(r.json) as Config;
  cfg.settings = { ...DEFAULT_SETTINGS, ...cfg.settings };
  return { cfg, v: r.v, open_day: r.open_day };
}

/** Optimistic update of the config row; retries when another admin saved in between. */
export async function updateCfg<T>(db: D1Database, fn: (cfg: Config) => T): Promise<{ cfg: Config; result: T }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { cfg, v } = await loadCfg(db);
    const result = fn(cfg);
    const r = await db.prepare("UPDATE cfg SET json = ?, v = v + 1 WHERE id = 1 AND v = ?").bind(JSON.stringify(cfg), v).run();
    if (r.meta.changes) return { cfg, result };
  }
  throw new Error("The settings were changed by someone else at the same time. Please try again.");
}

// ───────────── sheets ─────────────

export async function getSheet(db: D1Database, day: string): Promise<SheetRow | null> {
  return db.prepare("SELECT day, status, sheet_name, layout, data, found, hist, decisions, locked_at, rev, emailed_at, emailed_by FROM sheets WHERE day = ?").bind(day).first<SheetRow>();
}

export function parseData(s: string | null | undefined): SheetData {
  const d = s ? (JSON.parse(s) as Partial<SheetData>) : {};
  return { q: d.q ?? {}, sub: d.sub ?? {}, cell: d.cell ?? {} };
}

export function summary(data: SheetData) {
  let entered = 0;
  let carried = 0;
  for (const [src] of Object.values(data.sub)) {
    if (src === "entered") entered++;
    else if (src === "carried_forward") carried++;
  }
  return { entered, carried };
}

export function openCounts(found: Finding[], hist: Finding[], decisions: Record<string, Decision>) {
  const c = { critical: 0, warning: 0, info: 0 };
  for (const f of [...found, ...hist]) {
    const d = decisions[f.key];
    if (!d || d.status === "open") c[f.severity]++;
  }
  return c;
}

/** Optimistic read-modify-write of one sheet row (guarded by `rev`). */
export async function updateSheet<T>(db: D1Database, day: string, fn: (row: SheetRow, data: SheetData) => { data?: SheetData; set?: Record<string, unknown>; result?: T } | null): Promise<T | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await getSheet(db, day);
    if (!row) return undefined;
    const data = parseData(row.data);
    const out = fn(row, data);
    if (!out) return undefined;
    const sets: string[] = ["rev = rev + 1"];
    const vals: unknown[] = [];
    if (out.data) {
      const s = summary(out.data);
      sets.push("data = ?", "n_entered = ?", "n_carried = ?");
      vals.push(JSON.stringify(out.data), s.entered, s.carried);
    }
    for (const [k, v] of Object.entries(out.set ?? {})) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    const r = await db.prepare(`UPDATE sheets SET ${sets.join(", ")} WHERE day = ? AND rev = ?`).bind(...vals, day, row.rev).run();
    if (r.meta.changes) return out.result;
  }
  throw new Error("This sheet was changed at the same time. Please try again.");
}

export function liveLayout(cfg: Config): Layout {
  return {
    items: cfg.items
      .filter((i) => i.active)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map(({ id, name, code, kind, source_item_id, factor, step }) => ({ id, name, code, kind, source_item_id, factor, step })),
    stores: cfg.stores
      .filter((s) => s.active)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map(({ id, name }) => ({ id, name })),
    total_label: cfg.settings.total_label,
  };
}

export async function audit(db: D1Database, actor: string, action: string, detail: unknown) {
  await db.prepare("INSERT INTO audit (actor, action, detail) VALUES (?, ?, ?)").bind(actor, action, JSON.stringify(detail).slice(0, 4000)).run();
}

// ───────────── one-time migration from the earlier one-row-per-line schema ─────────────

async function migrateFromRowsPerLine(db: D1Database): Promise<boolean> {
  const old = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'stores', 'items', 'days', 'lines')").all<{ name: string }>();
  const names = new Set(old.results.map((r) => r.name));
  if (!names.has("settings") || !names.has("stores") || !names.has("items")) return false;

  const settingsRows = (await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()).results;
  const m = new Map(settingsRows.map((r) => [r.key, r.value]));
  const stores = (await db.prepare("SELECT * FROM stores").all<Store>()).results;
  const items = (await db.prepare("SELECT * FROM items").all<Item & { buttons_only?: number }>()).results.map((i) => ({ ...i, buttons_only: i.buttons_only ?? 0 }));
  const admins = (await db.prepare("SELECT email, pass_hash, created_at FROM admins").all<Admin>().catch(() => ({ results: [] as Admin[] }))).results;
  const cfg: Config = {
    settings: {
      cutoff: m.get("cutoff") ?? DEFAULT_SETTINGS.cutoff,
      tz_offset_minutes: Number(m.get("tz_offset_minutes") ?? 180),
      require_pin: (m.get("require_pin") ?? "0") === "1",
      total_label: m.get("total_label") ?? DEFAULT_SETTINGS.total_label,
      sheet_name_format: m.get("sheet_name_format") ?? DEFAULT_SETTINGS.sheet_name_format,
      history_days: Number(m.get("history_days") ?? 28),
    },
    secret: m.get("session_secret") ?? [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""),
    stores,
    items,
    admins,
    next_store_id: Math.max(0, ...stores.map((s) => s.id)) + 1,
    next_item_id: Math.max(0, ...items.map((i) => i.id)) + 1,
  };

  if (names.has("days") && names.has("lines")) {
    const days = (await db.prepare("SELECT day, status, layout, sheet_name, locked_at FROM days ORDER BY day").all<{ day: string; status: "open" | "locked"; layout: string | null; sheet_name: string | null; locked_at: string | null }>()).results;
    for (const d of days) {
      const [lines, subs, anoms] = await db.batch([
        db.prepare("SELECT store_id, item_id, qty, source FROM lines WHERE day = ?").bind(d.day),
        db.prepare("SELECT store_id, source, submitted_at FROM submissions WHERE day = ?").bind(d.day),
        db.prepare("SELECT store_id, item_id, rule, severity, message, status, note, resolved_at, resolved_by FROM anomalies WHERE day = ? AND rule LIKE 'hist_%'").bind(d.day),
      ]);
      const data = emptyData();
      for (const l of lines.results as { store_id: number; item_id: number; qty: number | null; source: string }[]) {
        (data.q[l.store_id] ??= {})[l.item_id] = l.qty;
        if (l.source === "admin_edit") data.cell[`${l.store_id}:${l.item_id}`] = "admin_edit";
      }
      for (const s of subs.results as { store_id: number; source: string; submitted_at: string }[]) data.sub[s.store_id] = [s.source, s.submitted_at, 1];
      const hist: Finding[] = [];
      const decisions: Record<string, Decision> = {};
      (anoms.results as (NewAnomaly & { status: string; note: string | null; resolved_at: string | null; resolved_by: string | null })[]).forEach((a, i) => {
        const key = `h${i}|${a.rule}|${a.store_id ?? ""}|${a.item_id ?? ""}`;
        hist.push({ key, store_id: a.store_id, item_id: a.item_id, rule: a.rule, severity: a.severity, message: a.message });
        if (a.status !== "open") decisions[key] = { status: a.status as Decision["status"], note: a.note, at: a.resolved_at ?? nowIso(), by: a.resolved_by ?? "migration" };
      });
      const s = summary(data);
      const c = openCounts([], hist, decisions);
      await db
        .prepare(
          `INSERT OR REPLACE INTO sheets (day, status, sheet_name, layout, data, found, hist, decisions, locked_at, rev, n_entered, n_carried, n_crit, n_warn, n_info)
           VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .bind(d.day, d.status, d.sheet_name, d.layout, JSON.stringify(data), JSON.stringify(hist), JSON.stringify(decisions), d.locked_at, s.entered, s.carried, c.critical, c.warning, c.info)
        .run();
    }
  }
  await db.prepare("INSERT OR IGNORE INTO cfg (id, json, v) VALUES (1, ?, 0)").bind(JSON.stringify(cfg)).run();
  // Old tables are no longer used; dropping them frees space (one-time).
  await db.batch(
    ["lines", "submissions", "anomalies", "days", "stores", "items", "settings", "admins", "login_attempts", "stats_cells", "stats_items"].map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)),
  );
  return true;
}
