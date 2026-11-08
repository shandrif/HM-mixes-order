// Builds the Mixes Orders workbook in the same layout as the original:
// one sheet per day, all hidden except the latest, with live formulas.
import type ExcelJS from "exceljs";
import type { DayDetail } from "../../shared/types";

type ExcelNS = typeof ExcelJS;

const FILL = {
  date: "FFFFFF00",
  header: "FF84C6B2",
  code: "FFD4B38B",
  row: "FFF5EDE3",
  total: "FFCDA371",
  override: "FFFFD8A8",
};
const HEAD_FONT = "Frutiger LT Arabic 55 Roman";
const BODY_FONT = "Avenir Next LT Pro";

export function colLetter(n: number) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

export function buildWorkbook(Excel: ExcelNS, days: DayDetail[]): ExcelJS.Workbook {
  const wb = new Excel.Workbook();
  wb.creator = "HM Mixes Order";
  wb.created = new Date();
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const names = new Set<string>();

  sorted.forEach((d, idx) => {
    let name = (d.sheet_name ?? d.day).slice(0, 31);
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${(d.sheet_name ?? d.day).slice(0, 26)} (${n})`;
    names.add(name.toLowerCase());
    const isLast = idx === sorted.length - 1;
    const ws = wb.addWorksheet(name, {
      state: isLast ? "visible" : "hidden",
      views: [{ state: "frozen", xSplit: 0, ySplit: 2, zoomScale: 85, activeCell: "A3" }],
    });
    writeSheet(ws, d);
  });
  if (sorted.length) wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: sorted.length - 1, visibility: "visible" }];
  return wb;
}

function writeSheet(ws: ExcelJS.Worksheet, d: DayDetail) {
  const items = d.layout.items;
  const stores = d.layout.stores;
  const lastCol = items.length + 1;
  const firstRow = 4;
  const lastRow = firstRow + stores.length - 1;
  const totalRow = lastRow + 1;
  const colOf = new Map(items.map((it, i) => [it.id, colLetter(i + 2)]));
  const qty = new Map<string, number | null>();
  for (const [s, i, q] of d.lines) qty.set(`${s}:${i}`, q);

  ws.getColumn(1).width = 42.27;
  for (let c = 2; c <= lastCol; c++) ws.getColumn(c).width = c === 2 ? 19.45 : 15.5;

  // Row 1: date across the item columns
  const r1 = ws.getRow(1);
  r1.height = 23.25;
  const a1 = ws.getCell(1, 1);
  a1.fill = solid(FILL.date);
  a1.border = thin;
  const b1 = ws.getCell(1, 2);
  const [y, m, dd] = d.day.split("-").map(Number);
  b1.value = new Date(Date.UTC(y, m - 1, dd));
  b1.numFmt = "[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy";
  if (lastCol > 2) ws.mergeCells(1, 2, 1, lastCol);
  for (const cell of [a1, b1]) {
    cell.font = { name: HEAD_FONT, size: 18, bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.fill = solid(FILL.date);
    cell.border = thin;
  }

  // Row 2: item names, row 3: code (input items) or multiplier (calculated items)
  ws.getRow(2).height = 69.75;
  ws.getRow(3).height = 19.5;
  for (let c = 1; c <= lastCol; c++) {
    const it = items[c - 2];
    const h = ws.getCell(2, c);
    h.value = it ? it.name : null;
    h.font = { name: HEAD_FONT, size: 12, bold: true };
    h.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    h.fill = solid(FILL.header);
    h.border = thin;
    const k = ws.getCell(3, c);
    if (it) {
      if (it.kind === "derived") k.value = it.factor ?? 0;
      else if (it.code != null && it.code !== "") k.value = /^\d+(\.\d+)?$/.test(it.code) ? Number(it.code) : it.code;
    }
    k.font = { name: HEAD_FONT, size: 12, bold: true };
    k.alignment = { horizontal: "center", vertical: "middle" };
    k.fill = solid(FILL.code);
    k.border = thin;
  }

  // Store rows
  stores.forEach((s, i) => {
    const r = firstRow + i;
    const row = ws.getRow(r);
    row.height = 18;
    const a = row.getCell(1);
    a.value = s.name;
    items.forEach((it, j) => {
      const cell = row.getCell(j + 2);
      const key = `${s.id}:${it.id}`;
      if (it.kind === "derived") {
        const src = it.source_item_id != null ? colOf.get(it.source_item_id) : undefined;
        const col = colLetter(j + 2);
        if (qty.has(key)) {
          // Typed-over value kept on purpose by the admin.
          cell.value = qty.get(key) ?? null;
          cell.fill = solid(FILL.override);
        } else if (src) {
          const srcQ = qty.get(`${s.id}:${it.source_item_id}`) ?? 0;
          cell.value = { formula: `${src}${r}*$${col}$3`, result: srcQ * (it.factor ?? 0) };
        } else {
          cell.value = 0;
        }
        cell.numFmt = '_(* #,##0_);_(* \\(#,##0\\);_(* "-"??_);_(@_)';
      } else {
        const q = qty.get(key);
        cell.value = q ?? null;
      }
    });
    for (let c = 1; c <= lastCol; c++) {
      const cell = row.getCell(c);
      cell.font = { name: BODY_FONT, size: 14, bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      if (!cell.fill || (cell.fill as ExcelJS.FillPattern).fgColor?.argb !== FILL.override) cell.fill = solid(FILL.row);
      cell.border = thin;
    }
  });

  // Totals
  const tr = ws.getRow(totalRow);
  tr.getCell(1).value = d.layout.total_label;
  items.forEach((it, j) => {
    const col = colLetter(j + 2);
    let sum = 0;
    for (const s of d.layout.stores) {
      const k = `${s.id}:${it.id}`;
      if (it.kind === "derived" && !qty.has(k)) sum += (qty.get(`${s.id}:${it.source_item_id}`) ?? 0) * (it.factor ?? 0);
      else sum += qty.get(k) ?? 0;
    }
    tr.getCell(j + 2).value = stores.length ? { formula: `SUM(${col}${firstRow}:${col}${lastRow})`, result: sum } : 0;
  });
  for (let c = 1; c <= lastCol; c++) {
    const cell = tr.getCell(c);
    cell.font = { name: HEAD_FONT, size: 14, bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.fill = solid(FILL.total);
    cell.border = thin;
  }
}

export async function workbookToBlob(wb: ExcelJS.Workbook): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
