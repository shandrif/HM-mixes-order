// Anomaly rules for a single day. Pure functions so they can be unit-tested and
// run by the Worker after each cutoff or edit.
import type { Item, NewAnomaly } from "./types";

export interface CellStat {
  n: number; // days of history with a value
  avg: number;
  max: number;
  nonzero: number; // days with qty > 0
}

export interface CheckInput {
  items: Pick<Item, "id" | "name" | "kind" | "step" | "source_item_id" | "factor">[];
  stores: { id: number; name: string }[];
  /** qty per `${store}:${item}` for this day (null = blank). Derived items only present when overridden. */
  cells: Map<string, number | null>;
  submitted: Map<number, string>; // store_id -> submission source
  stats: Map<string, CellStat>; // `${store}:${item}` over recent history
  itemDailyAvg: Map<number, number>; // item_id -> average daily total over recent history
  carriedStreak: Map<number, number>; // store_id -> consecutive days carried forward ending today
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function isValidQty(q: number, step: number): boolean {
  if (!Number.isFinite(q) || q < 0 || q > 9999) return false;
  const s = step > 0 ? step : 1;
  return Math.abs(q / s - Math.round(q / s)) < 1e-9;
}

export function runChecks(input: CheckInput): NewAnomaly[] {
  const out: NewAnomaly[] = [];
  const inputs = input.items.filter((i) => i.kind === "input");
  const totals = new Map<number, number>();

  for (const s of input.stores) {
    const src = input.submitted.get(s.id);
    if (src === "carried_forward") {
      out.push({ store_id: s.id, item_id: null, rule: "carried_forward", severity: "info", message: `${s.name} did not submit before the cutoff — previous day's order was copied.` });
      const streak = input.carriedStreak.get(s.id) ?? 1;
      if (streak >= 3)
        out.push({ store_id: s.id, item_id: null, rule: "carried_streak", severity: "warning", message: `${s.name} has not submitted for ${streak} days in a row.` });
    }

    for (const it of inputs) {
      const key = `${s.id}:${it.id}`;
      const has = input.cells.has(key);
      const q = input.cells.get(key);
      const st = input.stats.get(key);

      if (q === null || q === undefined) {
        if (src && has && st && st.n >= 5 && st.avg >= 1)
          out.push({ store_id: s.id, item_id: it.id, rule: "blank", severity: "info", message: `${s.name}: "${it.name}" is empty (usually ~${fmt(st.avg)}).` });
        continue;
      }
      totals.set(it.id, (totals.get(it.id) ?? 0) + q);

      if (!isValidQty(q, it.step)) {
        out.push({ store_id: s.id, item_id: it.id, rule: "invalid_value", severity: "critical", message: `${s.name}: "${it.name}" = ${q} is not a valid quantity (step ${it.step}).` });
        continue;
      }
      if (!st || st.n < 5) continue;
      if (q > Math.max(st.max * 1.5, st.avg * 3) && q - st.avg >= 3) {
        out.push({ store_id: s.id, item_id: it.id, rule: "spike", severity: "critical", message: `${s.name}: "${it.name}" = ${fmt(q)}, usually ~${fmt(st.avg)} (max ${fmt(st.max)}). Possible typo.` });
      } else if (q === 0 && st.n >= 7 && st.nonzero / st.n >= 0.9 && st.avg >= 2) {
        out.push({ store_id: s.id, item_id: it.id, rule: "unusual_zero", severity: "info", message: `${s.name}: "${it.name}" = 0, but this store orders ~${fmt(st.avg)} almost every day.` });
      }
    }

    for (const it of input.items.filter((i) => i.kind === "derived")) {
      const key = `${s.id}:${it.id}`;
      const q = input.cells.get(key);
      if (q === undefined) continue;
      const srcQ = it.source_item_id != null ? input.cells.get(`${s.id}:${it.source_item_id}`) ?? 0 : 0;
      const formula = (srcQ ?? 0) * (it.factor ?? 0);
      if (q !== formula)
        out.push({ store_id: s.id, item_id: it.id, rule: "derived_override", severity: "warning", message: `${s.name}: "${it.name}" is typed as ${q ?? "blank"} but the formula gives ${fmt(formula)}.` });
    }
  }

  for (const it of inputs) {
    const avg = input.itemDailyAvg.get(it.id);
    const t = totals.get(it.id) ?? 0;
    if (avg && avg >= 5 && t > avg * 1.6)
      out.push({ store_id: null, item_id: it.id, rule: "item_total_spike", severity: "warning", message: `Total "${it.name}" = ${fmt(t)}, recent daily average ~${fmt(avg)}.` });
  }
  return out;
}

export const anomalyKey = (a: { rule: string; store_id: number | null; item_id: number | null }) =>
  `${a.rule}|${a.store_id ?? ""}|${a.item_id ?? ""}`;
