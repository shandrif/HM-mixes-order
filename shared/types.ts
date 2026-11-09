// Types shared by the Worker (API) and the web app.

export type ItemKind = "input" | "derived";

export interface Item {
  id: number;
  name: string;
  name_ar: string | null;
  code: string | null; // SKU shown in row 3 of the sheet (input items)
  step: number; // allowed increment, e.g. 0.5 for Hot Chocolate Topping, 1 otherwise
  buttons_only: number; // 1 = stores can only use + / −, no typing
  sort: number;
  active: number;
  kind: ItemKind;
  source_item_id: number | null; // derived items: the input item they multiply
  factor: number | null; // derived items: the row-3 multiplier (e.g. 480 g)
}

export interface Store {
  id: number;
  name: string;
  name_ar: string | null;
  region: string | null;
  sort: number;
  active: number;
  pin: string | null;
}

/** Frozen copy of the sheet layout for one day (names as they were that day). */
export interface Layout {
  items: Pick<Item, "id" | "name" | "code" | "kind" | "source_item_id" | "factor" | "step">[];
  stores: Pick<Store, "id" | "name">[];
  total_label: string;
}

export type LineSource = "entered" | "carried_forward" | "admin_edit" | "imported";
/** [store_id, item_id, qty (null = blank cell), source] */
export type LineTuple = [number, number, number | null, LineSource];

export type Severity = "critical" | "warning" | "info";
export type AnomalyStatus = "open" | "resolved" | "ignored";

export interface Anomaly {
  id: string; // "<day>~<a|h>~<key>"
  day: string;
  store_id: number | null;
  item_id: number | null;
  rule: string;
  severity: Severity;
  message: string;
  status: AnomalyStatus;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface NewAnomaly {
  store_id: number | null;
  item_id: number | null;
  rule: string;
  severity: Severity;
  message: string;
}

export interface DayDetail {
  day: string;
  status: "open" | "locked";
  sheet_name: string | null;
  cutoff_at: string;
  layout: Layout;
  lines: LineTuple[];
  submissions: [number, string, string][]; // [store_id, source, submitted_at]
  anomalies: Anomaly[];
  sent: { at: string; by: string | null } | null; // emailed to factory & stores
}

export interface Settings {
  cutoff: string; // "18:30"
  tz_offset_minutes: number; // 180 = Asia/Riyadh (no DST)
  require_pin: boolean;
  total_label: string;
  sheet_name_format: string; // e.g. "MMM- DD"
  history_days: number; // days of history used by the anomaly checks
}

export const RULES: Record<string, { label: string; help: string }> = {
  invalid_value: { label: "Invalid value", help: "Negative, too large, or not a multiple of the item's step." },
  spike: { label: "Unusually high", help: "Much higher than this store usually orders for this item." },
  unusual_zero: { label: "Unusual zero", help: "Store almost always orders this item but entered 0." },
  blank: { label: "Blank cell", help: "Store submitted but left this item empty." },
  carried_forward: { label: "Copied from previous day", help: "Store did not submit before the cutoff; previous day was copied." },
  carried_streak: { label: "No submission for 3+ days", help: "Store has been copied forward several days in a row." },
  derived_override: { label: "Formula overridden", help: "A calculated cell holds a typed value instead of the formula." },
  item_total_spike: { label: "Item total unusually high", help: "Total for this item is far above the recent daily average." },
  hist_hardcoded: { label: "Hard-coded formula cell", help: "In the original workbook this calculated cell was typed over." },
  hist_total_range: { label: "Total formula range wrong", help: "The SUM in the totals row skipped some store rows." },
  hist_stray: { label: "Stray content", help: "Unexpected value outside the order table (e.g. a ` character)." },
  hist_text: { label: "Text in quantity", help: "A quantity cell contained text instead of a number." },
  hist_empty_row: { label: "Row without store name", help: "A row had formulas or values but no store name." },
  hist_sheet_date: { label: "Sheet name / date mismatch", help: "The sheet name and its date cell disagree, or two sheets share a date." },
  hist_duplicate_row: { label: "Store listed twice", help: "The same store appeared twice on one sheet." },
  hist_header: { label: "Item header overwritten", help: "An item name in row 2 was replaced by something else; recognised from its code." },
  hist_name_variant: { label: "Store name spelled differently", help: "This store appeared under a different spelling and was merged." },
};
