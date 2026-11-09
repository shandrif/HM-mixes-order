// Daily email: sent once per locked day through Brevo (fetch is mocked).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureSchema, loadCfg, updateCfg, updateSheet } from "../worker/db";
import { sendDueDailyEmail } from "../worker/email";
import { rollover, type Ctx } from "../worker/logic";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let ctx: Ctx;
const T = (iso: string) => Date.parse(iso);
const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
let brevoStatus = 201;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: mkdtempSync(join(tmpdir(), "hm-mail-")) } });
  const db = proxy.env.DB;
  await ensureSchema(db);
  await updateCfg(db, (k) => {
    k.items = [
      { id: 1, name: "Cereal", name_ar: null, code: null, step: 1, sort: 1, active: 1, kind: "input", source_item_id: null, factor: null, buttons_only: 0 },
      { id: 2, name: "Cookie Topping (gram)", name_ar: null, code: null, step: 480, sort: 2, active: 1, kind: "input", source_item_id: null, factor: null, buttons_only: 1 },
    ];
    k.stores = [
      { id: 1, name: "Rawabi", name_ar: null, region: null, sort: 1, active: 1, pin: null },
      { id: 2, name: "Nadwa, North", name_ar: null, region: null, sort: 2, active: 1, pin: null },
    ];
    k.email = { enabled: true, api_key: "xkeysib-test", sender_email: "orders@halfm.sa", sender_name: "HM Orders", recipients: ["prod@halfm.sa", "ops@halfm.sa"], site_url: "https://hm.example", since: "2026-11-10" };
  });
  const { cfg, open_day } = await loadCfg(db);
  ctx = { db, cfg, open_day };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(brevoStatus === 201 ? '{"messageId":"x"}' : '{"message":"Key not found"}', { status: brevoStatus });
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await proxy?.dispose();
});

describe("daily order email", () => {
  it("emails the locked day once, after the cutoff", async () => {
    // 9 Nov 17:00 Riyadh: the 10 Nov sheet is open; nothing locked → nothing to send
    await rollover(ctx, T("2026-11-09T14:00:00Z"));
    expect(await sendDueDailyEmail(ctx)).toBeNull();
    await updateSheet(ctx.db, "2026-11-10", (_r, data) => {
      data.q[1] = { 1: 6, 2: 960 };
      data.sub[1] = ["entered", "x", 1];
      return { data };
    });
    // 18:30: 10 Nov locks
    await rollover(ctx, T("2026-11-09T15:30:00Z"));

    brevoStatus = 401; // Brevo rejects → error, claim released for a retry
    await expect(sendDueDailyEmail(ctx)).rejects.toThrow(/Brevo error 401: Key not found/);
    brevoStatus = 201;
    expect(await sendDueDailyEmail(ctx)).toBe("2026-11-10");
    expect(await sendDueDailyEmail(ctx)).toBeNull(); // never twice

    const sent = calls.at(-1)!;
    expect(sent.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(sent.headers["api-key"]).toBe("xkeysib-test");
    expect(sent.body.to).toEqual([{ email: "prod@halfm.sa" }, { email: "ops@halfm.sa" }]);
    expect(sent.body.sender).toEqual({ email: "orders@halfm.sa", name: "HM Orders" });
    expect(sent.body.subject).toContain("10 November 2026");
    expect(sent.body.subject).toContain("1/2 branches");
    expect(sent.body.htmlContent).toContain("No order: Nadwa, North");
    expect(sent.body.htmlContent).toContain("https://hm.example/admin/day/2026-11-10");
    const att = sent.body.attachment[0];
    expect(att.name).toBe("Mixes_Order_10_Nov.csv");
    const csv = new TextDecoder().decode(Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0)));
    expect(csv).toContain("Store,Cereal,Cookie Topping (gram)");
    expect(csv).toContain("Rawabi,6,960");
    expect(csv).toContain('"Nadwa, North",,');
    expect(csv).toContain("Total Riyadh Production,6,960");
  });

  it("does not email imported history from before the email was turned on", async () => {
    const { cfg } = await updateCfg(ctx.db, (k) => {
      k.email!.since = "2026-12-01";
    });
    ctx.cfg = cfg;
    await rollover(ctx, T("2026-11-10T15:30:00Z")); // locks 11 Nov
    expect(await sendDueDailyEmail(ctx)).toBeNull();
  });
});
