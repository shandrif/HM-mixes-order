// Database schema. Applied automatically (idempotently) the first time each
// Worker instance touches the database, so no manual migration step is needed.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     name_ar TEXT,
     region TEXT,
     sort INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     pin TEXT,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     name_ar TEXT,
     code TEXT,
     step REAL NOT NULL DEFAULT 1,
     sort INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     kind TEXT NOT NULL DEFAULT 'input',
     source_item_id INTEGER,
     factor REAL,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS days (
     day TEXT PRIMARY KEY,
     status TEXT NOT NULL DEFAULT 'open',
     layout TEXT,
     sheet_name TEXT,
     locked_at TEXT,
     checked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS lines (
     day TEXT NOT NULL,
     store_id INTEGER NOT NULL,
     item_id INTEGER NOT NULL,
     qty REAL,
     source TEXT NOT NULL DEFAULT 'entered',
     updated_at TEXT,
     updated_by TEXT,
     PRIMARY KEY (day, store_id, item_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS lines_store_item ON lines (store_id, item_id, day)`,
  `CREATE TABLE IF NOT EXISTS submissions (
     day TEXT NOT NULL,
     store_id INTEGER NOT NULL,
     source TEXT NOT NULL,
     submitted_at TEXT NOT NULL,
     PRIMARY KEY (day, store_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS anomalies (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     day TEXT NOT NULL,
     store_id INTEGER,
     item_id INTEGER,
     rule TEXT NOT NULL,
     severity TEXT NOT NULL,
     message TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     note TEXT,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     resolved_at TEXT,
     resolved_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS anomalies_status ON anomalies (status, severity)`,
  `CREATE INDEX IF NOT EXISTS anomalies_day ON anomalies (day)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS admins (
     email TEXT PRIMARY KEY,
     pass_hash TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL,
     first_at INTEGER NOT NULL)`,
];

const DEFAULT_SETTINGS: Record<string, string> = {
  cutoff: "18:30",
  tz_offset_minutes: "180",
  require_pin: "0",
  total_label: "Total Riyadh Production",
  sheet_name_format: "MMM- DD",
  history_days: "28",
};

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.batch(STATEMENTS.map((s) => db.prepare(s)));
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const hex = [...secret].map((b) => b.toString(16).padStart(2, "0")).join("");
      await db.batch([
        ...Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
          db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(k, v),
        ),
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").bind(hex),
      ]);
      // One-time switch: store PINs are off by default (stores just pick their branch).
      // Admins can turn them back on under Settings.
      const migr = await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migr_pin_default_off', '1')").run();
      if (migr.meta.changes) await db.prepare("UPDATE settings SET value = '0' WHERE key = 'require_pin'").run();
      // One-time: sheets are now dated by delivery day. Remove empty open sheets
      // created under the old rule so they are not locked and copied forward.
      const migr2 = await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migr_delivery_day', '1')").run();
      if (migr2.meta.changes)
        await db.prepare("DELETE FROM days WHERE status = 'open' AND NOT EXISTS (SELECT 1 FROM lines l WHERE l.day = days.day)").run();
      // One-time: calculated items (Cookie/Pecan = Vanilla × factor) become items the
      // stores type themselves. Past days keep the values they showed.
      const migr3 = await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migr_no_formulas', '1')").run();
      if (migr3.meta.changes) {
        await db.batch([
          db.prepare(
            `INSERT OR IGNORE INTO lines (day, store_id, item_id, qty, source, updated_at, updated_by)
             SELECT src.day, src.store_id, i.id, src.qty * i.factor, 'imported', CURRENT_TIMESTAMP, 'system'
             FROM items i JOIN lines src ON src.item_id = i.source_item_id
             JOIN days d ON d.day = src.day AND d.status = 'locked'
             WHERE i.kind = 'derived' AND src.qty IS NOT NULL`,
          ),
          db.prepare("UPDATE items SET step = CASE WHEN factor > 0 THEN factor ELSE 1 END, code = NULL WHERE kind = 'derived'"),
          db.prepare("UPDATE items SET kind = 'input', source_item_id = NULL, factor = NULL WHERE kind = 'derived'"),
          db.prepare(`UPDATE days SET layout = replace(layout, '"kind":"derived"', '"kind":"input"') WHERE layout IS NOT NULL`),
          db.prepare("UPDATE anomalies SET status = 'resolved', resolved_by = 'system', resolved_at = CURRENT_TIMESTAMP WHERE status = 'open' AND rule IN ('derived_override', 'hist_hardcoded')"),
        ]);
      }
      // One-time: "+ / − only" items (no typing). On by default for the gram toppings.
      const migr4 = await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migr_buttons_only', '1')").run();
      if (migr4.meta.changes) {
        const cols = (await db.prepare("PRAGMA table_info(items)").all<{ name: string }>()).results;
        if (!cols.some((c) => c.name === "buttons_only")) await db.prepare("ALTER TABLE items ADD COLUMN buttons_only INTEGER NOT NULL DEFAULT 0").run();
        await db.prepare("UPDATE items SET buttons_only = 1 WHERE name LIKE 'Cookie Topping%' OR name LIKE 'Pecan Topping%'").run();
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
