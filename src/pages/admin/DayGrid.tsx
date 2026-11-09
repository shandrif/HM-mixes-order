import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, formatDayLong } from "../../../shared/time";
import { RULES, type Anomaly, type DayDetail } from "../../../shared/types";
import { api, fmtCutoff, fmtDateTime, fmtQty } from "../../api";
import { Link, navigate } from "../../router";

type Edit = number | null; // null = blank (input) / back to formula (calculated)

export default function DayGrid({ day, focus, onChange }: { day: string; focus: string | null; onChange: () => void }) {
  const [data, setData] = useState<DayDetail | null>(null);
  const [err, setErr] = useState("");
  const [edits, setEdits] = useState<Map<string, Edit>>(new Map());
  const [busy, setBusy] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setErr("");
    api<DayDetail>(`/admin/days/${day}`).then(
      (d) => {
        setData(d);
        setEdits(new Map());
      },
      (e) => setErr(e.message),
    );
  }, [day]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!data || !focus) return;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`[data-cell="${focus}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      el.select?.();
    }
  }, [data, focus]);

  const base = useMemo(() => {
    const m = new Map<string, { q: number | null; src: string }>();
    for (const [s, i, q, src] of data?.lines ?? []) m.set(`${s}:${i}`, { q, src });
    return m;
  }, [data]);

  const openAnoms = useMemo(() => (data?.anomalies ?? []).filter((a) => a.status === "open"), [data]);
  const cellAnoms = useMemo(() => {
    const m = new Map<string, Anomaly[]>();
    for (const a of openAnoms) {
      if (a.store_id == null) continue;
      const k = a.item_id != null ? `${a.store_id}:${a.item_id}` : `${a.store_id}:row`;
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return m;
  }, [openAnoms]);

  if (err) return <div className="page"><p className="error">{err}</p><Link to="/admin/days">← All days</Link></div>;
  if (!data) return <div className="center-msg">Loading sheet…</div>;

  const { layout } = data;
  const subs = new Map(data.submissions.map(([s, src, at]) => [s, { src, at }]));
  const value = (s: number, i: number): number | null => {
    const k = `${s}:${i}`;
    if (edits.has(k)) return edits.get(k)!;
    return base.get(k)?.q ?? null;
  };
  const derivedValue = (s: number, it: DayDetail["layout"]["items"][number]) => {
    const k = `${s}:${it.id}`;
    const override = edits.has(k) ? edits.get(k) : base.has(k) ? base.get(k)!.q : undefined;
    if (override !== undefined && override !== null) return { v: override, override: true };
    return { v: (value(s, it.source_item_id ?? -1) ?? 0) * (it.factor ?? 0), override: false };
  };

  const setCell = (s: number, i: number, raw: string, derived: boolean) => {
    const k = `${s}:${i}`;
    const t = raw.trim();
    const n = t === "" ? null : Number(t);
    if (n !== null && !Number.isFinite(n)) return;
    const orig = base.has(k) ? base.get(k)!.q : derived ? undefined : null;
    setEdits((p) => {
      const m = new Map(p);
      if ((orig === undefined && n === null) || orig === n) m.delete(k);
      else m.set(k, n);
      return m;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      const changes = [...edits].map(([k, qty]) => {
        const [s, i] = k.split(":").map(Number);
        return { store_id: s, item_id: i, qty };
      });
      const d = await api<DayDetail>(`/admin/days/${day}/cells`, { method: "PUT", body: { changes } });
      setData(d);
      setEdits(new Map());
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setAnomaly = async (ids: number[], status: "ignored" | "resolved" | "open") => {
    let note: string | undefined;
    if (status === "ignored") {
      const r = prompt("Reason for ignoring (optional):", "");
      if (r === null) return;
      note = r || undefined;
    }
    await api("/admin/anomalies/bulk", { body: { ids, status, note } });
    load();
    onChange();
  };

  const recheck = async () => {
    setBusy(true);
    try {
      setData(await api<DayDetail>(`/admin/days/${day}/check`, { body: {} }));
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const rows = onlyIssues ? layout.stores.filter((s) => [...cellAnoms.keys()].some((k) => k.startsWith(`${s.id}:`))) : layout.stores;
  const totals = layout.items.map((it) =>
    layout.stores.reduce((acc, s) => acc + (it.kind === "derived" ? derivedValue(s.id, it).v : value(s.id, it.id) ?? 0), 0),
  );
  const sevOrder = { critical: 0, warning: 1, info: 2 } as const;
  const worst = (list: Anomaly[] | undefined) => list?.slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])[0]?.severity;
  const listed = showResolved ? data.anomalies : openAnoms;
  const storeName = (id: number | null) => layout.stores.find((s) => s.id === id)?.name ?? "";
  const itemName = (id: number | null) => layout.items.find((i) => i.id === id)?.name ?? "";

  return (
    <div className="page wide">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            Sheet “{data.sheet_name}” ·{" "}
            {data.status === "open" ? (
              <span className="pill open">Open until {fmtCutoff(data.cutoff_at)}</span>
            ) : (
              <span className="pill locked">Locked (hidden from stores)</span>
            )}
          </div>
          <h1>{formatDayLong(day)}</h1>
        </div>
        <div className="head-actions">
          <button className="btn ghost small" onClick={() => navigate(`/admin/day/${addDays(day, -1)}`)} title="Previous day">
            ←
          </button>
          <button className="btn ghost small" onClick={() => navigate(`/admin/day/${addDays(day, 1)}`)} title="Next day">
            →
          </button>
          <button className="btn ghost small" onClick={recheck} disabled={busy}>
            Re-run checks
          </button>
        </div>
      </header>

      <div className="grid-layout">
        <div>
          <div className="toolbar">
            <label className="check">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only stores with issues
            </label>
            <span className="legend">
              <i className="lg carried" /> copied from previous day <i className="lg admin" /> edited by admin <i className="lg override" /> formula overridden <i className="lg critical" /> critical{" "}
              <i className="lg warning" /> warning
            </span>
          </div>
          <div className="sheet-wrap" ref={tableRef}>
            <table className="sheet">
              <thead>
                <tr>
                  <th className="sticky-col">Store</th>
                  {layout.items.map((it) => (
                    <th key={it.id} className={it.kind === "derived" ? "derived" : ""} title={it.kind === "derived" ? `= ${itemName(it.source_item_id)} × ${it.factor}` : it.code ?? ""}>
                      {it.name}
                      <small>{it.kind === "derived" ? `× ${it.factor}` : it.code ? `#${it.code}` : ""}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const sub = subs.get(s.id);
                  const rowA = cellAnoms.get(`${s.id}:row`);
                  return (
                    <tr key={s.id}>
                      <th className={"sticky-col store-cell " + (worst(rowA) ?? "")} title={rowA?.map((a) => a.message).join("\n")}>
                        <span>{s.name}</span>
                        <small className={"sub " + (sub?.src ?? "none")}>
                          {sub?.src === "entered" ? `✓ ${fmtDateTime(sub.at)}` : sub?.src === "carried_forward" ? "↺ copied" : sub?.src === "imported" ? "imported" : "– not submitted"}
                        </small>
                      </th>
                      {layout.items.map((it) => {
                        const k = `${s.id}:${it.id}`;
                        const a = cellAnoms.get(k);
                        const sev = worst(a);
                        const edited = edits.has(k);
                        if (it.kind === "derived") {
                          const dv = derivedValue(s.id, it);
                          return (
                            <td key={it.id} className={["derived", dv.override ? "override" : "", sev ?? "", edited ? "dirty" : ""].join(" ")} title={a?.map((x) => x.message).join("\n") ?? (dv.override ? "Typed value — clear to use the formula" : "Formula")}>
                              <input
                                data-cell={k}
                                value={edited ? edits.get(k) ?? "" : dv.override ? String(dv.v) : ""}
                                placeholder={fmtQty(dv.v)}
                                onChange={(e) => setCell(s.id, it.id, e.target.value, true)}
                                inputMode="decimal"
                                aria-label={`${s.name} ${it.name}`}
                              />
                            </td>
                          );
                        }
                        const src = base.get(k)?.src;
                        const v = value(s.id, it.id);
                        return (
                          <td key={it.id} className={[src === "carried_forward" ? "carried" : "", src === "admin_edit" ? "admin" : "", sev ?? "", edited ? "dirty" : ""].join(" ")} title={a?.map((x) => x.message).join("\n")}>
                            <input
                              data-cell={k}
                              value={v === null ? "" : String(v)}
                              onChange={(e) => setCell(s.id, it.id, e.target.value, false)}
                              inputMode="decimal"
                              aria-label={`${s.name} ${it.name}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th className="sticky-col">{layout.total_label}</th>
                  {totals.map((t, i) => (
                    <td key={i}>{fmtQty(t)}</td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          {edits.size > 0 && (
            <div className="save-bar">
              <span>
                {edits.size} unsaved change{edits.size === 1 ? "" : "s"}
              </span>
              <button className="btn ghost" onClick={() => setEdits(new Map())} disabled={busy}>
                Discard
              </button>
              <button className="btn primary" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </div>

        <aside className="card issues">
          <div className="row-between">
            <h2>Issues ({openAnoms.length})</h2>
            <label className="check small">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> show closed
            </label>
          </div>
          {listed.length === 0 && <p className="muted">No issues on this day.</p>}
          {openAnoms.length > 1 && (
            <button className="btn ghost small" onClick={() => setAnomaly(openAnoms.filter((a) => a.severity !== "critical").map((a) => a.id), "ignored")}>
              Ignore all non-critical
            </button>
          )}
          <ul className="issue-list">
            {listed.map((a) => (
              <li key={a.id} className={a.severity + (a.status !== "open" ? " closed" : "")}>
                <div className="issue-head">
                  <span className={"sev " + a.severity}>{a.severity}</span>
                  <span className="rule">{RULES[a.rule]?.label ?? a.rule}</span>
                  {a.status !== "open" && <span className="pill">{a.status}</span>}
                </div>
                <p>{a.message}</p>
                {a.note && <p className="muted small">Note: {a.note}</p>}
                <div className="issue-actions">
                  {a.store_id != null && a.item_id != null && (
                    <button className="btn link small" onClick={() => navigate(`/admin/day/${day}?focus=${a.store_id}:${a.item_id}`, true)}>
                      Go to cell
                    </button>
                  )}
                  {a.status === "open" ? (
                    <>
                      <button className="btn link small" onClick={() => setAnomaly([a.id], "resolved")}>
                        Mark fixed
                      </button>
                      <button className="btn link small" onClick={() => setAnomaly([a.id], "ignored")}>
                        Ignore
                      </button>
                    </>
                  ) : (
                    <button className="btn link small" onClick={() => setAnomaly([a.id], "open")}>
                      Reopen
                    </button>
                  )}
                </div>
                {a.store_id != null && a.item_id == null && <small className="muted">{storeName(a.store_id)}</small>}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
