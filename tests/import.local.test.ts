// Runs only when HM_XLSX points at a real workbook (not committed to the repo).
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildImportPayload, parseWorkbook, suggestStoreMapping } from "../src/excel/importer";

const file = process.env.HM_XLSX;

describe.skipIf(!file)("real workbook import", () => {
  it("parses every sheet", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file!);
    const t = Date.now();
    const parsed = parseWorkbook(wb);
    console.log("parse ms", Date.now() - t);
    console.log("days", parsed.days.length, parsed.days[0].day, parsed.days.at(-1)!.day, "skipped", parsed.skippedSheets);
    console.log("items", parsed.items.map((i) => `${i.name} [${i.kind}${i.kind === "derived" ? ` ${i.source_key}×${i.factor}` : ""}] step ${i.step} active ${i.active} code ${i.code}`));
    const mapping = suggestStoreMapping(parsed);
    console.log("mapping (non-identical)", [...mapping].filter(([a, b]) => a !== b));
    const payload = buildImportPayload(parsed, mapping);
    console.log("stores", payload.stores.length, "inactive", payload.stores.filter((s) => !s.active).map((s) => s.name));
    const counts: Record<string, number> = {};
    for (const d of payload.days) for (const a of d.anomalies) counts[`${a.rule}/${a.severity}`] = (counts[`${a.rule}/${a.severity}`] ?? 0) + 1;
    console.log("anomalies", counts);
    const last = payload.days.at(-1)!;
    console.log(last.anomalies.map((a) => a.message));
    console.log(payload.days.filter((d) => d.anomalies.some((a) => a.rule === "hist_sheet_date")).map((d) => d.anomalies.filter((a) => a.rule === "hist_sheet_date").map((a) => a.message)));
    expect(parsed.days.length).toBeGreaterThan(140);
  }, 120_000);
});
