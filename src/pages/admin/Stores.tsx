import { useCallback, useEffect, useState } from "react";
import type { Store } from "../../../shared/types";
import { api } from "../../api";

export default function Stores() {
  const [rows, setRows] = useState<Store[] | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [draft, setDraft] = useState({ name: "", name_ar: "", region: "" });
  const [err, setErr] = useState("");
  const [pinsOn, setPinsOn] = useState(false);

  const load = useCallback(() => {
    api<Store[]>("/admin/stores").then(setRows);
    api<{ require_pin: boolean }>("/admin/settings").then((s) => setPinsOn(s.require_pin));
  }, []);
  useEffect(load, [load]);

  const update = async (s: Store, patch: Partial<Store>) => {
    try {
      setErr("");
      await api(`/admin/stores/${s.id}`, { method: "PUT", body: { name: s.name, name_ar: s.name_ar, region: s.region, ...patch } });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const active = (rows ?? []).filter((r) => r.active);
    const j = idx + dir;
    if (j < 0 || j >= active.length) return;
    [active[idx], active[j]] = [active[j], active[idx]];
    await api("/admin/stores/reorder", { body: { ids: active.map((r) => r.id) } });
    load();
  };

  const downloadPins = () => {
    const lines = [["Store", "PIN"], ...(rows ?? []).filter((r) => r.active).map((r) => [r.name, r.pin ?? ""])];
    const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "store-pins.csv";
    a.click();
  };

  if (!rows) return <div className="center-msg">Loading…</div>;
  const active = rows.filter((r) => r.active);
  const inactive = rows.filter((r) => !r.active);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Stores</h1>
          <p className="muted">
            Order here = row order in the sheet and Excel. Changes apply to today’s open sheet and every day after; locked days keep the names they had. Deactivated stores disappear from the order page but keep their history.
          </p>
        </div>
        {pinsOn && <div className="head-actions">
          <button className="btn ghost small" onClick={() => setShowPins((v) => !v)}>
            {showPins ? "Hide PINs" : "Show PINs"}
          </button>
          <button
            className="btn ghost small"
            onClick={async () => {
              if (!confirm("Give a new random PIN to every store that has none?")) return;
              const r = await api<{ updated: number }>("/admin/stores/generate-pins", { body: {} });
              alert(`${r.updated} store(s) got a new PIN.`);
              load();
            }}
          >
            Fill missing PINs
          </button>
          <button className="btn ghost small" onClick={downloadPins}>
            Download PIN list
          </button>
        </div>}
      </header>
      {err && <p className="error">{err}</p>}

      <form
        className="card add-row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setErr("");
            await api("/admin/stores", { body: draft });
            setDraft({ name: "", name_ar: "", region: "" });
            load();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <strong>Add store</strong>
        <input className="input" placeholder="Name (as in the sheet)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
        <input className="input" dir="rtl" placeholder="الاسم بالعربي (optional)" value={draft.name_ar} onChange={(e) => setDraft({ ...draft, name_ar: e.target.value })} />
        <input className="input" placeholder="Region (optional)" value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
        <button className="btn primary">Add</button>
      </form>

      <div className="table-wrap card flush">
        <table className="list edit">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Arabic name</th>
              <th>Region</th>
              {pinsOn && <th>PIN</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {active.map((s, i) => (
              <StoreRow key={s.id} s={s} idx={i} pinsOn={pinsOn} showPin={showPins} onSave={update} onMove={move} last={i === active.length - 1} />
            ))}
          </tbody>
        </table>
      </div>

      {inactive.length > 0 && (
        <details className="card">
          <summary>Inactive stores ({inactive.length})</summary>
          <ul className="plain">
            {inactive.map((s) => (
              <li key={s.id} className="row-between">
                <span>{s.name}</span>
                <button className="btn link small" onClick={() => update(s, { active: 1 })}>
                  Re-activate
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function StoreRow({ s, idx, pinsOn, showPin, onSave, onMove, last }: { s: Store; idx: number; pinsOn: boolean; showPin: boolean; onSave: (s: Store, p: Partial<Store>) => void; onMove: (i: number, d: -1 | 1) => void; last: boolean }) {
  const [v, setV] = useState({ name: s.name, name_ar: s.name_ar ?? "", region: s.region ?? "", pin: s.pin ?? "" });
  const dirty = v.name !== s.name || v.name_ar !== (s.name_ar ?? "") || v.region !== (s.region ?? "") || v.pin !== (s.pin ?? "");
  return (
    <tr>
      <td className="nowrap">
        <button className="icon-btn" disabled={idx === 0} onClick={() => onMove(idx, -1)} aria-label="Move up">
          ↑
        </button>
        <button className="icon-btn" disabled={last} onClick={() => onMove(idx, 1)} aria-label="Move down">
          ↓
        </button>
      </td>
      <td>
        <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </td>
      <td>
        <input className="input" dir="rtl" value={v.name_ar} onChange={(e) => setV({ ...v, name_ar: e.target.value })} />
      </td>
      <td>
        <input className="input" value={v.region} onChange={(e) => setV({ ...v, region: e.target.value })} />
      </td>
      {pinsOn && (
      <td>
        <input className="input pin-cell" type={showPin ? "text" : "password"} inputMode="numeric" value={v.pin} onChange={(e) => setV({ ...v, pin: e.target.value.replace(/\D/g, "") })} />
      </td>
      )}
      <td className="nowrap">
        {dirty && (
          <button className="btn small primary" onClick={() => onSave(s, { name: v.name, name_ar: v.name_ar || null, region: v.region || null, pin: v.pin || null })}>
            Save
          </button>
        )}
        <button
          className="btn small ghost"
          onClick={() => {
            if (confirm(`Deactivate "${s.name}"? It will no longer appear on the order page or new sheets. History is kept.`)) onSave(s, { active: 0 });
          }}
        >
          Deactivate
        </button>
      </td>
    </tr>
  );
}
