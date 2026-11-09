// Reads the existing Mixes Orders workbook (every sheet, hidden or not),
// works out the items/stores and finds problems in the history.
import type ExcelJS from "exceljs";
import type { NewAnomaly, Severity } from "../../shared/types";

export interface ParsedItem {
  key: string;
  name: string;
  code: string | null;
  step: number;
  buttons_only: number;
  kind: "input" | "derived";
  factor: number | null;
  source_key: string | null;
  active: number;
}

export interface ParsedAnomaly {
  storeName: string | null; // raw store name
  itemKey: string | null;
  rule: string;
  severity: Severity;
  message: string;
}

export interface ParsedDay {
  day: string;
  sheet_name: string;
  itemKeys: string[];
  /** Raw store names in sheet order. */
  storeNames: string[];
  /** [rawStoreName, itemKey, qty] — derived items only when the cell was typed over and differs from the formula. */
  cells: [string, string, number | null][];
  anomalies: ParsedAnomaly[];
}

export interface ParsedWorkbook {
  items: ParsedItem[];
  /** Store names from the latest sheet, in order — these become the store list. */
  canonicalStores: string[];
  /** Every raw store name seen (trimmed), with the last day it appeared. */
  allStoreNames: Map<string, string>;
  days: ParsedDay[];
  totalLabel: string;
  skippedSheets: { name: string; reason: string; day?: string; conflictWith?: string }[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export const normKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\d+/g, (d) => String(Number(d)))
    .replace(/[^a-z0-9؀-ۿ]/g, "");

const isoDay = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function dateFromSheetName(name: string, year: number): string | null {
  const m = /^([A-Za-z]{3})[a-z]*[\s-]*(\d{1,2})/.exec(name.trim());
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  return mon ? isoDay(year, mon, Number(m[2])) : null;
}

function cellNumber(cell: ExcelJS.Cell): { value: number | null; text: string | null; formula: string | null } {
  const v = cell.value as ExcelJS.CellValue;
  const formula = cell.formula ? String(cell.formula) : null;
  if (v === null || v === undefined || v === "") return { value: null, text: null, formula: null };
  if (typeof v === "number") return { value: v, text: null, formula: null };
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return { value: null, text: null, formula: null };
    const n = Number(t);
    return Number.isFinite(n) ? { value: n, text: t, formula: null } : { value: null, text: t, formula: null };
  }
  if (typeof v === "object" && "richText" in v) {
    const t = v.richText.map((r) => r.text).join("").trim();
    const n = Number(t);
    return t === "" ? { value: null, text: null, formula: null } : Number.isFinite(n) ? { value: n, text: t, formula: null } : { value: null, text: t, formula: null };
  }
  if (formula) {
    const r = (cell as unknown as { result: unknown }).result;
    return { value: typeof r === "number" ? r : null, text: null, formula };
  }
  return { value: null, text: String(v), formula: null };
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as ExcelJS.CellValue;
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  return cell.text ?? "";
}

const colLetter = (n: number) => {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const DERIVED_RE = /^\$?([A-Z]+)\$?(\d+)\s*\*\s*\$([A-Z]+)\$3$/;

/**
 * keepFormulas: false (default) imports formula columns such as Cookie/Pecan as
 * ordinary items that stores type themselves, using the values the sheet showed.
 */
export function parseWorkbook(wb: ExcelJS.Workbook, opts: { year?: number; preferSheets?: string[]; keepFormulas?: boolean } = {}): ParsedWorkbook {
  const sheets = wb.worksheets;
  // Year for sheets without a date cell: take it from the first sheet that has one.
  let year = opts.year ?? new Date().getFullYear();
  if (!opts.year) {
    for (const ws of sheets) {
      const v = ws.getCell("B1").value;
      if (v instanceof Date) {
        year = v.getUTCFullYear();
        break;
      }
    }
  }

  const items = new Map<string, ParsedItem>();
  const itemFractions = new Map<string, boolean>();
  const stepHint = new Map<string, number>(); // formula columns imported as entered: step = old multiplier
  const keepFormulas = !!opts.keepFormulas;
  const days: ParsedDay[] = [];
  const usedDays = new Map<string, string>(); // day -> sheet name
  const prefer = new Set(opts.preferSheets ?? []);
  const itemByCode = new Map<string, string>(); // row-3 code -> item key
  const allStoreNames = new Map<string, string>();
  const skippedSheets: ParsedWorkbook["skippedSheets"] = [];
  let totalLabel = "Total Riyadh Production";
  let prevMonth = 0;
  let canonicalStores: string[] = [];

  for (const ws of sheets) {
    const anomalies: ParsedAnomaly[] = [];
    // ── Date ──
    const b1 = ws.getCell("B1").value;
    const b1Day = b1 instanceof Date ? isoDay(b1.getUTCFullYear(), b1.getUTCMonth() + 1, b1.getUTCDate()) : null;
    let nameDay = dateFromSheetName(ws.name, year);
    if (nameDay && !b1Day) {
      // Year rollover (Dec → Jan) for undated sheets.
      const m = Number(nameDay.slice(5, 7));
      if (prevMonth && m < prevMonth - 6) year += 1;
      nameDay = dateFromSheetName(ws.name, year);
    }
    // The sheet name is what people go by; B1 is a fallback (it was sometimes left stale on copied sheets).
    const candidates = [...new Set([nameDay, b1Day].filter((d): d is string => !!d))];
    let day = candidates.find((d) => !usedDays.has(d));
    if (!day && candidates.length && prefer.has(ws.name)) {
      // Admin chose this sheet over the one already holding the date.
      day = candidates[0];
      const other = usedDays.get(day)!;
      const idx = days.findIndex((d) => d.day === day);
      if (idx >= 0) days.splice(idx, 1);
      skippedSheets.push({ name: other, reason: `same date as sheet "${ws.name}"`, day, conflictWith: ws.name });
    }
    if (!day) {
      skippedSheets.push(
        candidates.length
          ? { name: ws.name, reason: `same date as sheet "${usedDays.get(candidates[0])}"`, day: candidates[0], conflictWith: usedDays.get(candidates[0]) }
          : { name: ws.name, reason: "no date found" },
      );
      continue;
    }
    if (b1Day && nameDay && b1Day !== nameDay)
      anomalies.push({ storeName: null, itemKey: null, rule: "hist_sheet_date", severity: "warning", message: `Sheet "${ws.name}" has date ${b1Day} in B1 but its name says ${nameDay}. Imported as ${day}.` });
    usedDays.set(day, ws.name);
    prevMonth = Number(day.slice(5, 7));
    if (b1Day) year = Number(b1Day.slice(0, 4));

    // ── Header: row 2 = item names, row 3 = code / multiplier ──
    const cols: { col: number; key: string; name: string; row3: string | number | null }[] = [];
    for (let c = 2; c <= Math.min(ws.columnCount, 60); c++) {
      const hv = ws.getCell(2, c).value;
      const isText = typeof hv === "string" || (!!hv && typeof hv === "object" && "richText" in hv);
      let name = isText ? cellText(ws.getCell(2, c)).replace(/\s+/g, " ").trim() : "";
      const r3 = ws.getCell(3, c).value;
      const row3 = typeof r3 === "number" ? r3 : typeof r3 === "string" && r3.trim() && r3.trim() !== "\u00a0" ? r3.trim() : null;
      if (!name && hv != null && row3 != null && itemByCode.has(String(row3))) {
        // Header was overwritten (e.g. by a date) — recover the item from its code.
        name = items.get(itemByCode.get(String(row3))!)!.name;
        anomalies.push({ storeName: null, itemKey: itemByCode.get(String(row3))!, rule: "hist_header", severity: "warning", message: `Header ${colLetter(c)}2 on sheet "${ws.name}" was "${cellText(ws.getCell(2, c))}" instead of the item name; recognised "${name}" from its code ${row3}.` });
      }
      if (!name) {
        if (cols.length) break;
        continue;
      }
      cols.push({ col: c, key: normKey(name), name, row3 });
    }
    if (!cols.length) {
      skippedSheets.push({ name: ws.name, reason: "no item headers in row 2" });
      usedDays.delete(day);
      continue;
    }
    const lastCol = cols[cols.length - 1].col;
    const colByLetter = new Map(cols.map((c) => [colLetter(c.col), c]));

    // ── Rows ──
    let totalRow = 0;
    const storeRows: { row: number; name: string }[] = [];
    for (let r = 4; r <= ws.rowCount; r++) {
      const a = cellText(ws.getCell(r, 1)).trim();
      if (/^total/i.test(a)) {
        totalRow = r;
        totalLabel = a;
        break;
      }
      if (a && /[a-z\u0600-\u06ff]/i.test(a)) storeRows.push({ row: r, name: a.replace(/\s+/g, " ") });
      else {
        const hasInput = cols.some((c) => {
          const v = cellNumber(ws.getCell(r, c.col));
          return !v.formula && (v.value !== null || v.text);
        });
        if (hasInput) anomalies.push({ storeName: null, itemKey: null, rule: "hist_empty_row", severity: "warning", message: `Row ${r} on sheet "${ws.name}" has quantities but ${a ? `the store name is "${a}"` : "no store name"} (not imported).` });
      }
    }

    // Derived columns: majority of store rows hold "=<col><row>*$<self>$3".
    const derived = new Map<string, string>(); // item key -> source item key
    for (const c of cols) {
      let hits = 0;
      let src: string | null = null;
      for (const sr of storeRows) {
        const f = cellNumber(ws.getCell(sr.row, c.col)).formula;
        const m = f ? DERIVED_RE.exec(f.replace(/^=/, "")) : null;
        if (m && m[3] === colLetter(c.col) && Number(m[2]) === sr.row) {
          hits++;
          src = colByLetter.get(m[1])?.key ?? src;
        }
      }
      if (src && hits >= storeRows.length / 2) derived.set(c.key, src);
    }

    for (const c of cols) {
      const prev = items.get(c.key);
      if (!derived.has(c.key) && c.row3 != null) itemByCode.set(String(c.row3), c.key);
      const isDerived = keepFormulas && derived.has(c.key);
      if (!keepFormulas && derived.has(c.key) && typeof c.row3 === "number" && c.row3 > 0) stepHint.set(c.key, c.row3);
      items.set(c.key, {
        key: c.key,
        name: c.name,
        code: derived.has(c.key) ? null : c.row3 != null ? String(c.row3) : prev?.code ?? null,
        step: 1,
        buttons_only: 0,
        kind: isDerived ? "derived" : "input",
        factor: isDerived ? (typeof c.row3 === "number" ? c.row3 : Number(c.row3) || 0) : null,
        source_key: isDerived ? derived.get(c.key) ?? null : null,
        active: 1,
      });
    }

    const cells: ParsedDay["cells"] = [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const sr of storeRows) {
      const nk = normKey(sr.name);
      if (seen.has(nk)) {
        anomalies.push({ storeName: sr.name, itemKey: null, rule: "hist_duplicate_row", severity: "warning", message: `"${sr.name}" appears twice on sheet "${ws.name}" (row ${sr.row}); the second row was not imported.` });
        continue;
      }
      seen.add(nk);
      names.push(sr.name);
      allStoreNames.set(sr.name, day);
      for (const c of cols) {
        const cell = ws.getCell(sr.row, c.col);
        const v = cellNumber(cell);
        const src = derived.get(c.key);
        if (src) {
          const srcCol = cols.find((x) => x.key === src)!;
          const srcVal = cellNumber(ws.getCell(sr.row, srcCol.col)).value ?? 0;
          const factor = typeof c.row3 === "number" ? c.row3 : 0;
          const expected = srcVal * factor;
          if (!keepFormulas) {
            // Entered item from now on: keep the value the sheet showed.
            cells.push([sr.name, c.key, v.formula ? v.value ?? expected : v.value]);
            continue;
          }
          if (!v.formula) {
            const typed = v.value;
            if (typed !== expected) {
              // Kept as a typed-over value; the "Formula overridden" check reports it.
              cells.push([sr.name, c.key, typed]);
            } else {
              anomalies.push({ storeName: sr.name, itemKey: c.key, rule: "hist_hardcoded", severity: "info", message: `${sr.name}: "${c.name}" was typed over the formula (same value ${typed}); the export restores the formula.` });
            }
          }
          continue;
        }
        if (v.text && v.value === null) {
          anomalies.push({ storeName: sr.name, itemKey: c.key, rule: "hist_text", severity: "warning", message: `${sr.name}: "${c.name}" contains text "${v.text}" instead of a number (imported as blank).` });
        }
        const q = v.value;
        if (q !== null && !Number.isInteger(q)) itemFractions.set(c.key, true);
        cells.push([sr.name, c.key, q]);
      }
    }

    // Totals row: SUM must cover every store row (one finding per sheet).
    if (totalRow && storeRows.length) {
      const first = storeRows[0].row;
      const last = storeRows[storeRows.length - 1].row;
      const problems: string[] = [];
      for (const c of cols) {
        const f = cellNumber(ws.getCell(totalRow, c.col)).formula;
        const m = f ? /SUM\(\$?[A-Z]+\$?(\d+):\$?[A-Z]+\$?(\d+)\)/i.exec(f) : null;
        if (!f) problems.push(`${colLetter(c.col)}${totalRow} was a typed number`);
        else if (m && (Number(m[1]) > first || Number(m[2]) < last)) {
          const missed = storeRows.filter((s) => s.row < Number(m[1]) || s.row > Number(m[2])).map((s) => s.name);
          problems.push(`${colLetter(c.col)}${totalRow} =${f.replace(/^=/, "")} skipped ${missed.join(", ")}`);
        }
      }
      if (problems.length)
        anomalies.push({ storeName: null, itemKey: null, rule: "hist_total_range", severity: "info", message: `Totals row on sheet "${ws.name}": ${problems.join("; ")}. The app's totals always include every store.` });
    }

    // Stray content to the right of the table.
    const maxR = totalRow || ws.rowCount;
    for (let r = 1; r <= maxR; r++) {
      const row = ws.getRow(r);
      row.eachCell({ includeEmpty: false }, (cell, colNo) => {
        if (colNo <= lastCol) return;
        const t = cellText(cell).trim();
        if (t || typeof cell.value === "number")
          anomalies.push({ storeName: null, itemKey: null, rule: "hist_stray", severity: "info", message: `Stray value "${t || cell.value}" in ${cell.address} on sheet "${ws.name}" (outside the order table; dropped).` });
      });
    }

    days.push({ day, sheet_name: ws.name, itemKeys: cols.map((c) => c.key), storeNames: names, cells, anomalies });
    canonicalStores = names;
  }

  for (const sk of skippedSheets) {
    const d = sk.day && days.find((x) => x.day === sk.day);
    if (d) d.anomalies.push({ storeName: null, itemKey: null, rule: "hist_sheet_date", severity: "warning", message: `Sheet "${sk.name}" has the same date (${sk.day}) as "${d.sheet_name}" and was not imported. You can choose which one to keep on the import screen.` });
  }
  for (const [k, frac] of itemFractions) if (frac && items.get(k)?.kind === "input") items.get(k)!.step = 0.5;
  for (const [k, step] of stepHint)
    if (items.get(k)?.kind === "input") Object.assign(items.get(k)!, { step, buttons_only: 1 }); // gram toppings: + / − only
  const latestItems = new Set(days.at(-1)?.itemKeys ?? []);
  for (const it of items.values()) it.active = latestItems.has(it.key) ? 1 : 0;
  // Order: items in the order of the latest sheet, then retired ones.
  const order = [...(days.at(-1)?.itemKeys ?? [])];
  for (const k of items.keys()) if (!order.includes(k)) order.push(k);

  days.sort((a, b) => a.day.localeCompare(b.day));
  return { items: order.map((k) => items.get(k)!), canonicalStores, allStoreNames, days, totalLabel, skippedSheets };
}

// ── Store-name matching ──

function bigrams(s: string) {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
  return out;
}

export function similarity(a: string, b: string): number {
  const x = normKey(a);
  const y = normKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dx = x.match(/\d+/g)?.join(",") ?? "";
  const dy = y.match(/\d+/g)?.join(",") ?? "";
  if (dx && dy && dx !== dy) return 0; // "Thumama 1" ≠ "Thumama 2"
  const digitAdj = dx && dy ? 0.1 : dx || dy ? -0.1 : 0;
  // "ABM" = initials of "Anas Bin Malik"
  const initials = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toLowerCase()).join("");
  if (x.length >= 2 && (x === initials(b) || y === initials(a))) return 0.85;
  if (x.includes(y) || y.includes(x)) return 0.9 + digitAdj;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) ?? 0);
  const dice = (2 * inter) / (x.length - 1 + y.length - 1);
  // Shared start (e.g. "TABUK BLVD" / "Tabuk Boulevard") counts for a lot.
  let p = 0;
  while (p < Math.min(x.length, y.length) && x[p] === y[p]) p++;
  const prefix = p >= 5 ? 0.7 + Math.min(0.15, (p - 5) * 0.03) : 0;
  return Math.max(dice, prefix) + digitAdj;
}

/**
 * Map every raw store name to a canonical store name (from the latest sheet)
 * or to null (keep as its own, inactive store).
 */
export function suggestStoreMapping(parsed: ParsedWorkbook): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const canon = parsed.canonicalStores;
  const byKey = new Map(canon.map((c) => [normKey(c), c]));
  for (const raw of parsed.allStoreNames.keys()) {
    const exact = byKey.get(normKey(raw));
    if (exact) {
      map.set(raw, exact);
      continue;
    }
    let best: string | null = null;
    let score = 0;
    for (const c of canon) {
      const s = similarity(raw, c);
      if (s > score) {
        score = s;
        best = c;
      }
    }
    map.set(raw, score >= 0.65 ? best : null);
  }
  return map;
}

export interface ImportPayload {
  items: (ParsedItem & { key: string })[];
  stores: { key: string; name: string; active: number }[];
  days: {
    day: string;
    sheet_name: string;
    itemKeys: string[];
    storeKeys: string[];
    storeNamesAsShown: string[];
    lines: [string, string, number | null][];
    anomalies: { storeKey: string | null; itemKey: string | null; rule: string; severity: Severity; message: string }[];
  }[];
}

/** Apply the (admin-confirmed) store mapping and build what gets sent to the server. */
export function buildImportPayload(parsed: ParsedWorkbook, mapping: Map<string, string | null>): ImportPayload {
  const stores: ImportPayload["stores"] = parsed.canonicalStores.map((n) => ({ key: n, name: n, active: 1 }));
  const keyOf = (raw: string) => mapping.get(raw) ?? raw;
  for (const raw of parsed.allStoreNames.keys()) {
    if (!mapping.get(raw) && !stores.some((s) => s.key === raw)) stores.push({ key: raw, name: raw, active: 0 });
  }
  const variantFlagged = new Set<string>();
  const days = parsed.days.map((d) => {
    const storeKeys: string[] = [];
    const shown: string[] = [];
    for (const n of d.storeNames) {
      const k = keyOf(n);
      if (storeKeys.includes(k)) continue;
      storeKeys.push(k);
      shown.push(n);
    }
    const anomalies = d.anomalies.map((a) => ({ storeKey: a.storeName ? keyOf(a.storeName) : null, itemKey: a.itemKey, rule: a.rule, severity: a.severity, message: a.message }));
    for (const n of d.storeNames) {
      const k = keyOf(n);
      if (k !== n && !variantFlagged.has(n) && parsed.allStoreNames.get(n) === d.day) {
        variantFlagged.add(n);
        anomalies.push({ storeKey: k, itemKey: null, rule: "hist_name_variant", severity: "info", message: `"${n}" was merged into store "${k}".` });
      }
    }
    const lines = d.cells.filter(([n]) => shown.includes(n)).map(([n, i, q]) => [keyOf(n), i, q] as [string, string, number | null]);
    return { day: d.day, sheet_name: d.sheet_name, itemKeys: d.itemKeys, storeKeys, storeNamesAsShown: shown, lines, anomalies };
  });
  return { items: parsed.items, stores, days };
}

export function resolveAnomalies(
  list: ImportPayload["days"][number]["anomalies"],
  storeIds: Record<string, number>,
  itemIds: Record<string, number>,
): NewAnomaly[] {
  return list.map((a) => ({
    store_id: a.storeKey ? storeIds[a.storeKey] ?? null : null,
    item_id: a.itemKey ? itemIds[a.itemKey] ?? null : null,
    rule: a.rule,
    severity: a.severity,
    message: a.message,
  }));
}
