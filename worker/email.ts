// Order email through Brevo's transactional email API.
// The admin reviews a locked day and presses Send; the browser builds the
// branded .xlsx (free CPU) and this Worker only forwards it to Brevo.
import { formatDayLong } from "../shared/time";
import type { Layout } from "../shared/types";
import { parseData, type Config, type EmailSettings } from "./db";
import { layoutOf, type Ctx } from "./logic";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number | null | undefined) => (n == null ? "" : Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toFixed(2))));

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function emailConfigured(e: EmailSettings | undefined): e is EmailSettings {
  return !!e && !!e.api_key && !!e.sender_email;
}

export interface Attachment {
  name: string;
  content: string; // base64
}

/** Short branded email body; the full order is in the attached Excel file. */
/**
 * Links in emails only when the app runs on your own domain: spam filters
 * distrust links to free *.workers.dev / *.pages.dev hosts (often used for phishing).
 */
export function linkableSite(siteUrl: string | undefined): string | null {
  if (!siteUrl) return null;
  try {
    const u = new URL(siteUrl);
    if (/\.(workers|pages)\.dev$/i.test(u.hostname) || u.hostname === "localhost") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function buildOrderEmail(ctx: Ctx, day: string, note: string, sentBy: string): Promise<{ subject: string; html: string; text: string } | null> {
  const row = await ctx.db.prepare("SELECT status, layout, data FROM sheets WHERE day = ?").bind(day).first<{ status: "open" | "locked"; layout: string | null; data: string }>();
  if (!row) return null;
  const layout: Layout = layoutOf(ctx, row);
  const data = parseData(row.data);
  const value = (sid: number, it: Layout["items"][number]): number => {
    const q = data.q[sid]?.[it.id];
    if (it.kind === "derived" && (q === undefined || q === null)) return (data.q[sid]?.[it.source_item_id ?? -1] ?? 0) * (it.factor ?? 0);
    return q ?? 0;
  };
  const totals = layout.items.map((it) => layout.stores.reduce((a, s) => a + value(s.id, it), 0));
  const ordered = layout.stores.filter((s) => data.sub[s.id]).length;
  const dayLong = formatDayLong(day);
  const site = linkableSite(ctx.cfg.email?.site_url);

  // The whole order sheet, styled like the Excel file. Shared styles live in a
  // <style> block (kept small: Gmail clips emails over ~102 KB).
  const statusOf = (sid: number) => data.sub[sid]?.[0] ?? null;
  const rows = layout.stores
    .map((st, i) => {
      const status = statusOf(st.id);
      const vals = layout.items
        .map((it) => {
          const v = status ? value(st.id, it) : null;
          return v ? `<td>${fmt(v)}</td>` : `<td class=z>${status ? "–" : ""}</td>`;
        })
        .join("");
      const tag = status === "carried_forward" ? " <i>(copied)</i>" : !status ? " <i class=n>(no order)</i>" : "";
      return `<tr${i % 2 ? " class=a" : ""}><th>${esc(st.name)}${tag}</th>${vals}</tr>`;
    })
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
.s{border-collapse:collapse;background:#fff;min-width:100%;font-family:Arial,Helvetica,sans-serif}
.s td,.s th{border:1px solid #e7ddd0;padding:6px 8px;font-size:12px;text-align:center;white-space:nowrap;color:#1f1a17}
.s tbody th{text-align:left;font-weight:bold;padding:6px 10px}
.s tr.a td,.s tr.a th{background:#f5ede3}
.s td.z{color:#b9ab9a}
.s i{font-style:normal;font-weight:normal;font-size:10px;color:#3b5b8c}
.s i.n{color:#b42318}
.s thead th{background:#84c6b2;font-size:11px;vertical-align:bottom;min-width:64px;white-space:normal;border-color:#cfe6dd}
.s tfoot td{background:#cda371;font-weight:bold;font-size:13px;border-color:#c49a5c}
</style></head><body style="margin:0;background:#f7f2ea;font-family:Arial,Helvetica,sans-serif;color:#1f1a17">
<div style="max-width:1200px;margin:0 auto;padding:20px 12px">
  <div style="background:#1f1a17;border-radius:14px;padding:18px 20px;border-bottom:4px solid #d4b38b">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#d4b38b;font-weight:bold">HM · Mixes order</div>
    <div style="font-size:22px;font-weight:bold;color:#fff;margin-top:6px">Delivery ${esc(dayLong)}</div>
    <div style="font-size:13px;color:#d9cdbd;margin-top:4px">${ordered} of ${layout.stores.length} branches · reviewed and sent by ${esc(sentBy)}</div>
  </div>
  ${note ? `<div style="background:#fff;border:1px solid #e7ddd0;border-left:4px solid #d4b38b;border-radius:10px;padding:12px 16px;margin:14px 0 0;font-size:14px;white-space:pre-wrap">${esc(note)}</div>` : ""}
  <div style="overflow-x:auto;margin-top:14px">
    <table class=s cellspacing=0 cellpadding=0>
      <thead><tr><th style="text-align:left;min-width:150px">Branch</th>${layout.items.map((it) => `<th>${esc(it.name)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td style="text-align:left">${esc(layout.total_label)}</td>${totals.map((t) => `<td>${fmt(t)}</td>`).join("")}</tr></tfoot>
    </table>
  </div>
  <p style="font-size:12px;color:#7a6f66;margin-top:14px">The same sheet is attached as an Excel file (with a factory production summary).${site ? ` <a href="${esc(site)}/admin/day/${day}" style="color:#8a6431">Open in the app</a>.` : ""}</p>
</div></body></html>`;
  const pad = (v: string, n: number) => (v.length >= n ? v.slice(0, n) : v + " ".repeat(n - v.length));
  const text = [
    `HM Mixes order — delivery ${dayLong}`,
    `${ordered} of ${layout.stores.length} branches · reviewed and sent by ${sentBy}`,
    note ? `\nNote: ${note}` : "",
    "",
    [pad("Branch", 24), ...layout.items.map((it) => it.name)].join(" | "),
    ...layout.stores.map((st) => [pad(st.name, 24), ...layout.items.map((it) => (statusOf(st.id) ? fmt(value(st.id, it)) || "0" : "-"))].join(" | ")),
    [pad(layout.total_label, 24), ...totals.map((t) => fmt(t))].join(" | "),
    "\nThe same sheet is attached as an Excel file.",
    site ? `Open in the app: ${site}/admin/day/${day}` : "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return { subject: `HM Mixes order — delivery ${dayLong}`, html, text };
}

/** Send through Brevo. Throws with Brevo's message on failure. */
export async function sendBrevo(e: EmailSettings, mail: { subject: string; html: string; text?: string; to: string[]; attachments?: Attachment[] }): Promise<string | null> {
  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": e.api_key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: e.sender_email, name: e.sender_name || "HM Mixes Order" },
      to: mail.to.map((email) => ({ email })),
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text ?? mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      ...(mail.attachments?.length ? { attachment: mail.attachments } : {}),
    }),
  });
  if (!res.ok) {
    let msg = `Brevo error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) msg += `: ${j.message}`;
      if (res.status === 401 && /key not found/i.test(j.message ?? ""))
        msg = "Brevo doesn't recognise the saved API key (it may be incomplete, deleted, or an SMTP key). Create a new one in Brevo → Settings → SMTP & API → API Keys (it starts with “xkeysib-”), paste it in Settings → Order email and Save.";
      else if (/sender/i.test(j.message ?? ""))
        msg = `Brevo rejected the sender address ${e.sender_email}: ${j.message}. In Brevo → Settings → Senders, Domains & Dedicated IPs, add this exact address under Senders (and make sure its domain shows “Authenticated” under Domains).`;
      else if (res.status === 401 && /ip/i.test(j.message ?? ""))
        msg = "Brevo blocked the request because of IP restrictions. In Brevo → Settings → Security → Authorised IPs, turn off “Block unknown IP addresses” for the API (Cloudflare sends from changing IPs).";
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  try {
    return ((await res.json()) as { messageId?: string }).messageId ?? null;
  } catch {
    return null;
  }
}

export interface DeliveryEvent {
  date: string;
  email: string;
  subject: string;
  event: string;
  reason: string | null;
  from: string | null;
  messageId: string | null;
}

/** Recent delivery events from Brevo (delivered, bounced, blocked, …) for this app's sender. */
export async function brevoEvents(e: EmailSettings, days = 7): Promise<DeliveryEvent[]> {
  const url = `https://api.brevo.com/v3/smtp/statistics/events?limit=100&days=${days}&sort=desc`;
  const res = await fetch(url, { headers: { "api-key": e.api_key, accept: "application/json" } });
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
  const j = (await res.json()) as { events?: Partial<DeliveryEvent>[] };
  const sender = e.sender_email.toLowerCase();
  return (j.events ?? [])
    .filter((ev) => !ev.from || ev.from.toLowerCase() === sender)
    .map((ev) => ({ date: ev.date ?? "", email: ev.email ?? "", subject: ev.subject ?? "", event: ev.event ?? "", reason: ev.reason ?? null, from: ev.from ?? null, messageId: ev.messageId ?? null }))
    .slice(0, 60);
}

export function publicEmailSettings(cfg: Config) {
  const e = cfg.email;
  return {
    has_key: !!e?.api_key,
    key_hint: e?.api_key ? "…" + e.api_key.slice(-4) : "",
    sender_email: e?.sender_email ?? "",
    sender_name: e?.sender_name ?? "HM Mixes Order",
    recipients: e?.recipients ?? [],
  };
}
