// Daily order email through Brevo's transactional email API.
// Sent once per locked day by the cron job (every 15 minutes), so it arrives
// within minutes of the 18:30 cutoff. Costs ~3 D1 rows read and 1 written.
import { formatDayLong } from "../shared/time";
import type { Layout } from "../shared/types";
import { parseData, type Config, type EmailSettings, type Finding } from "./db";
import { layoutOf, type Ctx } from "./logic";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number | null | undefined) => (n == null ? "" : Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toFixed(2))));
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function emailReady(e: EmailSettings | undefined): e is EmailSettings {
  return !!e && e.enabled && !!e.api_key && !!e.sender_email && e.recipients.length > 0;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  csv: string;
  filename: string;
}

/** Build the email for one day's sheet. */
export async function buildDailyEmail(ctx: Ctx, day: string): Promise<BuiltEmail | null> {
  const row = await ctx.db.prepare("SELECT day, status, layout, data, found, hist, decisions, sheet_name FROM sheets WHERE day = ?").bind(day).first<{
    day: string;
    status: "open" | "locked";
    layout: string | null;
    data: string;
    found: string;
    hist: string;
    decisions: string;
    sheet_name: string | null;
  }>();
  if (!row) return null;
  const layout: Layout = layoutOf(ctx, row);
  const data = parseData(row.data);
  const decisions = JSON.parse(row.decisions) as Record<string, { status: string }>;
  const critical = (JSON.parse(row.found) as Finding[]).filter((f) => f.severity === "critical" && (!decisions[f.key] || decisions[f.key].status === "open"));

  const value = (sid: number, it: Layout["items"][number]): number | null => {
    const q = data.q[sid]?.[it.id];
    if (it.kind === "derived" && (q === undefined || q === null)) return (data.q[sid]?.[it.source_item_id ?? -1] ?? 0) * (it.factor ?? 0);
    return q ?? null;
  };
  const totals = layout.items.map((it) => layout.stores.reduce((a, s) => a + (value(s.id, it) ?? 0), 0));
  const sent = layout.stores.filter((s) => ["entered", "imported"].includes(data.sub[s.id]?.[0] ?? ""));
  const copied = layout.stores.filter((s) => data.sub[s.id]?.[0] === "carried_forward");
  const none = layout.stores.filter((s) => !data.sub[s.id]);
  const dayLong = formatDayLong(day);
  const link = ctx.cfg.email?.site_url ? `${ctx.cfg.email.site_url.replace(/\/$/, "")}/admin/day/${day}` : "";

  // CSV in the same layout as the workbook sheet (opens directly in Excel).
  const csvRows: unknown[][] = [
    ["Delivery", dayLong],
    ["Store", ...layout.items.map((i) => i.name)],
    ...layout.stores.map((s) => [s.name, ...layout.items.map((it) => fmt(value(s.id, it)))]),
    [layout.total_label, ...totals.map(fmt)],
  ];
  const csv = "﻿" + csvRows.map((r) => r.map(csvCell).join(",")).join("\r\n");

  const th = "padding:6px 8px;border:1px solid #e7ddd0;background:#84c6b2;font-size:12px;text-align:center";
  const td = "padding:5px 8px;border:1px solid #e7ddd0;font-size:13px;text-align:center";
  const tdName = "padding:5px 8px;border:1px solid #e7ddd0;font-size:13px;text-align:left;background:#f5ede3;font-weight:600";
  const html = `<!doctype html><html><body style="margin:0;background:#f7f2ea;font-family:Arial,Helvetica,sans-serif;color:#1f1a17">
<div style="max-width:900px;margin:0 auto;padding:20px">
  <div style="background:#1f1a17;color:#fff;border-radius:12px;padding:16px 20px;border-bottom:3px solid #d4b38b">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#d4b38b;font-weight:bold">Mixes order · delivery</div>
    <div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(dayLong)}</div>
    ${link ? `<a href="${esc(link)}" style="display:inline-block;margin-top:10px;background:#d4b38b;color:#1f1a17;text-decoration:none;font-weight:bold;font-size:13px;padding:8px 14px;border-radius:8px">Open this sheet in the app</a>` : ""}
  </div>
  <p style="font-size:14px;margin:16px 0 6px"><b>${sent.length}</b> branches sent their order${copied.length ? `, <b>${copied.length}</b> copied from the previous day` : ""}${none.length ? `, <b>${none.length}</b> with no order` : ""}.</p>
  ${copied.length ? `<p style="font-size:13px;color:#4a423c;margin:4px 0">Copied (did not send before the cutoff): ${copied.map((s) => esc(s.name)).join(", ")}</p>` : ""}
  ${none.length ? `<p style="font-size:13px;color:#a15c07;margin:4px 0">No order: ${none.map((s) => esc(s.name)).join(", ")}</p>` : ""}
  ${critical.length ? `<div style="background:#fde8e6;border:1px solid #f5c2bd;border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px"><b style="color:#b42318">${critical.length} possible typo(s) to check:</b><ul style="margin:6px 0 0;padding-left:18px">${critical.slice(0, 15).map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul>${link ? `<a href="${esc(link)}" style="color:#8a6431">Review in the app →</a>` : ""}</div>` : ""}
  <h3 style="font-size:15px;margin:18px 0 6px">Totals</h3>
  <table style="border-collapse:collapse;background:#fff">${layout.items.map((it, i) => `<tr><td style="${tdName}">${esc(it.name)}</td><td style="${td};font-weight:bold">${fmt(totals[i])}</td></tr>`).join("")}</table>
  <h3 style="font-size:15px;margin:18px 0 6px">By branch</h3>
  <div style="overflow-x:auto"><table style="border-collapse:collapse;background:#fff">
    <tr><th style="${th};text-align:left">Store</th>${layout.items.map((it) => `<th style="${th}">${esc(it.name)}</th>`).join("")}</tr>
    ${layout.stores.map((s) => `<tr><td style="${tdName}">${esc(s.name)}</td>${layout.items.map((it) => `<td style="${td}">${fmt(value(s.id, it))}</td>`).join("")}</tr>`).join("")}
    <tr><td style="${tdName};background:#cda371">${esc(layout.total_label)}</td>${totals.map((t) => `<td style="${td};background:#cda371;font-weight:bold">${fmt(t)}</td>`).join("")}</tr>
  </table></div>
  <p style="font-size:12px;color:#7a6f66;margin-top:18px">The spreadsheet is attached (CSV, opens in Excel).${link ? ` Full workbook: <a href="${esc(link.replace(/\/day\/.*/, "/excel"))}" style="color:#8a6431">Admin → Excel</a>.` : ""}</p>
</div></body></html>`;

  const [, m, d] = day.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return {
    subject: `Mixes order for ${dayLong} — ${sent.length + copied.length}/${layout.stores.length} branches${critical.length ? ` · ${critical.length} to check` : ""}`,
    html,
    csv,
    filename: `Mixes_Order_${d}_${mon}.csv`,
  };
}

/** Send through Brevo. Throws with Brevo's message on failure. */
export async function sendBrevo(e: EmailSettings, mail: BuiltEmail): Promise<void> {
  const bytes = new TextEncoder().encode(mail.csv);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": e.api_key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: e.sender_email, name: e.sender_name || "Mixes Order" },
      to: e.recipients.map((email) => ({ email })),
      subject: mail.subject,
      htmlContent: mail.html,
      attachment: [{ name: mail.filename, content: btoa(bin) }],
    }),
  });
  if (!res.ok) {
    let msg = `Brevo error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) msg += `: ${j.message}`;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
}

/**
 * Cron: email the most recently locked day once. Claims the day first
 * (emailed_at) so two overlapping runs never send twice; releases the claim
 * if Brevo fails so the next run retries.
 */
export async function sendDueDailyEmail(ctx: Ctx): Promise<string | null> {
  const e = ctx.cfg.email;
  if (!emailReady(e)) return null;
  const last = await ctx.db.prepare("SELECT day, status, emailed_at FROM sheets WHERE status = 'locked' AND day < ? ORDER BY day DESC LIMIT 1").bind(ctx.open_day ?? "9999-12-31").first<{ day: string; emailed_at: string | null }>();
  if (!last || last.emailed_at || last.day < e.since) return null;
  const claim = await ctx.db.prepare("UPDATE sheets SET emailed_at = ? WHERE day = ? AND emailed_at IS NULL").bind(new Date().toISOString(), last.day).run();
  if (!claim.meta.changes) return null;
  try {
    const mail = await buildDailyEmail(ctx, last.day);
    if (mail) await sendBrevo(e, mail);
    return last.day;
  } catch (err) {
    await ctx.db.prepare("UPDATE sheets SET emailed_at = NULL WHERE day = ?").bind(last.day).run();
    throw err;
  }
}

export function publicEmailSettings(cfg: Config) {
  const e = cfg.email;
  return {
    enabled: !!e?.enabled,
    has_key: !!e?.api_key,
    key_hint: e?.api_key ? "…" + e.api_key.slice(-4) : "",
    sender_email: e?.sender_email ?? "",
    sender_name: e?.sender_name ?? "Mixes Order",
    recipients: e?.recipients ?? [],
  };
}
