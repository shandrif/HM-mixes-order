import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildWorkbook } from "../src/excel/exporter";
import { parseWorkbook } from "../src/excel/importer";
import type { DayDetail } from "../shared/types";

const layout: DayDetail["layout"] = {
  items: [
    { id: 1, name: "Hot Chocolate Topping", code: "1624001", kind: "input", source_item_id: null, factor: null, step: 0.5 },
    { id: 2, name: "Vanilla Ice Cream (5L/ Gal)", code: null, kind: "input", source_item_id: null, factor: null, step: 1 },
    { id: 3, name: "Cookie Topping (gram)", code: null, kind: "derived", source_item_id: 2, factor: 480 },
    { id: 4, name: "Pecan Topping (gram)", code: null, kind: "derived", source_item_id: 2, factor: 120 },
  ] as DayDetail["layout"]["items"],
  stores: [{ id: 10, name: "SAFA-02" }, { id: 11, name: "Rawabi" }],
  total_label: "Total Riyadh Production",
};

const day = (d: string, lines: DayDetail["lines"]): DayDetail => ({
  day: d, status: "locked", sheet_name: d === "2026-11-05" ? "Nov- 05" : "Nov- 04", cutoff_at: "", layout, lines, submissions: [], anomalies: [], sent: null,
});

describe("Excel export", () => {
  it("writes formulas, totals, hidden sheets — and re-imports cleanly", async () => {
    const wb = buildWorkbook(ExcelJS, [
      day("2026-11-05", [[10, 1, 0.5, "entered"], [10, 2, 2, "entered"], [11, 1, 0, "entered"], [11, 2, 3, "entered"], [11, 4, 240, "admin_edit"]]),
      day("2026-11-04", [[10, 1, 1, "entered"], [10, 2, 1, "entered"], [11, 1, 0, "entered"], [11, 2, 1, "entered"]]),
    ]);
    const buf = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf as ArrayBuffer);

    expect(back.worksheets.map((w) => w.name)).toEqual(["Nov- 04", "Nov- 05"]);
    expect(back.worksheets.map((w) => w.state)).toEqual(["hidden", "visible"]);
    const ws = back.getWorksheet("Nov- 05")!;
    expect(ws.getCell("B1").value).toBeInstanceOf(Date);
    expect(ws.getCell("A4").value).toBe("SAFA-02");
    expect(ws.getCell("D4").formula).toBe("C4*$D$3");
    expect(ws.getCell("D3").value).toBe(480);
    expect(ws.getCell("E5").value).toBe(240); // kept override
    expect(ws.getCell("B6").formula).toBe("SUM(B4:B5)"); // totals start at the FIRST store row
    expect(ws.getCell("A6").value).toBe("Total Riyadh Production");

    const parsed = parseWorkbook(back, { keepFormulas: true });
    expect(parsed.days.map((d) => d.day)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(parsed.items.find((i) => i.name.startsWith("Cookie"))?.kind).toBe("derived");

    // Default import: formula columns become items the stores type, with the values shown.
    const plain = parseWorkbook(back);
    const cookie = plain.items.find((i) => i.name.startsWith("Cookie"))!;
    expect(cookie).toMatchObject({ kind: "input", step: 480, code: null, source_key: null });
    const nov05 = plain.days.find((d) => d.day === "2026-11-05")!;
    expect(nov05.cells.find(([s, k]) => s === "SAFA-02" && k === cookie.key)?.[2]).toBe(960);
    const findings = parsed.days.flatMap((d) => d.anomalies).filter((a) => a.rule !== "hist_hardcoded");
    expect(findings).toEqual([]);
  });
});
