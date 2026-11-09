// Integration test of the 6:30 PM cutoff job against a real (local) D1 database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, loadCfg, updateCfg, updateSheet } from "../worker/db";
import { dayDetail, openDay, rollover, type Ctx } from "../worker/logic";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let ctx: Ctx;
const T = (iso: string) => Date.parse(iso);

async function send(day: string, store: number, q: Record<number, number>) {
  await updateSheet(ctx.db, day, (_row, data) => {
    data.q[store] = q;
    data.sub[store] = ["entered", "x", 1];
    return { data };
  });
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: mkdtempSync(join(tmpdir(), "hm-d1-")) } });
  const db = proxy.env.DB;
  await ensureSchema(db);
  await updateCfg(db, (k) => {
    k.items = [
      { id: 1, name: "Cereal", name_ar: null, code: null, step: 1, sort: 1, active: 1, kind: "input", source_item_id: null, factor: null, buttons_only: 0 },
      { id: 2, name: "Vanilla", name_ar: null, code: null, step: 1, sort: 2, active: 1, kind: "input", source_item_id: null, factor: null, buttons_only: 0 },
    ];
    k.stores = [
      { id: 10, name: "Rawabi", name_ar: null, region: null, sort: 1, active: 1, pin: null },
      { id: 11, name: "Nadwa", name_ar: null, region: null, sort: 2, active: 1, pin: null },
      { id: 12, name: "New Store", name_ar: null, region: null, sort: 3, active: 1, pin: null },
    ];
  });
  const { cfg, open_day } = await loadCfg(db);
  ctx = { db, cfg, open_day };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("cutoff rollover", () => {
  it("opens the right day and locks at 18:30 Riyadh with carry-forward", async () => {
    // Nov 3, 17:00 Riyadh → stores fill the Nov 4 sheet.
    expect((await rollover(ctx, T("2026-11-03T14:00:00Z"))).open).toBe("2026-11-04");
    await send("2026-11-04", 10, { 1: 6, 2: 2 });
    await send("2026-11-04", 11, { 1: 5, 2: 1 });
    // Nov 3 18:30 Riyadh → Nov 4 sheet locks, Nov 5 opens.
    expect(await rollover(ctx, T("2026-11-03T15:30:00Z"))).toEqual({ locked: ["2026-11-04"], open: "2026-11-05" });
    // Running again is a no-op (cron every 15 min).
    expect((await rollover(ctx, T("2026-11-03T15:45:00Z"))).locked).toEqual([]);

    // On Nov 5 only Rawabi sends.
    await send("2026-11-05", 10, { 1: 7, 2: 3 });
    // Cron runs late (Nov 4, 18:52) — still locks the Nov 5 sheet.
    expect(await rollover(ctx, T("2026-11-04T15:52:00Z"))).toEqual({ locked: ["2026-11-05"], open: "2026-11-06" });

    const d = (await dayDetail(ctx, "2026-11-05"))!;
    expect(d.status).toBe("locked");
    const q = (s: number, i: number) => d.lines.find((l) => l[0] === s && l[1] === i);
    expect(q(10, 1)?.slice(2)).toEqual([7, "entered"]); // Rawabi keeps its own entry
    expect(q(11, 1)?.slice(2)).toEqual([5, "carried_forward"]); // Nadwa copied from Nov 4
    expect(q(11, 2)?.slice(2)).toEqual([1, "carried_forward"]);
    expect(q(12, 1)).toBeUndefined(); // New store has no previous day → nothing to copy
    expect(d.submissions.find((s) => s[0] === 11)?.[1]).toBe("carried_forward");
    expect(d.anomalies.some((a) => a.rule === "carried_forward" && a.store_id === 11)).toBe(true);
    expect(d.layout.stores.map((s) => s.name)).toEqual(["Rawabi", "Nadwa", "New Store"]);
  });

  it("a store edit after the cutoff is refused (day no longer open)", () => {
    expect(openDay(ctx.cfg.settings, T("2026-11-04T15:30:01Z"))).toBe("2026-11-06");
    expect(openDay(ctx.cfg.settings, T("2026-11-04T15:29:59Z"))).toBe("2026-11-05");
  });

  it("renaming a store later does not change locked days", async () => {
    const { cfg } = await updateCfg(ctx.db, (k) => {
      k.stores[0].name = "Rawabi (renamed)";
    });
    ctx.cfg = cfg;
    expect((await dayDetail(ctx, "2026-11-05"))!.layout.stores[0].name).toBe("Rawabi");
    expect((await dayDetail(ctx, "2026-11-06"))!.layout.stores[0].name).toBe("Rawabi (renamed)");
  });
});
