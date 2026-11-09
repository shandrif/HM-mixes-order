// Order-day logic on top of the one-row-per-day storage (see db.ts).
import { anomalyKey, runChecks, type CellStat } from "../shared/checks";
import { cutoffInstant, openDayAt, parseCutoff, sheetNameFor } from "../shared/time";
import type { Anomaly, DayDetail, Layout, LineTuple, Settings } from "../shared/types";
import { audit, emptyData, getSheet, liveLayout, nowIso, openCounts, parseData, summary, updateSheet, type Config, type Decision, type Finding, type SheetData } from "./db";

export interface Ctx {
  db: D1Database;
  cfg: Config;
  open_day: string | null; // as stored in cfg (last rollover)
}

export const openDay = (s: Settings, now = Date.now()) => openDayAt(now, parseCutoff(s.cutoff), s.tz_offset_minutes);
export const cutoffAt = (s: Settings, day: string) => new Date(cutoffInstant(day, parseCutoff(s.cutoff), s.tz_offset_minutes)).toISOString();

/**
 * Make sure the open day exists and earlier open days are locked. Costs one
 * row read per request in the normal case (the open day is cached in cfg).
 */
export async function rollover(ctx: Ctx, now = Date.now()): Promise<{ locked: string[]; open: string }> {
  const od = openDay(ctx.cfg.settings, now);
  if (ctx.open_day === od) return { locked: [], open: od };
  const stale = (await ctx.db.prepare("SELECT day FROM sheets WHERE status = 'open' AND day < ? ORDER BY day").bind(od).all<{ day: string }>()).results;
  const locked: string[] = [];
  for (const { day } of stale) {
    if (await lockDay(ctx, day)) locked.push(day);
  }
  await ctx.db.batch([
    ctx.db.prepare("INSERT OR IGNORE INTO sheets (day, status, sheet_name) VALUES (?, 'open', ?)").bind(od, sheetNameFor(od, ctx.cfg.settings.sheet_name_format)),
    ctx.db.prepare("UPDATE cfg SET open_day = ? WHERE id = 1").bind(od),
  ]);
  ctx.open_day = od;
  return { locked, open: od };
}

/** Lock a day: copy the previous day for stores that did not send anything, freeze the layout, run checks. */
export async function lockDay(ctx: Ctx, day: string): Promise<boolean> {
  const prev = await ctx.db.prepare("SELECT data FROM sheets WHERE day < ? ORDER BY day DESC LIMIT 1").bind(day).first<{ data: string }>();
  const prevData = prev ? parseData(prev.data) : null;
  const layout = liveLayout(ctx.cfg);
  const inputIds = ctx.cfg.items.filter((i) => i.active && i.kind === "input").map((i) => String(i.id));
  const ts = nowIso();
  const done = await updateSheet<boolean>(ctx.db, day, (row, data) => {
    if (row.status !== "open") return null;
    for (const s of layout.stores) {
      const sid = String(s.id);
      if (data.sub[sid]) continue;
      const from = prevData?.q[sid];
      if (!from) continue;
      const mine = (data.q[sid] ??= {});
      let copied = false;
      for (const iid of inputIds) {
        if (iid in from && !(iid in mine)) {
          mine[iid] = from[iid];
          copied = true;
        }
      }
      if (copied || Object.keys(mine).length) data.sub[sid] = ["carried_forward", ts, 0];
    }
    return { data, set: { status: "locked", layout: JSON.stringify(layout), locked_at: ts }, result: true };
  });
  if (!done) return false;
  await checkDay(ctx, day);
  await audit(ctx.db, "system", "lock_day", { day });
  return true;
}

export function layoutOf(ctx: Ctx, row: { status: string; layout: string | null }): Layout {
  return row.status === "locked" && row.layout ? (JSON.parse(row.layout) as Layout) : liveLayout(ctx.cfg);
}

/** Run the automatic checks for a day and store the findings (reads ~30 rows). */
export async function checkDay(ctx: Ctx, day: string): Promise<void> {
  const row = await getSheet(ctx.db, day);
  if (!row) return;
  const layout = layoutOf(ctx, row);
  const data = parseData(row.data);
  const hist = Math.max(7, Math.min(90, ctx.cfg.settings.history_days));
  const past = (await ctx.db.prepare("SELECT day, data FROM sheets WHERE day < ? ORDER BY day DESC LIMIT ?").bind(day, hist).all<{ day: string; data: string }>()).results.map((r) => parseData(r.data));

  const stats = new Map<string, CellStat>();
  const itemTotals = new Map<string, number[]>();
  past.forEach((p, idx) => {
    const totals = new Map<string, number>();
    for (const [sid, items] of Object.entries(p.q)) {
      for (const [iid, q] of Object.entries(items)) {
        if (q === null || q === undefined) continue;
        const k = `${sid}:${iid}`;
        const st = stats.get(k) ?? { n: 0, avg: 0, max: 0, nonzero: 0 };
        st.avg = (st.avg * st.n + q) / (st.n + 1);
        st.n++;
        st.max = Math.max(st.max, q);
        if (q > 0) st.nonzero++;
        stats.set(k, st);
        if (idx < 14) totals.set(iid, (totals.get(iid) ?? 0) + q);
      }
    }
    if (idx < 14) for (const [iid, t] of totals) itemTotals.set(iid, [...(itemTotals.get(iid) ?? []), t]);
  });
  const itemDailyAvg = new Map<number, number>();
  for (const [iid, ts] of itemTotals) itemDailyAvg.set(Number(iid), ts.reduce((a, b) => a + b, 0) / ts.length);

  const carriedStreak = new Map<number, number>();
  for (const [sid, sub] of Object.entries(data.sub)) {
    if (sub[0] !== "carried_forward") continue;
    let n = 1;
    for (const p of past.slice(0, 6)) {
      if (p.sub[sid]?.[0] === "carried_forward") n++;
      else break;
    }
    carriedStreak.set(Number(sid), n);
  }

  const itemIds = new Set(layout.items.map((i) => String(i.id)));
  const cells = new Map<string, number | null>();
  for (const [sid, items] of Object.entries(data.q)) for (const [iid, q] of Object.entries(items)) if (itemIds.has(iid)) cells.set(`${sid}:${iid}`, q);

  const found: Finding[] = runChecks({
    items: layout.items,
    stores: layout.stores,
    cells,
    submitted: new Map(Object.entries(data.sub).map(([sid, s]) => [Number(sid), s[0]])),
    stats,
    itemDailyAvg,
    carriedStreak,
  }).map((a) => ({ ...a, key: anomalyKey(a) }));

  const foundJson = JSON.stringify(found);
  if (foundJson === row.found) return; // nothing changed: no write
  const decisions = JSON.parse(row.decisions) as Record<string, Decision>;
  const c = openCounts(found, JSON.parse(row.hist) as Finding[], decisions);
  await ctx.db.prepare("UPDATE sheets SET found = ?, n_crit = ?, n_warn = ?, n_info = ? WHERE day = ?").bind(foundJson, c.critical, c.warning, c.info, day).run();
}

/** Turn stored findings + decisions into the API's anomaly list. */
export function anomaliesOf(day: string, found: Finding[], hist: Finding[], decisions: Record<string, Decision>): Anomaly[] {
  return [...found.map((f) => ({ f, kind: "a" })), ...hist.map((f) => ({ f, kind: "h" }))].map(({ f, kind }) => {
    const d = decisions[f.key];
    return {
      id: `${day}~${kind}~${f.key}`,
      day,
      store_id: f.store_id,
      item_id: f.item_id,
      rule: f.rule,
      severity: f.severity,
      message: f.message,
      status: d && d.status !== "open" ? d.status : "open",
      note: d?.note ?? null,
      created_at: day,
      resolved_at: d && d.status !== "open" ? d.at : null,
      resolved_by: d && d.status !== "open" ? d.by : null,
    } as Anomaly;
  });
}

export async function dayDetail(ctx: Ctx, day: string): Promise<DayDetail | null> {
  const row = await getSheet(ctx.db, day);
  if (!row) return null;
  const data = parseData(row.data);
  const lines: LineTuple[] = [];
  for (const [sid, items] of Object.entries(data.q)) {
    const src = data.sub[sid]?.[0] ?? "imported";
    for (const [iid, q] of Object.entries(items)) {
      const cellSrc = data.cell[`${sid}:${iid}`] ?? (src === "carried_forward" ? "carried_forward" : src === "imported" ? "imported" : "entered");
      lines.push([Number(sid), Number(iid), q, cellSrc as LineTuple[3]]);
    }
  }
  const sev = { critical: 0, warning: 1, info: 2 };
  return {
    day,
    status: row.status,
    sheet_name: row.sheet_name ?? sheetNameFor(day, ctx.cfg.settings.sheet_name_format),
    cutoff_at: cutoffAt(ctx.cfg.settings, day),
    layout: layoutOf(ctx, row),
    lines,
    submissions: Object.entries(data.sub).map(([sid, s]) => [Number(sid), s[0], s[1]]),
    anomalies: anomaliesOf(day, JSON.parse(row.found), JSON.parse(row.hist), JSON.parse(row.decisions)).sort((a, b) => sev[a.severity] - sev[b.severity]),
    sent: row.emailed_at ? { at: row.emailed_at, by: row.emailed_by ?? null } : null,
  };
}

/** Update anomaly decisions for one day and refresh its open counters. */
export async function decide(ctx: Ctx, day: string, keys: string[], decision: Decision) {
  await updateSheet(ctx.db, day, (row) => {
    const decisions = JSON.parse(row.decisions) as Record<string, Decision>;
    for (const k of keys) {
      if (decision.status === "open") delete decisions[k];
      else decisions[k] = decision;
    }
    const c = openCounts(JSON.parse(row.found), JSON.parse(row.hist), decisions);
    return { set: { decisions: JSON.stringify(decisions), n_crit: c.critical, n_warn: c.warning, n_info: c.info } };
  });
}

export { emptyData, summary, type SheetData };
