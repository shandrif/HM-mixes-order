// Review → send: the admin sends a locked, reviewed day with the branded Excel
// file through Brevo (fetch to Brevo is mocked).
import ExcelJS from "exceljs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { buildOrderWorkbook, bufferToBase64, orderFileName } from "../src/excel/orderSheet";
import type { DayDetail } from "../shared/types";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: { DB: D1Database; ASSETS: Fetcher };
const jar: Record<string, string> = {};
const brevo: { headers: Record<string, string>; body: any }[] = [];
let brevoStatus = 201;
const realFetch = globalThis.fetch;

async function call(path: string, body?: unknown, method?: string) {
  const m = method ?? (body ? "POST" : "GET");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request("https://hm.example/api" + path, { method: m, headers, body: m === "GET" ? undefined : JSON.stringify(body ?? {}) }), env as any, { waitUntil() {}, passThroughOnException() {} } as any);
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const [k, v] = kv.split("=");
    jar[k] = v;
  }
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: mkdtempSync(join(tmpdir(), "hm-send-")) } });
  env = { DB: proxy.env.DB, ASSETS: {} as Fetcher };
  vi.stubGlobal("fetch", async (url: string | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.brevo.com/v3/smtp/statistics/events")) {
      return new Response(JSON.stringify({ events: [
        { email: "factory@halfm.sa", date: "2026-11-10T16:00:00Z", subject: "HM Mixes order", event: "blocked", reason: "sender not verified", from: "orders@halfm.sa" },
        { email: "x@y.z", date: "2026-11-10T15:00:00Z", subject: "Other app", event: "delivered", from: "someone@else.com" },
      ] }), { status: 200 });
    }
    if (String(url).startsWith("https://api.brevo.com")) {
      brevo.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return new Response(brevoStatus === 201 ? '{"messageId":"x"}' : '{"message":"Key not found"}', { status: brevoStatus });
    }
    return realFetch(url as any, init);
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await proxy?.dispose();
});

describe("review and send a day", () => {
  it("sends the branded Excel only after critical issues are handled", async () => {
    await call("/admin/setup", { email: "owner@halfm.sa", password: "secret-pass-1" });
    const begin = await call("/admin/import/begin", {
      replace: true,
      items: [
        { key: "c", name: "Cereal Latte mixture (5L gal)", code: "1624019", step: 1, kind: "input", active: 1 },
        { key: "k", name: "Cookie Topping (gram)", code: null, step: 480, kind: "input", active: 1 },
      ],
      stores: [{ key: "r", name: "Rawabi", active: 1 }, { key: "n", name: "Nadwa", active: 1 }],
    });
    const { itemIds: I, storeIds: S } = begin.json;
    const layout = { items: [{ id: I.c, name: "Cereal Latte mixture (5L gal)", code: "1624019", kind: "input", source_item_id: null, factor: null, step: 1 }, { id: I.k, name: "Cookie Topping (gram)", code: null, kind: "input", source_item_id: null, factor: null, step: 480 }], stores: [{ id: S.r, name: "Rawabi" }, { id: S.n, name: "Nadwa" }], total_label: "Total Riyadh Production" };
    for (const [day, c1, c2] of [["2026-11-04", 5, 4], ["2026-11-05", 6, 40]] as const)
      await call("/admin/import/day", {
        day, sheet_name: day, layout,
        lines: [[S.r, I.c, c1, "imported"], [S.r, I.k, 960, "imported"], [S.n, I.c, c2, "imported"], [S.n, I.k, 480, "imported"]],
        anomalies: day === "2026-11-05" ? [{ store_id: S.n, item_id: I.c, rule: "spike", severity: "critical", message: "Nadwa: Cereal = 40, usually ~4" }] : [],
      });
    await call("/admin/import/finish", {});

    // Not configured yet
    expect((await call("/admin/days/2026-11-05/send", { recipients: "f@x.sa", filename: "a.xlsx", file_base64: "AAAA" })).status).toBe(400);
    expect((await call("/admin/email", { api_key: "xkeysib-abc123", sender_email: "orders@halfm.sa", sender_name: "HM Orders", recipients: "factory@halfm.sa\nops@halfm.sa" }, "PUT")).json).toMatchObject({ has_key: true, key_hint: "…c123", recipients: ["factory@halfm.sa", "ops@halfm.sa"] });
    expect(JSON.stringify((await call("/admin/email")).json)).not.toContain("xkeysib-abc123");
    const smtp = await call("/admin/email", { api_key: "xsmtpsib-abc", sender_email: "orders@halfm.sa", recipients: "f@x.sa" }, "PUT");
    expect(smtp.status).toBe(400);
    expect(smtp.json.error).toContain("SMTP key");
    expect((await call("/admin/email")).json.key_hint).toBe("…c123"); // unchanged

    // Build the file exactly like the browser does
    const detail = (await call("/admin/days/2026-11-05")).json as DayDetail;
    const previous = (await call("/admin/days/2026-11-04")).json as DayDetail;
    const wb = buildOrderWorkbook(ExcelJS, detail, { previous, sentBy: "owner@halfm.sa", sentAt: new Date("2026-11-04T16:00:00Z"), note: "Checked with Nadwa" });
    const file_base64 = bufferToBase64((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const payload = { recipients: "factory@halfm.sa", note: "Checked with Nadwa", filename: orderFileName("2026-11-05"), file_base64 };

    // Critical issue open → refused
    const blocked = await call("/admin/days/2026-11-05/send", payload);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("critical");
    await call("/admin/anomalies/bulk", { ids: detail.anomalies.map((a) => a.id), status: "ignored", note: "confirmed by phone" });

    // Brevo error is reported, nothing marked as sent
    brevoStatus = 401;
    const failed = await call("/admin/days/2026-11-05/send", payload);
    expect(failed.status).toBe(502);
    expect(failed.json.error).toContain("doesn't recognise the saved API key");
    expect((await call("/admin/days/2026-11-05")).json.sent).toBeNull();

    brevoStatus = 201;
    const ev = (await call("/admin/email/events")).json;
    expect(ev.events).toEqual([expect.objectContaining({ email: "factory@halfm.sa", event: "blocked", reason: "sender not verified" })]); // other senders filtered out
    const ok = await call("/admin/days/2026-11-05/send", payload);
    expect(ok.status).toBe(200);
    expect((await call("/admin/days/2026-11-05")).json.sent).toMatchObject({ by: "owner@halfm.sa" });

    const sent = brevo.at(-1)!;
    expect(sent.headers["api-key"]).toBe("xkeysib-abc123");
    expect(sent.body.to).toEqual([{ email: "factory@halfm.sa" }]);
    expect(sent.body.subject).toContain("5 November 2026");
    expect(sent.body.htmlContent).toContain("Checked with Nadwa");
    expect(sent.body.htmlContent).toContain("1,440"); // Cookie total 960 + 480
    // whole sheet in the body: every branch row and the totals row
    expect(sent.body.htmlContent).toContain(">Rawabi<");
    expect(sent.body.htmlContent).toContain(">Nadwa<");
    expect(sent.body.htmlContent).toContain("Total Riyadh Production");
    expect(sent.body.textContent).toMatch(/Rawabi\s+\| 6 \| 960/);
    expect(sent.body.textContent).toMatch(/Total Riyadh Production\s+\| 46 \| 1,440/);
    expect(sent.body.htmlContent).not.toContain("workers.dev"); // site was saved from https://hm.example → links allowed
    expect(sent.body.htmlContent).toContain("https://hm.example/admin/day/2026-11-05");
    expect(sent.body.attachment[0].name).toBe("HM_Mixes_Order_05_Nov_2026.xlsx");

    // The attached workbook is the branded file
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(Uint8Array.from(atob(sent.body.attachment[0].content), (c) => c.charCodeAt(0)).buffer as ArrayBuffer);
    expect(back.worksheets.map((w) => w.name)).toEqual(["Order", "Factory summary"]);
    const order = back.getWorksheet("Order")!;
    expect(String(order.getCell("A1").value)).toContain("MIXES ORDER");
    expect(String(order.getCell("A2").value)).toContain("5 November 2026");
    const fsum = back.getWorksheet("Factory summary")!;
    const rows: unknown[][] = [];
    fsum.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    const cookie = rows.find((r) => r[1] === "Cookie Topping (gram)")!;
    expect(cookie.slice(3)).toEqual([1440, 2, 1440, 0]); // total, branches, previous, change
    const cereal = rows.find((r) => String(r[1]).startsWith("Cereal"))!;
    expect(cereal.slice(2)).toEqual([1624019, 46, 2, 9, 37]);
  }, 120_000);
});

describe("links in emails", () => {
  it("are left out while the app runs on a free workers.dev/pages.dev host", async () => {
    const { linkableSite } = await import("../worker/email");
    expect(linkableSite("https://hm-mixes-order.shelfy-help.workers.dev")).toBeNull();
    expect(linkableSite("https://x.pages.dev")).toBeNull();
    expect(linkableSite("https://orders.hmreport.com/")).toBe("https://orders.hmreport.com");
  });
});
