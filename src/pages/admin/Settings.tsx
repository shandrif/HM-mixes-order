import { useEffect, useState } from "react";
import type { Settings } from "../../../shared/types";
import { api, fmtDateTime } from "../../api";

export default function SettingsPage({ me, onChange }: { me: string; onChange: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState("");
  const [admins, setAdmins] = useState<{ email: string; created_at: string }[]>([]);
  const [newAdmin, setNewAdmin] = useState({ email: "", password: "" });
  const [audit, setAudit] = useState<{ id: number; at: string; actor: string; action: string; detail: string }[] | null>(null);

  const loadAdmins = () => api<typeof admins>("/admin/admins").then(setAdmins);
  useEffect(() => {
    api<Settings>("/admin/settings").then(setS);
    loadAdmins();
  }, []);

  if (!s) return <div className="center-msg">Loading…</div>;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <form
        className="card form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setS(await api<Settings>("/admin/settings", { method: "PUT", body: s }));
            setMsg("Saved.");
            onChange();
          } catch (e) {
            setMsg((e as Error).message);
          }
        }}
      >
        <h2>Ordering</h2>
        <label className="field">
          <span>Daily cutoff (Riyadh time)</span>
          <input className="input short" type="time" step={900} value={s.cutoff} onChange={(e) => setS({ ...s, cutoff: e.target.value })} />
          <small className="muted">At this time the open sheet locks and the next day opens. The check runs every 15 minutes, and entries after the cutoff are always refused.</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.require_pin} onChange={(e) => setS({ ...s, require_pin: e.target.checked })} /> Stores must enter a PIN (off = stores just pick their branch name)
        </label>
        <h2>Sheet & Excel</h2>
        <label className="field">
          <span>Totals row label</span>
          <input className="input" value={s.total_label} onChange={(e) => setS({ ...s, total_label: e.target.value })} />
        </label>
        <label className="field">
          <span>New sheet name format</span>
          <input className="input short" value={s.sheet_name_format} onChange={(e) => setS({ ...s, sheet_name_format: e.target.value })} />
          <small className="muted">MMM = Nov, MM = 11, DD = 05, D = 5, YYYY = 2026. Current workbook uses “MMM- DD”.</small>
        </label>
        <h2>Anomaly checks</h2>
        <label className="field">
          <span>Days of history to compare against</span>
          <input className="input short" type="number" min={7} max={90} value={s.history_days} onChange={(e) => setS({ ...s, history_days: Number(e.target.value) })} />
        </label>
        <div className="row-between">
          <button className="btn primary">Save settings</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </form>

      <EmailSection />

      <section className="card">
        <h2>Cutoff job</h2>
        <p className="muted">Runs automatically every 15 minutes. Use this only to apply a changed cutoff immediately.</p>
        <button
          className="btn ghost"
          onClick={async () => {
            const r = await api<{ locked: string[]; open: string }>("/admin/rollover", { body: {} });
            alert(r.locked.length ? `Locked ${r.locked.join(", ")}. Open day: ${r.open}` : `Nothing to lock. Open day: ${r.open}`);
            onChange();
          }}
        >
          Run cutoff now
        </button>
      </section>

      <section className="card">
        <h2>Admins</h2>
        <ul className="plain">
          {admins.map((a) => (
            <li key={a.email} className="row-between">
              <span>
                {a.email} {a.email === me && <span className="pill">you</span>}
              </span>
              {a.email !== me && (
                <button
                  className="btn link small"
                  onClick={async () => {
                    if (!confirm(`Remove admin ${a.email}?`)) return;
                    await api(`/admin/admins/${encodeURIComponent(a.email)}`, { method: "DELETE" });
                    loadAdmins();
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="add-row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/admin/admins", { body: newAdmin });
              setNewAdmin({ email: "", password: "" });
              loadAdmins();
            } catch (e) {
              alert((e as Error).message);
            }
          }}
        >
          <input className="input" type="email" placeholder="email" value={newAdmin.email} onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })} required />
          <input className="input" type="password" placeholder="password (8+ characters)" value={newAdmin.password} onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })} required />
          <button className="btn">Add / reset password</button>
        </form>
      </section>

      <section className="card">
        <div className="row-between">
          <h2>Activity log</h2>
          {!audit && (
            <button className="btn ghost small" onClick={() => api<NonNullable<typeof audit>>("/admin/audit").then(setAudit)}>
              Show
            </button>
          )}
        </div>
        {audit && (
          <div className="table-wrap">
            <table className="list small">
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{fmtDateTime(a.at.replace(" ", "T") + (a.at.endsWith("Z") ? "" : "Z"))}</td>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td className="mono clip">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface EmailInfo {
  enabled: boolean;
  has_key: boolean;
  key_hint: string;
  sender_email: string;
  sender_name: string;
  recipients: string[];
}

function EmailSection() {
  const [e, setE] = useState<EmailInfo | null>(null);
  const [key, setKey] = useState("");
  const [recipients, setRecipients] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<EmailInfo>("/admin/email").then((r) => {
      setE(r);
      setRecipients(r.recipients.join("\n"));
    });
  }, []);
  if (!e) return null;

  const save = async (enabled = e.enabled) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<EmailInfo>("/admin/email", { method: "PUT", body: { ...e, enabled, api_key: key, recipients } });
      setE(r);
      setKey("");
      setRecipients(r.recipients.join("\n"));
      setMsg({ ok: true, text: r.enabled ? "Saved. The order will be emailed after each cutoff." : "Saved (daily email is off)." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ day: string; recipients: string[] }>("/admin/email/test", { body: {} });
      setMsg({ ok: true, text: `Test email for ${r.day} sent to ${r.recipients.join(", ")}. Check the inbox (and spam).` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card form-grid"
      onSubmit={(ev) => {
        ev.preventDefault();
        save();
      }}
    >
      <div className="row-between">
        <h2>Daily order email</h2>
        <span className={"pill " + (e.enabled ? "open" : "")}>{e.enabled ? "On" : "Off"}</span>
      </div>
      <p className="muted small">
        After each {""}cutoff, the locked order (totals, every branch, spreadsheet attached) is emailed to the people below. Sent through your{" "}
        <a href="https://app.brevo.com" target="_blank" rel="noreferrer">
          Brevo
        </a>{" "}
        account.
      </p>
      <label className="field">
        <span>Brevo API key</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder={e.has_key ? `Saved (${e.key_hint}) — paste a new one to replace it` : "xkeysib-…"}
          value={key}
          onChange={(ev) => setKey(ev.target.value)}
        />
        <small className="muted">Brevo → your name (top right) → SMTP & API → API Keys → Generate a new API key. It is stored on the server and never shown again.</small>
      </label>
      <label className="field">
        <span>Sender email</span>
        <input className="input" type="email" placeholder="orders@halfm.sa" value={e.sender_email} onChange={(ev) => setE({ ...e, sender_email: ev.target.value })} />
        <small className="muted">Must be a verified sender in Brevo (Brevo → Senders, Domains & Dedicated IPs → Senders).</small>
      </label>
      <label className="field">
        <span>Sender name</span>
        <input className="input" value={e.sender_name} onChange={(ev) => setE({ ...e, sender_name: ev.target.value })} />
      </label>
      <label className="field">
        <span>Send to (one email per line)</span>
        <textarea className="input" rows={4} placeholder={"production@halfm.sa\nops@halfm.sa"} value={recipients} onChange={(ev) => setRecipients(ev.target.value)} />
      </label>
      {msg && <p className={msg.ok ? "ok-text" : "error"}>{msg.text}</p>}
      <div className="toolbar">
        {e.enabled ? (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => save(false)}>
            Turn off
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={() => save(true)}>
            Save & turn on
          </button>
        )}
        <button className="btn" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn ghost" disabled={busy || !e.has_key} onClick={test} title={e.has_key ? "" : "Save the API key first"}>
          Send test email now
        </button>
      </div>
    </form>
  );
}
