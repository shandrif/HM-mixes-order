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
  require_pin: "1",
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
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
