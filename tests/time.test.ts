import { describe, expect, it } from "vitest";
import { cutoffInstant, openDayAt, parseCutoff, sheetNameFor } from "../shared/time";

const cut = parseCutoff("18:30");
const at = (iso: string) => Date.parse(iso);

describe("order day / cutoff (Riyadh, UTC+3)", () => {
  it("before 18:30 Riyadh the open sheet is today's", () => {
    expect(openDayAt(at("2026-11-05T15:29:00Z"), cut, 180)).toBe("2026-11-05"); // 18:29 Riyadh
  });
  it("at 18:30 Riyadh it switches to tomorrow", () => {
    expect(openDayAt(at("2026-11-05T15:30:00Z"), cut, 180)).toBe("2026-11-06");
  });
  it("after midnight Riyadh (still previous UTC day) it is the new date", () => {
    expect(openDayAt(at("2026-11-05T21:30:00Z"), cut, 180)).toBe("2026-11-06"); // 00:30 Nov 6 Riyadh
  });
  it("cutoff instant for a day is 15:30 UTC that day", () => {
    expect(new Date(cutoffInstant("2026-11-05", cut, 180)).toISOString()).toBe("2026-11-05T15:30:00.000Z");
  });
  it("handles month/year rollover", () => {
    expect(openDayAt(at("2026-12-31T16:00:00Z"), cut, 180)).toBe("2027-01-01");
  });
});

describe("sheet names", () => {
  it("matches the workbook's current style", () => {
    expect(sheetNameFor("2026-11-05", "MMM- DD")).toBe("Nov- 05");
    expect(sheetNameFor("2026-10-01", "MMM-D")).toBe("Oct-1");
    expect(sheetNameFor("2026-10-01", "DD-MM-YYYY")).toBe("01-10-2026");
  });
});
