import { useCallback, useEffect, useMemo, useState } from "react";
import { RULES, type Anomaly } from "../../../shared/types";
import { api, shortDay } from "../../api";
import { Link } from "../../router";

type Row = Anomaly & { store_name: string | null; item_name: string | null };

export default function Anomalies({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState("open");
  const [sev, setSev] = useState<string>("");
  const [rule, setRule] = useState<string>("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setRows(null);
    api<Row[]>(`/admin/anomalies?status=${status}`).then((r) => {
      setRows(r);
      setSel(new Set());
    });
  }, [status]);
  useEffect(load, [load]);

  const list = useMemo(() => (rows ?? []).filter((r) => (!sev || r.severity === sev) && (!rule || r.rule === rule)), [rows, sev, rule]);
  const rulesPresent = useMemo(() => [...new Set((rows ?? []).map((r) => r.rule))], [rows]);
  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    for (const r of rows ?? []) c[r.severity]++;
    return c;
  }, [rows]);

  const act = async (st: "resolved" | "ignored" | "open") => {
    let note: string | undefined;
    if (st === "ignored") {
      const r = prompt(`Ignore ${sel.size} item(s). Reason (optional):`, "");
      if (r === null) return;
      note = r || undefined;
    }
    await api("/admin/anomalies/bulk", { body: { ids: [...sel], status: st, note } });
    load();
    onChange();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Anomalies</h1>
          <p className="muted">
            Problems found in today’s orders and in the history you imported. <strong>Critical</strong> issues block the Excel download until they are fixed or ignored. Fixing a cell on the sheet closes its issue automatically.
          </p>
        </div>
      </header>
      <div className="toolbar wrap">
        <div className="seg">
          {["open", "ignored", "resolved", "all"].map((s) => (
            <button key={s} className={s === status ? "on" : ""} onClick={() => setStatus(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <select className="input" value={sev} onChange={(e) => setSev(e.target.value)}>
          <option value="">All severities ({rows?.length ?? 0})</option>
          <option value="critical">Critical ({counts.critical})</option>
          <option value="warning">Warning ({counts.warning})</option>
          <option value="info">Info ({counts.info})</option>
        </select>
        <select className="input" value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">All types</option>
          {rulesPresent.map((r) => (
            <option key={r} value={r}>
              {RULES[r]?.label ?? r}
            </option>
          ))}
        </select>
        {sel.size > 0 && (
          <span className="bulk">
            {sel.size} selected
            {status !== "resolved" && (
              <button className="btn small" onClick={() => act("resolved")}>
                Mark fixed
              </button>
            )}
            {status !== "ignored" && (
              <button className="btn small ghost" onClick={() => act("ignored")}>
                Ignore
              </button>
            )}
            {status !== "open" && (
              <button className="btn small ghost" onClick={() => act("open")}>
                Reopen
              </button>
            )}
          </span>
        )}
      </div>
      {!rows ? (
        <div className="center-msg">Loading…</div>
      ) : (
        <div className="table-wrap card flush">
          <table className="list stack">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={list.length > 0 && list.every((r) => sel.has(r.id))}
                    onChange={(e) => setSel(e.target.checked ? new Set(list.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th>Severity</th>
                <th>Day</th>
                <th>Type</th>
                <th>Details</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 500).map((r) => (
                <tr key={r.id}>
                  <td className="card-check">
                    <input
                      type="checkbox"
                      aria-label="Select"
                      checked={sel.has(r.id)}
                      onChange={(e) =>
                        setSel((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(r.id);
                          else n.delete(r.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="card-inline">
                    <span className={"sev " + r.severity}>{r.severity}</span>
                  </td>
                  <td className="nowrap card-inline">{shortDay(r.day)}</td>
                  <td className="card-inline card-strong" title={RULES[r.rule]?.help}>{RULES[r.rule]?.label ?? r.rule}</td>
                  <td className="card-body">
                    {r.message}
                    {r.note && <div className="muted small">Note: {r.note}</div>}
                  </td>
                  <td className="card-link">
                    <Link to={`/admin/day/${r.day}${r.store_id != null && r.item_id != null ? `?focus=${r.store_id}:${r.item_id}` : ""}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 500 && <p className="muted pad">Showing the first 500 of {list.length}. Use the filters to narrow down.</p>}
          {list.length === 0 && <p className="muted pad">Nothing here. 🎉</p>}
        </div>
      )}
    </div>
  );
}
