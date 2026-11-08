import { describe, expect, it } from "vitest";
import { isValidQty, runChecks, type CheckInput } from "../shared/checks";

const items = [
  { id: 1, name: "Hot Choc Topping", kind: "input" as const, step: 0.5, source_item_id: null, factor: null },
  { id: 2, name: "Cereal Latte", kind: "input" as const, step: 1, source_item_id: null, factor: null },
  { id: 3, name: "Vanilla", kind: "input" as const, step: 1, source_item_id: null, factor: null },
  { id: 4, name: "Cookie (g)", kind: "derived" as const, step: 1, source_item_id: 3, factor: 480 },
];
const stores = [{ id: 10, name: "Rawabi" }, { id: 11, name: "Nadwa" }];
const stat = (avg: number, max: number, n = 20, nonzero = n) => ({ n, avg, max, nonzero });

function base(): CheckInput {
  return {
    items,
    stores,
    cells: new Map([
      ["10:1", 0.5], ["10:2", 6], ["10:3", 2],
      ["11:1", 0], ["11:2", 5], ["11:3", 2],
    ]),
    submitted: new Map([[10, "entered"], [11, "entered"]]),
    stats: new Map([
      ["10:1", stat(0.5, 1)], ["10:2", stat(6, 9)], ["10:3", stat(2, 3)],
      ["11:1", stat(0.2, 0.5, 20, 4)], ["11:2", stat(5, 7)], ["11:3", stat(2, 3)],
    ]),
    itemDailyAvg: new Map([[2, 11]]),
    carriedStreak: new Map(),
  };
}

describe("anomaly rules", () => {
  it("normal day has no findings", () => {
    expect(runChecks(base())).toEqual([]);
  });
  it("flags a typo spike (60 instead of 6) as critical", () => {
    const i = base();
    i.cells.set("10:2", 60);
    const f = runChecks(i);
    expect(f.find((a) => a.rule === "spike")?.severity).toBe("critical");
  });
  it("flags fractional quantity on a whole-unit item", () => {
    const i = base();
    i.cells.set("11:2", 2.5);
    expect(runChecks(i).some((a) => a.rule === "invalid_value" && a.store_id === 11)).toBe(true);
  });
  it("allows 0.5 on the topping", () => {
    expect(isValidQty(0.5, 0.5)).toBe(true);
    expect(isValidQty(0.5, 1)).toBe(false);
    expect(isValidQty(-1, 1)).toBe(false);
  });
  it("flags unusual zero", () => {
    const i = base();
    i.cells.set("10:2", 0);
    expect(runChecks(i).some((a) => a.rule === "unusual_zero")).toBe(true);
  });
  it("reports carried-forward stores and long streaks", () => {
    const i = base();
    i.submitted.set(11, "carried_forward");
    i.carriedStreak.set(11, 3);
    const f = runChecks(i);
    expect(f.some((a) => a.rule === "carried_forward" && a.store_id === 11)).toBe(true);
    expect(f.some((a) => a.rule === "carried_streak" && a.store_id === 11)).toBe(true);
  });
  it("flags a calculated cell typed over with a different value", () => {
    const i = base();
    i.cells.set("10:4", 120); // formula would be 2 × 480 = 960
    expect(runChecks(i).find((a) => a.rule === "derived_override")?.message).toContain("960");
  });
  it("flags an item total far above average", () => {
    const i = base();
    i.cells.set("10:2", 9);
    i.cells.set("11:2", 9);
    i.itemDailyAvg.set(2, 10);
    expect(runChecks(i).some((a) => a.rule === "item_total_spike")).toBe(true);
  });
});
