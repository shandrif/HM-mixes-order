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
          <input type="checkbox" checked={s.require_pin} onChange={(e) => setS({ ...s, require_pin: e.target.checked })} /> Stores must enter their PIN
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
