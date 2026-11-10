import { useCallback, useEffect, useState } from "react";
import type { Item } from "../../../shared/types";
import { api } from "../../api";

type Draft = { name: string; name_ar: string; code: string; step: string; kind: "input" | "derived"; source_item_id: string; factor: string; buttons_only: boolean };
const empty: Draft = { name: "", name_ar: "", code: "", step: "1", kind: "input", source_item_id: "", factor: "", buttons_only: false };

const toBody = (d: Draft) => ({
  name: d.name,
  name_ar: d.name_ar || null,
  code: d.code || null,
  step: Number(d.step) || 1,
  buttons_only: d.buttons_only ? 1 : 0,
  kind: d.kind,
  source_item_id: d.kind === "derived" ? Number(d.source_item_id) || null : null,
  factor: d.kind === "derived" ? Number(d.factor) : null,
});

export default function Items() {
  const [rows, setRows] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    api<Item[]>("/admin/items").then(setRows);
  }, []);
  useEffect(load, [load]);

  if (!rows) return <div className="center-msg">Loading…</div>;
  const active = rows.filter((r) => r.active);
  const inputs = active.filter((r) => r.kind === "input");

  const save = async (id: number, d: Draft, extra: Partial<Item> = {}) => {
    try {
      setErr("");
      await api(`/admin/items/${id}`, { method: "PUT", body: { ...toBody(d), ...extra } });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const move = async (idx: number, dir: -1 | 1) => {
    const list = [...active];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    await api("/admin/items/reorder", { body: { ids: list.map((r) => r.id) } });
    load();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Items</h1>
          <p className="muted">
            Order here = column order. <strong>Entered</strong> items are typed by stores. <strong>Calculated</strong> items work like the Cookie/Pecan columns: <code>source item × multiplier</code> (the multiplier is the value in row 3 of the sheet), and are exported as real Excel formulas.
          </p>
        </div>
      </header>
      {err && <p className="error">{err}</p>}

      <form
        className="card add-row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setErr("");
            await api("/admin/items", { body: toBody(draft) });
            setDraft(empty);
            load();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <strong>Add item</strong>
        <ItemFields d={draft} set={setDraft} inputs={inputs} />
        <button className="btn primary">Add</button>
      </form>

      <div className="table-wrap card flush">
        <table className="list edit stack">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {active.map((it, i) => (
              <ItemRow key={it.id} it={it} idx={i} last={i === active.length - 1} inputs={inputs.filter((x) => x.id !== it.id)} onSave={save} onMove={move} />
            ))}
          </tbody>
        </table>
      </div>

      {rows.some((r) => !r.active) && (
        <details className="card">
          <summary>Inactive items ({rows.filter((r) => !r.active).length})</summary>
          <ul className="plain">
            {rows
              .filter((r) => !r.active)
              .map((it) => (
                <li key={it.id} className="row-between">
                  <span>{it.name}</span>
                  <button className="btn link small" onClick={() => save(it.id, fromItem(it), { active: 1 })}>
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

const fromItem = (it: Item): Draft => ({
  name: it.name,
  name_ar: it.name_ar ?? "",
  code: it.code ?? "",
  step: String(it.step),
  kind: it.kind,
  source_item_id: it.source_item_id ? String(it.source_item_id) : "",
  factor: it.factor != null ? String(it.factor) : "",
  buttons_only: !!it.buttons_only,
});

function ItemRow({ it, idx, last, inputs, onSave, onMove }: { it: Item; idx: number; last: boolean; inputs: Item[]; onSave: (id: number, d: Draft, extra?: Partial<Item>) => void; onMove: (i: number, d: -1 | 1) => void }) {
  const [d, setD] = useState<Draft>(fromItem(it));
  const dirty = JSON.stringify(d) !== JSON.stringify(fromItem(it));
  return (
    <tr>
      <td className="nowrap row-move" data-label="Column order">
        <button className="icon-btn" disabled={idx === 0} onClick={() => onMove(idx, -1)} aria-label="Move left">
          ↑
        </button>
        <button className="icon-btn" disabled={last} onClick={() => onMove(idx, 1)} aria-label="Move right">
          ↓
        </button>
      </td>
      <td data-label="Item">
        <div className="item-fields">
          <ItemFields d={d} set={setD} inputs={inputs} />
        </div>
      </td>
      <td className="nowrap row-actions">
        {dirty && (
          <button className="btn small primary" onClick={() => onSave(it.id, d)}>
            Save
          </button>
        )}
        <button
          className="btn small ghost"
          onClick={() => {
            if (confirm(`Remove "${it.name}" from new sheets? Past days keep it.`)) onSave(it.id, d, { active: 0 });
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function ItemFields({ d, set, inputs }: { d: Draft; set: (d: Draft) => void; inputs: Item[] }) {
  return (
    <>
      <input className="input grow" placeholder="Item name" value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} required />
      <input className="input" dir="rtl" placeholder="الاسم بالعربي" value={d.name_ar} onChange={(e) => set({ ...d, name_ar: e.target.value })} />
      <select className="input" value={d.kind} onChange={(e) => set({ ...d, kind: e.target.value as Draft["kind"] })} aria-label="Type">
        <option value="input">Entered by store</option>
        <option value="derived">Calculated</option>
      </select>
      {d.kind === "input" ? (
        <>
          <input className="input short" placeholder="Code / SKU" value={d.code} onChange={(e) => set({ ...d, code: e.target.value })} />
          <label className="inline" title="Quantities must be a multiple of this; the + / − buttons move by it (e.g. 0.5 for tubs, 480 for grams).">
            step
            <input className="input short" inputMode="decimal" value={d.step} onChange={(e) => set({ ...d, step: e.target.value })} />
          </label>
          <label className="check small" title="Stores can only tap + / −; they cannot type a number.">
            <input type="checkbox" checked={d.buttons_only} onChange={(e) => set({ ...d, buttons_only: e.target.checked })} /> + / − only
          </label>
        </>
      ) : (
        <>
          <label className="inline">
            =
            <select className="input" value={d.source_item_id} onChange={(e) => set({ ...d, source_item_id: e.target.value })} required>
              <option value="">source item…</option>
              {inputs.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            ×
            <input className="input short" inputMode="decimal" placeholder="480" value={d.factor} onChange={(e) => set({ ...d, factor: e.target.value })} required />
          </label>
        </>
      )}
    </>
  );
}
