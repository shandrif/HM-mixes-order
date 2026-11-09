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
export async function buildOrderEmail(ctx: Ctx, day: string, note: string, sentBy: string): Promise<{ subject: string; html: string } | null> {
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
  const site = ctx.cfg.email?.site_url?.replace(/\/$/, "");

  const td = "padding:7px 12px;border-bottom:1px solid #eee3d6;font-size:14px";
  const html = `<!doctype html><html><body style="margin:0;background:#f7f2ea;font-family:Arial,Helvetica,sans-serif;color:#1f1a17">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1f1a17;border-radius:14px;padding:20px 22px;border-bottom:4px solid #d4b38b">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#d4b38b;font-weight:bold">HM · Mixes order</div>
    <div style="font-size:24px;font-weight:bold;color:#fff;margin-top:6px">Delivery ${esc(dayLong)}</div>
    <div style="font-size:13px;color:#d9cdbd;margin-top:4px">${ordered} of ${layout.stores.length} branches · reviewed and sent by ${esc(sentBy)}</div>
  </div>
  ${note ? `<div style="background:#fff;border:1px solid #e7ddd0;border-left:4px solid #d4b38b;border-radius:10px;padding:12px 16px;margin:16px 0;font-size:14px;white-space:pre-wrap">${esc(note)}</div>` : ""}
  <p style="font-size:14px;margin:18px 0 8px">The full order for every branch is in the attached Excel file. Production totals:</p>
  <table style="border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden">
    <tr><th style="text-align:left;padding:8px 12px;background:#84c6b2;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Item</th><th style="text-align:right;padding:8px 12px;background:#84c6b2;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Total</th></tr>
    ${layout.items.map((it, i) => `<tr><td style="${td}">${esc(it.name)}</td><td style="${td};text-align:right;font-weight:bold">${fmt(totals[i])}</td></tr>`).join("")}
  </table>
  <p style="font-size:12px;color:#7a6f66;margin-top:18px">Sent from HM Mixes Order${site ? ` · <a href="${esc(site)}/admin/day/${day}" style="color:#8a6431">open in the app</a>` : ""}.</p>
</div></body></html>`;
  return { subject: `HM Mixes order — delivery ${dayLong}`, html };
}

/** Send through Brevo. Throws with Brevo's message on failure. */
export async function sendBrevo(e: EmailSettings, mail: { subject: string; html: string; to: string[]; attachments?: Attachment[] }): Promise<void> {
  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": e.api_key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: e.sender_email, name: e.sender_name || "HM Mixes Order" },
      to: mail.to.map((email) => ({ email })),
      subject: mail.subject,
      htmlContent: mail.html,
      ...(mail.attachments?.length ? { attachment: mail.attachments } : {}),
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
