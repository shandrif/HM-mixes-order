// Core data operations: settings, layouts, the cutoff rollover and anomaly runs.
import { anomalyKey, runChecks, type CellStat } from "../shared/checks";
import { addDays, cutoffInstant, openDayAt, parseCutoff, sheetNameFor } from "../shared/time";
import type { Anomaly, DayDetail, Item, Layout, LineTuple, NewAnomaly, Settings, Store } from "../shared/types";

export const nowIso = () => new Date().toISOString();

export interface Ctx {
  db: D1Database;
  settings: Settings;
  secret: string;
}

export async function loadSettings(db: D1Database): Promise<{ settings: Settings; secret: string }> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  return {
    secret: m.get("session_secret") ?? "",
    settings: {
      cutoff: m.get("cutoff") ?? "18:30",
      tz_offset_minutes: Number(m.get("tz_offset_minutes") ?? 180),
      require_pin: (m.get("require_pin") ?? "1") === "1",
      total_label: m.get("total_label") ?? "Total Riyadh Production",
      sheet_name_format: m.get("sheet_name_format") ?? "MMM- DD",
      history_days: Number(m.get("history_days") ?? 28),
    },
  };
}

export function openDay(s: Settings, now = Date.now()) {
  return openDayAt(now, parseCutoff(s.cutoff), s.tz_offset_minutes);
}

export function cutoffAt(s: Settings, day: string) {
  return new Date(cutoffInstant(day, parseCutoff(s.cutoff), s.tz_offset_minutes)).toISOString();
}

export async function activeItems(db: D1Database): Promise<Item[]> {
  return (await db.prepare("SELECT * FROM items WHERE active = 1 ORDER BY sort, id").all<Item>()).results;
}

export async function activeStores(db: D1Database): Promise<Store[]> {
  return (await db.prepare("SELECT * FROM stores WHERE active = 1 ORDER BY sort, id").all<Store>()).results;
}

export async function liveLayout(ctx: Ctx): Promise<Layout> {
  const [items, stores] = await Promise.all([activeItems(ctx.db), activeStores(ctx.db)]);
  return {
    items: items.map(({ id, name, code, kind, source_item_id, factor, step }) => ({ id, name, code, kind, source_item_id, factor, step })),
    stores: stores.map(({ id, name }) => ({ id, name })),
    total_label: ctx.settings.total_label,
  };
}

export async function audit(db: D1Database, actor: string, action: string, detail: unknown) {
  await db.prepare("INSERT INTO audit (actor, action, detail) VALUES (?, ?, ?)").bind(actor, action, JSON.stringify(detail)).run();
}

export async function getLayout(ctx: Ctx, day: string): Promise<{ layout: Layout; status: "open" | "locked"; sheet_name: string | null } | null> {
  const row = await ctx.db.prepare("SELECT status, layout, sheet_name FROM days WHERE day = ?").bind(day).first<{ status: "open" | "locked"; layout: string | null; sheet_name: string | null }>();
  if (!row) return null;
  const layout = row.status === "locked" && row.layout ? (JSON.parse(row.layout) as Layout) : await liveLayout(ctx);
  return { layout, status: row.status, sheet_name: row.sheet_name };
}

export async function dayDetail(ctx: Ctx, day: string): Promise<DayDetail | null> {
  const meta = await getLayout(ctx, day);
  if (!meta) return null;
  const [lines, subs, anomalies] = await ctx.db.batch([
    ctx.db.prepare("SELECT store_id, item_id, qty, source FROM lines WHERE day = ?").bind(day),
    ctx.db.prepare("SELECT store_id, source, submitted_at FROM submissions WHERE day = ?").bind(day),
    ctx.db.prepare("SELECT * FROM anomalies WHERE day = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id").bind(day),
  ]);
  return {
    day,
    status: meta.status,
    sheet_name: meta.sheet_name ?? sheetNameFor(day, ctx.settings.sheet_name_format),
    cutoff_at: cutoffAt(ctx.settings, day),
    layout: meta.layout,
    lines: (lines.results as { store_id: number; item_id: number; qty: number | null; source: LineTuple[3] }[]).map((r) => [r.store_id, r.item_id, r.qty, r.source]),
    submissions: (subs.results as { store_id: number; source: string; submitted_at: string }[]).map((r) => [r.store_id, r.source, r.submitted_at]),
    anomalies: anomalies.results as Anomaly[],
  };
}

/**
 * Make sure the currently open day exists and every earlier open day is locked.
 * Idempotent; called by the cron trigger and lazily by API requests, so it is
 * correct even if a cron run is late or skipped.
 */
export async function rollover(ctx: Ctx, now = Date.now()): Promise<{ locked: string[]; open: string }> {
  const od = openDay(ctx.settings, now);
  const stale = (await ctx.db.prepare("SELECT day FROM days WHERE status = 'open' AND day < ? ORDER BY day").bind(od).all<{ day: string }>()).results;
  const locked: string[] = [];
  for (const { day } of stale) {
    await lockDay(ctx, day);
    locked.push(day);
  }
  await ctx.db
    .prepare("INSERT OR IGNORE INTO days (day, status, sheet_name) VALUES (?, 'open', ?)")
    .bind(od, sheetNameFor(od, ctx.settings.sheet_name_format))
    .run();
  return { locked, open: od };
}

/** Lock a day: copy the previous day's order for stores that did not submit, freeze the layout, run checks. */
export async function lockDay(ctx: Ctx, day: string) {
  const db = ctx.db;
  const ts = nowIso();
  const prev = await db.prepare("SELECT day FROM days WHERE day < ? ORDER BY day DESC LIMIT 1").bind(day).first<{ day: string }>();
  const layout = await liveLayout(ctx);
  const stmts: D1PreparedStatement[] = [];
  if (prev) {
    // Copy yesterday's input quantities for active stores with no submission today.
    // INSERT OR IGNORE keeps any cell an admin already filled in for that store.
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO lines (day, store_id, item_id, qty, source, updated_at, updated_by)
           SELECT ?1, l.store_id, l.item_id, l.qty, 'carried_forward', ?3, 'system'
           FROM lines l
           JOIN stores s ON s.id = l.store_id AND s.active = 1
           JOIN items i ON i.id = l.item_id AND i.active = 1 AND i.kind = 'input'
           WHERE l.day = ?2
             AND l.store_id NOT IN (SELECT store_id FROM submissions WHERE day = ?1)`,
        )
        .bind(day, prev.day, ts),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO submissions (day, store_id, source, submitted_at)
         SELECT ?1, s.id, 'carried_forward', ?2 FROM stores s
         WHERE s.active = 1 AND EXISTS (SELECT 1 FROM lines l WHERE l.day = ?1 AND l.store_id = s.id)`,
      )
      .bind(day, ts),
    db.prepare("UPDATE days SET status = 'locked', layout = ?, locked_at = ? WHERE day = ?").bind(JSON.stringify(layout), ts, day),
  );
  await db.batch(stmts);
  await checkDay(ctx, day);
  await audit(db, "system", "lock_day", { day });
}

const AUTO_RULES = ["invalid_value", "spike", "unusual_zero", "blank", "carried_forward", "carried_streak", "derived_override", "item_total_spike"];

/** Re-run the automatic checks for a day, keeping ignored findings ignored and auto-resolving fixed ones. */
export async function checkDay(ctx: Ctx, day: string): Promise<void> {
  const db = ctx.db;
  const meta = await getLayout(ctx, day);
  if (!meta) return;
  const hist = Math.max(7, Math.min(90, ctx.settings.history_days));
  const [linesR, subsR, statsR, totalsR, streakR, existingR] = await db.batch([
    db.prepare("SELECT store_id, item_id, qty FROM lines WHERE day = ?").bind(day),
    db.prepare("SELECT store_id, source FROM submissions WHERE day = ?").bind(day),
    db
      .prepare(
        `SELECT store_id, item_id, COUNT(*) AS n, AVG(qty) AS avg, MAX(qty) AS max, SUM(qty > 0) AS nonzero
         FROM lines
         WHERE qty IS NOT NULL AND day IN (SELECT day FROM days WHERE day < ?1 ORDER BY day DESC LIMIT ?2)
         GROUP BY store_id, item_id`,
      )
      .bind(day, hist),
    db
      .prepare(
        `SELECT item_id, AVG(t) AS avg FROM (
           SELECT day, item_id, SUM(qty) AS t FROM lines
           WHERE day IN (SELECT day FROM days WHERE day < ?1 ORDER BY day DESC LIMIT 14)
           GROUP BY day, item_id)
         GROUP BY item_id`,
      )
      .bind(day),
    db
      .prepare(
        `SELECT store_id, COUNT(*) AS n FROM submissions
         WHERE source = 'carried_forward' AND day IN (SELECT day FROM days WHERE day <= ?1 ORDER BY day DESC LIMIT 7)
         GROUP BY store_id`,
      )
      .bind(day),
    db.prepare(`SELECT * FROM anomalies WHERE day = ? AND rule IN (${AUTO_RULES.map(() => "?").join(",")})`).bind(day, ...AUTO_RULES),
  ]);

  // Consecutive carried-forward streak: count only if each of the last N days was carried.
  const recentDays = (await db.prepare("SELECT day FROM days WHERE day <= ? ORDER BY day DESC LIMIT 7").bind(day).all<{ day: string }>()).results.map((r) => r.day);
  const carriedRows = (await db
    .prepare(`SELECT day, store_id FROM submissions WHERE source = 'carried_forward' AND day IN (${recentDays.map(() => "?").join(",") || "''"})`)
    .bind(...recentDays)
    .all<{ day: string; store_id: number }>()).results;
  const carriedSet = new Set(carriedRows.map((r) => `${r.day}:${r.store_id}`));
  const carriedStreak = new Map<number, number>();
  for (const r of streakR.results as { store_id: number }[]) {
    let n = 0;
    for (const d of recentDays) {
      if (carriedSet.has(`${d}:${r.store_id}`)) n++;
      else break;
    }
    carriedStreak.set(r.store_id, n);
  }

  const itemsById = new Map(meta.layout.items.map((i) => [i.id, i]));
  const cells = new Map<string, number | null>();
  for (const r of linesR.results as { store_id: number; item_id: number; qty: number | null }[]) {
    if (itemsById.has(r.item_id)) cells.set(`${r.store_id}:${r.item_id}`, r.qty);
  }
  const stats = new Map<string, CellStat>();
  for (const r of statsR.results as (CellStat & { store_id: number; item_id: number })[]) stats.set(`${r.store_id}:${r.item_id}`, r);

  const found = runChecks({
    items: meta.layout.items,
    stores: meta.layout.stores,
    cells,
    submitted: new Map((subsR.results as { store_id: number; source: string }[]).map((r) => [r.store_id, r.source])),
    stats,
    itemDailyAvg: new Map((totalsR.results as { item_id: number; avg: number }[]).map((r) => [r.item_id, r.avg])),
    carriedStreak,
  });

  const existing = existingR.results as Anomaly[];
  const byKey = new Map(existing.map((a) => [anomalyKey(a), a]));
  const foundKeys = new Set(found.map(anomalyKey));
  const ts = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const a of found) {
    const prev = byKey.get(anomalyKey(a));
    if (!prev) {
      stmts.push(
        db.prepare("INSERT INTO anomalies (day, store_id, item_id, rule, severity, message) VALUES (?, ?, ?, ?, ?, ?)").bind(day, a.store_id, a.item_id, a.rule, a.severity, a.message),
      );
    } else if (prev.status === "resolved") {
      stmts.push(db.prepare("UPDATE anomalies SET status = 'open', message = ?, severity = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?").bind(a.message, a.severity, prev.id));
    } else {
      stmts.push(db.prepare("UPDATE anomalies SET message = ?, severity = ? WHERE id = ?").bind(a.message, a.severity, prev.id));
    }
  }
  for (const a of existing) {
    if (a.status === "open" && !foundKeys.has(anomalyKey(a)))
      stmts.push(db.prepare("UPDATE anomalies SET status = 'resolved', resolved_at = ?, resolved_by = 'auto' WHERE id = ?").bind(ts, a.id));
  }
  stmts.push(db.prepare("UPDATE days SET checked_at = ? WHERE day = ?").bind(ts, day));
  await db.batch(stmts);
}

export async function insertAnomalies(db: D1Database, day: string, list: NewAnomaly[]) {
  if (!list.length) return;
  await db
    .prepare(
      `INSERT INTO anomalies (day, store_id, item_id, rule, severity, message)
       SELECT ?1, json_extract(value, '$.store_id'), json_extract(value, '$.item_id'), json_extract(value, '$.rule'),
              json_extract(value, '$.severity'), json_extract(value, '$.message')
       FROM json_each(?2)`,
    )
    .bind(day, JSON.stringify(list))
    .run();
}

export { addDays };
