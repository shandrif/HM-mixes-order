// Integration test of the 6:30 PM cutoff job against a real (local) D1 database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayDetail, loadSettings, openDay, rollover, type Ctx } from "../worker/data";
import { ensureSchema } from "../worker/schema";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let ctx: Ctx;
const T = (iso: string) => Date.parse(iso);

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: mkdtempSync(join(tmpdir(), "hm-d1-")) } });
  const db = proxy.env.DB;
  await ensureSchema(db);
  await db.batch([
    db.prepare("INSERT INTO items (id, name, step, sort, kind) VALUES (1, 'Cereal', 1, 1, 'input'), (2, 'Vanilla', 1, 2, 'input')"),
    db.prepare("INSERT INTO items (id, name, step, sort, kind, source_item_id, factor) VALUES (3, 'Cookie (g)', 1, 3, 'derived', 2, 480)"),
    db.prepare("INSERT INTO stores (id, name, sort, pin) VALUES (10, 'Rawabi', 1, '1111'), (11, 'Nadwa', 2, '2222'), (12, 'New Store', 3, '3333')"),
  ]);
  const { settings, secret } = await loadSettings(db);
  ctx = { db, settings, secret };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("cutoff rollover", () => {
  it("opens the right day and locks at 18:30 Riyadh with carry-forward", async () => {
    const db = ctx.db;
    // Nov 3, 17:00 Riyadh → stores fill the Nov 4 sheet.
    expect((await rollover(ctx, T("2026-11-03T14:00:00Z"))).open).toBe("2026-11-04");
    // Both Rawabi and Nadwa order on Nov 4.
    await db.batch([
      db.prepare("INSERT INTO lines (day, store_id, item_id, qty, source) VALUES ('2026-11-04', 10, 1, 6, 'entered'), ('2026-11-04', 10, 2, 2, 'entered'), ('2026-11-04', 11, 1, 5, 'entered'), ('2026-11-04', 11, 2, 1, 'entered')"),
      db.prepare("INSERT INTO submissions (day, store_id, source, submitted_at) VALUES ('2026-11-04', 10, 'entered', 'x'), ('2026-11-04', 11, 'entered', 'x')"),
    ]);
    // Nov 3 18:30 Riyadh → Nov 4 sheet locks, Nov 5 opens.
    const r1 = await rollover(ctx, T("2026-11-03T15:30:00Z"));
    expect(r1).toEqual({ locked: ["2026-11-04"], open: "2026-11-05" });
    // Running again is a no-op (cron every 15 min).
    expect((await rollover(ctx, T("2026-11-03T15:45:00Z"))).locked).toEqual([]);

    // On Nov 5 only Rawabi submits.
    await db.batch([
      db.prepare("INSERT INTO lines (day, store_id, item_id, qty, source) VALUES ('2026-11-05', 10, 1, 7, 'entered'), ('2026-11-05', 10, 2, 3, 'entered')"),
      db.prepare("INSERT INTO submissions (day, store_id, source, submitted_at) VALUES ('2026-11-05', 10, 'entered', 'x')"),
    ]);
    // Cron runs late (Nov 4, 18:52) — still locks the Nov 5 sheet.
    const r2 = await rollover(ctx, T("2026-11-04T15:52:00Z"));
    expect(r2).toEqual({ locked: ["2026-11-05"], open: "2026-11-06" });

    const d = (await dayDetail(ctx, "2026-11-05"))!;
    expect(d.status).toBe("locked");
    const q = (s: number, i: number) => d.lines.find((l) => l[0] === s && l[1] === i);
    expect(q(10, 1)?.slice(2)).toEqual([7, "entered"]); // Rawabi keeps its own entry
    expect(q(11, 1)?.slice(2)).toEqual([5, "carried_forward"]); // Nadwa copied from Nov 4
    expect(q(11, 2)?.slice(2)).toEqual([1, "carried_forward"]);
    expect(q(12, 1)).toBeUndefined(); // New store has no previous day → nothing to copy
    expect(d.submissions.find((s) => s[0] === 11)?.[1]).toBe("carried_forward");
    expect(d.anomalies.some((a) => a.rule === "carried_forward" && a.store_id === 11)).toBe(true);
    // Frozen layout: store/item names as of that day
    expect(d.layout.stores.map((s) => s.name)).toEqual(["Rawabi", "Nadwa", "New Store"]);
  });

  it("a store edit after the cutoff is refused (day no longer open)", () => {
    expect(openDay(ctx.settings, T("2026-11-04T15:30:01Z"))).toBe("2026-11-06");
    expect(openDay(ctx.settings, T("2026-11-04T15:29:59Z"))).toBe("2026-11-05");
  });

  it("renaming a store later does not change locked days", async () => {
    await ctx.db.prepare("UPDATE stores SET name = 'Rawabi (renamed)' WHERE id = 10").run();
    expect((await dayDetail(ctx, "2026-11-05"))!.layout.stores[0].name).toBe("Rawabi");
    expect((await dayDetail(ctx, "2026-11-06"))!.layout.stores[0].name).toBe("Rawabi (renamed)");
  });
});
