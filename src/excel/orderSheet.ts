// The reviewed order file that is emailed to the factory and stores:
// HM-branded, print-ready, with a production summary for the factory.
import type ExcelJS from "exceljs";
import { formatDayLong } from "../../shared/time";
import type { DayDetail } from "../../shared/types";
import { colLetter } from "./exporter";

type ExcelNS = typeof ExcelJS;

export const BRAND = {
  ink: "FF1F1A17",
  gold: "FFD4B38B",
  goldDeep: "FFCDA371",
  cream: "FFF5EDE3",
  paper: "FFFFFFFF",
  mint: "FF84C6B2",
  line: "FFE7DDD0",
  muted: "FF7A6F66",
  white: "FFFFFFFF",
  up: "FF1E7A55",
  down: "FFB42318",
};
const FONT = "Frutiger LT Arabic 55 Roman";

export interface OrderSheetOptions {
  previous?: DayDetail | null; // last delivery before this one, for the factory comparison
  sentBy: string;
  sentAt: Date;
  note?: string;
  logoPng?: string; // base64 PNG (no data: prefix)
}

const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const hair: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: BRAND.line } },
  left: { style: "thin", color: { argb: BRAND.line } },
  bottom: { style: "thin", color: { argb: BRAND.line } },
  right: { style: "thin", color: { argb: BRAND.line } },
};
const riyadh = (d: Date | string) =>
  new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

export function orderFileName(day: string) {
  const [y, m, d] = day.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `HM_Mixes_Order_${d}_${mon}_${y}.xlsx`;
}

/** Quantity per store/item for a day, with calculated items resolved. */
export function dayValues(d: DayDetail) {
  const q = new Map<string, number | null>();
  for (const [s, i, v] of d.lines) q.set(`${s}:${i}`, v);
  const value = (sid: number, it: DayDetail["layout"]["items"][number]): number | null => {
    const k = `${sid}:${it.id}`;
    if (it.kind === "derived" && (q.get(k) === undefined || q.get(k) === null)) return (q.get(`${sid}:${it.source_item_id}`) ?? 0) * (it.factor ?? 0);
    return q.has(k) ? q.get(k)! : null;
  };
  const totals = new Map<number, number>();
  const ordering = new Map<number, number>();
  for (const it of d.layout.items) {
    let t = 0;
    let n = 0;
    for (const s of d.layout.stores) {
      const v = value(s.id, it) ?? 0;
      t += v;
      if (v > 0) n++;
    }
    totals.set(it.id, t);
    ordering.set(it.id, n);
  }
  return { value, totals, ordering };
}

function band(ws: ExcelJS.Worksheet, row: number, lastCol: number, text: string, opts: { size: number; color: string; fill: string; bold?: boolean; height: number; indent?: number }) {
  ws.mergeCells(row, 1, row, lastCol);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: FONT, size: opts.size, bold: opts.bold ?? true, color: { argb: opts.color } };
  c.alignment = { vertical: "middle", horizontal: "left", indent: opts.indent ?? 1 };
  for (let col = 1; col <= lastCol; col++) ws.getCell(row, col).fill = solid(opts.fill);
  ws.getRow(row).height = opts.height;
}

export function buildOrderWorkbook(Excel: ExcelNS, d: DayDetail, o: OrderSheetOptions): ExcelJS.Workbook {
  const wb = new Excel.Workbook();
  wb.creator = "HM Mixes Order";
  wb.company = "HM";
  wb.title = `Mixes order — delivery ${d.day}`;
  wb.created = o.sentAt;
  const { value, totals, ordering } = dayValues(d);
  const items = d.layout.items;
  const stores = d.layout.stores;
  const subs = new Map(d.submissions.map(([s, src, at]) => [s, { src, at }]));
  const dayLong = formatDayLong(d.day);
  const logoId = o.logoPng ? wb.addImage({ base64: o.logoPng, extension: "png" }) : null;
  const indent = logoId != null ? 6 : 1;

  // ───────── Sheet 1: Order (every branch × every item) ─────────
  const ws = wb.addWorksheet("Order", {
    properties: { tabColor: { argb: BRAND.gold } },
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: `&L&8HM · Mixes order · delivery ${dayLong}&R&8Page &P of &N` },
  });
  const lastCol = items.length + 2; // store + items + status
  ws.getColumn(1).width = 28;
  items.forEach((_, i) => (ws.getColumn(i + 2).width = 12.5));
  ws.getColumn(lastCol).width = 22;

  band(ws, 1, lastCol, "HM  ·  MIXES ORDER", { size: 18, color: BRAND.gold, fill: BRAND.ink, height: 30, indent });
  band(ws, 2, lastCol, `Delivery ${dayLong}`, { size: 14, color: BRAND.white, fill: BRAND.ink, height: 24, indent });
  if (logoId != null) ws.addImage(logoId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 44, height: 44 } });
  const sentCount = stores.filter((s) => subs.get(s.id)?.src === "entered" || subs.get(s.id)?.src === "imported").length;
  const copied = stores.filter((s) => subs.get(s.id)?.src === "carried_forward").length;
  const none = stores.length - sentCount - copied;
  band(ws, 3, lastCol, `Order closed ${riyadh(d.cutoff_at)}  ·  Reviewed and sent by ${o.sentBy}, ${riyadh(o.sentAt)}`, { size: 10, color: BRAND.ink, fill: BRAND.cream, bold: false, height: 18 });
  band(ws, 4, lastCol, `${stores.length} branches  ·  ${sentCount} sent their order  ·  ${copied} copied from the previous day${none ? `  ·  ${none} no order` : ""}`, { size: 10, color: BRAND.muted, fill: BRAND.cream, bold: false, height: 18 });
  let r = 5;
  if (o.note?.trim()) {
    band(ws, r, lastCol, `Note: ${o.note.trim()}`, { size: 10, color: BRAND.ink, fill: BRAND.paper, bold: false, height: 18 });
    ws.getCell(r, 1).font = { name: FONT, size: 10, italic: true, color: { argb: BRAND.ink } };
    r++;
  }
  ws.getRow(r).height = 6; // spacer
  r++;

  const head = r;
  const codeRow = r + 1;
  const headers = ["Branch", ...items.map((i) => i.name), "Status"];
  headers.forEach((h, i) => {
    const c = ws.getCell(head, i + 1);
    c.value = h;
    c.font = { name: FONT, size: 10, bold: true, color: { argb: BRAND.ink } };
    c.fill = solid(BRAND.mint);
    c.alignment = { horizontal: i === 0 ? "left" : "center", vertical: "middle", wrapText: true, indent: i === 0 ? 1 : 0 };
    c.border = hair;
  });
  // Tall enough for the longest item name (≈ 13 characters per line at this width)
  ws.getRow(head).height = Math.max(46, 13 * Math.ceil(Math.max(...items.map((i) => i.name.length), 10) / 11) + 6);
  ["Code", ...items.map((i) => (i.code ? (/^\d+$/.test(i.code) ? Number(i.code) : i.code) : "")), ""].forEach((v, i) => {
    const c = ws.getCell(codeRow, i + 1);
    c.value = v as ExcelJS.CellValue;
    c.font = { name: FONT, size: 8, color: { argb: BRAND.ink } };
    c.fill = solid(BRAND.gold);
    c.alignment = { horizontal: i === 0 ? "left" : "center", vertical: "middle", indent: i === 0 ? 1 : 0 };
    c.border = hair;
  });
  ws.getRow(codeRow).height = 14;

  const first = codeRow + 1;
  stores.forEach((s, idx) => {
    const row = first + idx;
    const zebra = idx % 2 ? BRAND.cream : BRAND.paper;
    const name = ws.getCell(row, 1);
    name.value = s.name;
    name.font = { name: FONT, size: 10, bold: true, color: { argb: BRAND.ink } };
    name.alignment = { vertical: "middle", indent: 1 };
    items.forEach((it, j) => {
      const c = ws.getCell(row, j + 2);
      c.value = value(s.id, it);
      c.numFmt = it.step % 1 !== 0 ? '0.0;-0.0;"–"' : '#,##0;-#,##0;"–"';
      c.font = { name: FONT, size: 10, color: { argb: BRAND.ink } };
      c.alignment = { horizontal: "center", vertical: "middle" };
    });
    const sub = subs.get(s.id);
    const st = ws.getCell(row, lastCol);
    st.value = !sub ? "No order" : sub.src === "carried_forward" ? "Copied from previous day" : sub.src === "imported" ? "From workbook" : `Sent ${new Date(sub.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour: "numeric", minute: "2-digit", hour12: true })}`;
    st.font = { name: FONT, size: 9, italic: true, color: { argb: !sub ? BRAND.down : BRAND.muted } };
    st.alignment = { vertical: "middle", indent: 1 };
    for (let col = 1; col <= lastCol; col++) {
      const c = ws.getCell(row, col);
      c.fill = solid(zebra);
      c.border = hair;
    }
    ws.getRow(row).height = 17;
  });
  const last = first + stores.length - 1;
  const tot = last + 1;
  ws.getCell(tot, 1).value = d.layout.total_label || "Total";
  items.forEach((it, j) => {
    const col = colLetter(j + 2);
    const c = ws.getCell(tot, j + 2);
    c.value = stores.length ? { formula: `SUM(${col}${first}:${col}${last})`, result: totals.get(it.id) } : 0;
    c.numFmt = it.step % 1 !== 0 ? "#,##0.0" : "#,##0";
  });
  for (let col = 1; col <= lastCol; col++) {
    const c = ws.getCell(tot, col);
    c.fill = solid(BRAND.goldDeep);
    c.font = { name: FONT, size: 11, bold: true, color: { argb: BRAND.ink } };
    c.alignment = { horizontal: col === 1 ? "left" : "center", vertical: "middle", indent: col === 1 ? 1 : 0 };
    c.border = { ...hair, top: { style: "medium", color: { argb: BRAND.ink } } };
  }
  ws.getRow(tot).height = 22;
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: codeRow, activeCell: `B${first}`, showGridLines: false }];
  ws.pageSetup.printTitlesRow = `${head}:${codeRow}`;
  ws.pageSetup.printArea = `A1:${colLetter(lastCol)}${tot}`;

  // ───────── Sheet 2: Factory summary ─────────
  const fs = wb.addWorksheet("Factory summary", {
    properties: { tabColor: { argb: BRAND.ink } },
    pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: `&L&8HM · Production summary · delivery ${dayLong}&R&8Page &P of &N` },
  });
  const prev = o.previous ?? null;
  const prevVals = prev ? dayValues(prev) : null;
  const cols = ["#", "Item", "Code", "Total to produce", "Branches ordering", prev ? `Previous order (${formatDayLong(prev.day).replace(/, \d{4}$/, "")})` : "Previous order", "Change"];
  const widths = [5, 48, 12, 16, 16, 24, 12];
  widths.forEach((w, i) => (fs.getColumn(i + 1).width = w));
  band(fs, 1, cols.length, "HM  ·  PRODUCTION SUMMARY", { size: 16, color: BRAND.gold, fill: BRAND.ink, height: 28, indent });
  band(fs, 2, cols.length, `Delivery ${dayLong}`, { size: 13, color: BRAND.white, fill: BRAND.ink, height: 22, indent });
  if (logoId != null) fs.addImage(logoId, { tl: { col: 0.15, row: 0.12 }, ext: { width: 40, height: 40 } });
  band(fs, 3, cols.length, `${stores.length} branches  ·  sent by ${o.sentBy}, ${riyadh(o.sentAt)}`, { size: 10, color: BRAND.muted, fill: BRAND.cream, bold: false, height: 18 });
  fs.getRow(4).height = 6;
  const fh = 5;
  cols.forEach((h, i) => {
    const c = fs.getCell(fh, i + 1);
    c.value = h;
    c.font = { name: FONT, size: 10, bold: true, color: { argb: BRAND.ink } };
    c.fill = solid(BRAND.mint);
    c.alignment = { horizontal: i === 1 ? "left" : "center", vertical: "middle", wrapText: true, indent: i === 1 ? 1 : 0 };
    c.border = hair;
  });
  fs.getRow(fh).height = 46;
  items.forEach((it, idx) => {
    const row = fh + 1 + idx;
    const total = totals.get(it.id) ?? 0;
    const prevTotal = prevVals ? prevVals.totals.get(it.id) ?? null : null;
    const fmt = it.step % 1 !== 0 ? "#,##0.0" : "#,##0";
    const vals: ExcelJS.CellValue[] = [idx + 1, it.name, it.code ? (/^\d+$/.test(it.code) ? Number(it.code) : it.code) : "", total, ordering.get(it.id) ?? 0, prevTotal, prevTotal == null ? null : total - prevTotal];
    vals.forEach((v, i) => {
      const c = fs.getCell(row, i + 1);
      c.value = v;
      c.font = { name: FONT, size: i === 3 ? 12 : 10, bold: i === 1 || i === 3, color: { argb: BRAND.ink } };
      c.alignment = { horizontal: i === 1 ? "left" : "center", vertical: "middle", indent: i === 1 ? 1 : 0, wrapText: i === 1 };
      c.fill = solid(idx % 2 ? BRAND.cream : BRAND.paper);
      c.border = hair;
      if (i === 3 || i === 5) c.numFmt = fmt;
    });
    const ch = fs.getCell(row, 7);
    ch.numFmt = it.step % 1 !== 0 ? '+0.0;-0.0;"–"' : '+#,##0;-#,##0;"–"';
    if (typeof ch.value === "number" && ch.value !== 0) ch.font = { name: FONT, size: 10, bold: true, color: { argb: ch.value > 0 ? BRAND.up : BRAND.down } };
    fs.getCell(row, 4).fill = solid(BRAND.gold);
    fs.getRow(row).height = it.name.length > 44 ? 32 : 20;
  });
  const noteRow = fh + items.length + 2;
  fs.mergeCells(noteRow, 1, noteRow, cols.length);
  const nc = fs.getCell(noteRow, 1);
  nc.value = "Totals are the sum of all branches on the Order sheet. “Branches ordering” counts branches with a quantity above zero.";
  nc.font = { name: FONT, size: 8, italic: true, color: { argb: BRAND.muted } };
  nc.alignment = { wrapText: true, vertical: "top" };
  fs.getRow(noteRow).height = 26;
  fs.views = [{ state: "frozen", ySplit: fh, showGridLines: false }];

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: "visible" }];
  return wb;
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
