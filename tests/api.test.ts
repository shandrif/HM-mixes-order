// End-to-end API test through the Worker's fetch handler on a local D1, with a
// meter on every database call to prove the per-request row budget that keeps
// the free plan's daily limits out of reach.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { MAX_SENDS_PER_STORE_PER_DAY } from "../worker/db";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
const m = { read: 0, written: 0 };

function meter(db: D1Database): D1Database {
  const add = (r: { meta?: { rows_read?: number; rows_written?: number } }) => {
    m.read += r?.meta?.rows_read ?? 0;
    m.written += r?.meta?.rows_written ?? 0;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (k === "all" || k === "run") return async () => { const r = await (t as any)[k](); add(r); return r; };
        if (k === "first") return async (col?: string) => { const r = await t.all(); add(r); const row = (r.results[0] ?? null) as any; return col && row ? row[col] : row; };
        if (k === "__inner") return t;
        const v = (t as any)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch") return async (st: any[]) => { const r = await t.batch(st.map((x) => x.__inner ?? x)); r.forEach(add); return r; };
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

let env: { DB: D1Database; ASSETS: Fetcher };
const jar: Record<string, string> = {};
const waits: Promise<unknown>[] = [];
async function call(path: string, opts: { method?: string; body?: unknown; who?: "admin" | "store" } = {}) {
  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.cookie = cookie;
  const req = new Request("http://local/api" + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}) });
  const res = await worker.fetch(req, env as any, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const [k, v] = kv.split("=");
    jar[k] = v;
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const settle = async () => { await Promise.all(waits.splice(0)); };

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: mkdtempSync(join(tmpdir(), "hm-api-")) } });
  env = { DB: meter(proxy.env.DB), ASSETS: {} as Fetcher };
}, 60_000);
afterAll(async () => { await proxy?.dispose(); });

describe("API on one-row-per-day storage", () => {
  it("sets up, takes orders within a tiny row budget, and caps sends", async () => {
    expect((await call("/admin/setup")).json.needs_setup).toBe(true);
    expect((await call("/admin/setup", { body: { email: "owner@hm.sa", password: "secret-pass-1" } })).status).toBe(200);
    expect((await call("/admin/setup", { body: { email: "x@y.z", password: "secret-pass-2" } })).status).toBe(403);

    // 70 stores × 11 items, like production
    for (let i = 1; i <= 11; i++) await call("/admin/items", { body: { name: "Item " + i, step: 1 } });
    for (let i = 1; i <= 70; i++) await call("/admin/stores", { body: { name: "Store " + i } });

    m.read = m.written = 0;
    const info = (await call("/public/info")).json;
    expect(info.stores).toHaveLength(70);
    const infoReads = m.read;

    // Signed-out probes answer null (no 401 in the browser console).
    expect((await call("/store/order?probe=1")).json).toBeNull();
    expect((await call("/session/admin")).json).toEqual({ email: "owner@hm.sa" });
    const savedAdmin = jar.hm_admin;
    delete jar.hm_admin;
    expect((await call("/session/admin")).json).toBeNull();
    jar.hm_admin = savedAdmin;

    m.read = m.written = 0;
    expect((await call("/store/login", { body: { store_id: 5 } })).status).toBe(200);
    const loginReads = m.read;

    m.read = m.written = 0;
    const order = (await call("/store/order")).json;
    expect(order.items).toHaveLength(11);
    const getReads = m.read;

    const qty = Object.fromEntries(order.items.map((i: { id: number }) => [i.id, 2]));
    m.read = m.written = 0;
    const put = await call("/store/order", { method: "PUT", body: { day: order.day, qty } });
    expect(put.status).toBe(200);
    const putReads = m.read;
    const putWrites = m.written;
    await settle();
    const withCheck = m.read;

    console.log({ infoReads, loginReads, getReads, putReads, putWrites, putPlusCheckReads: withCheck, writesIncludingCheck: m.written });
    // Public requests read a handful of rows — 100k requests/day (the Worker's own
    // free limit) × this budget stays far below 5M reads.
    expect(infoReads).toBeLessThanOrEqual(5);
    expect(loginReads).toBeLessThanOrEqual(5);
    expect(getReads).toBeLessThanOrEqual(5);
    expect(putReads).toBeLessThanOrEqual(5);
    expect(putWrites).toBeLessThanOrEqual(2);
    expect(withCheck).toBeLessThanOrEqual(40);

    // Read-only sheet for the store link: no sign-in, a couple of rows read
    const jarCopy = { ...jar };
    for (const k of Object.keys(jar)) delete jar[k];
    m.read = m.written = 0;
    const sheet = (await call("/public/sheet?which=open")).json;
    expect(m.read).toBeLessThanOrEqual(4);
    expect(m.written).toBe(0);
    expect(sheet.day).toBe(order.day);
    expect(sheet.stores).toHaveLength(70);
    const s5 = sheet.stores.find((s: { id: number }) => s.id === 5);
    expect(s5.status).toBe("entered");
    expect(s5.q).toEqual(Array(11).fill(2));
    expect(sheet.stores.find((s: { id: number }) => s.id === 6).status).toBeNull();
    expect((await call("/public/sheet?which=last")).json.day).toBeNull(); // nothing locked yet
    // read-only: there is no write endpoint for it, and store writes still need a session
    expect((await call("/store/order", { method: "PUT", body: { day: order.day, qty } })).status).toBe(401);
    Object.assign(jar, jarCopy);

    // The order landed; resending updates it
    const again = (await call("/store/order")).json;
    expect(again.lines[order.items[0].id]).toBe(2);
    expect(again.submission.source).toBe("entered");

    // Admin sees it and the day summary counter
    const days = (await call("/admin/days")).json;
    expect(days[0].entered).toBe(1);
    const detail = (await call(`/admin/days/${order.day}`)).json;
    expect(detail.lines.filter((l: unknown[]) => l[0] === 5)).toHaveLength(11);

    // Wrong day is refused
    expect((await call("/store/order", { method: "PUT", body: { day: "2020-01-01", qty } })).status).toBe(409);

    // Send cap: bump the counter to the cap and confirm the next send is refused
    await proxy.env.DB.prepare(`UPDATE sheets SET data = json_set(data, '$.sub."5"[2]', ${MAX_SENDS_PER_STORE_PER_DAY}) WHERE day = ?`).bind(order.day).run();
    expect((await call("/store/order", { method: "PUT", body: { day: order.day, qty } })).status).toBe(429);
    await settle();
  }, 120_000);
});
