import { describe, expect, it } from "vitest";
import { cutoffInstant, openDayAt, parseCutoff, sheetNameFor } from "../shared/time";

const cut = parseCutoff("18:30");
const at = (iso: string) => Date.parse(iso);

describe("order day / cutoff (Riyadh, UTC+3) — sheets are dated by delivery day", () => {
  it("before 18:30 Riyadh stores fill tomorrow's sheet", () => {
    expect(openDayAt(at("2026-11-09T15:29:00Z"), cut, 180)).toBe("2026-11-10"); // 18:29 on 9 Nov
  });
  it("at 18:30 Riyadh it switches to the day after tomorrow", () => {
    expect(openDayAt(at("2026-11-09T15:30:00Z"), cut, 180)).toBe("2026-11-11");
  });
  it("after midnight Riyadh (still previous UTC day) it uses the new local date", () => {
    expect(openDayAt(at("2026-11-09T21:30:00Z"), cut, 180)).toBe("2026-11-11"); // 00:30 on 10 Nov
  });
  it("the 10 Nov sheet locks at 18:30 Riyadh on 9 Nov (15:30 UTC)", () => {
    expect(new Date(cutoffInstant("2026-11-10", cut, 180)).toISOString()).toBe("2026-11-09T15:30:00.000Z");
  });
  it("handles month/year rollover", () => {
    expect(openDayAt(at("2026-12-31T16:00:00Z"), cut, 180)).toBe("2027-01-02");
  });
});

describe("sheet names", () => {
  it("matches the workbook's current style", () => {
    expect(sheetNameFor("2026-11-05", "MMM- DD")).toBe("Nov- 05");
    expect(sheetNameFor("2026-10-01", "MMM-D")).toBe("Oct-1");
    expect(sheetNameFor("2026-10-01", "DD-MM-YYYY")).toBe("01-10-2026");
  });
});
