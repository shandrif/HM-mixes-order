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

  const setAnomaly = async (ids: string[], status: "ignored" | "resolved" | "open") => {
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

      {data.status === "locked" && (
        <SendBar
          data={data}
          dirty={edits.size > 0}
          onSent={(sent) => {
            setData({ ...data, sent });
            onChange();
          }}
        />
      )}

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

// ───────────────────────── Send the reviewed day to the factory & stores ─────────────────────────

function SendBar({ data, dirty, onSent }: { data: DayDetail; dirty: boolean; onSent: (s: NonNullable<DayDetail["sent"]>) => void }) {
  const open = data.anomalies.filter((a) => a.status === "open");
  const crit = open.filter((a) => a.severity === "critical").length;
  const warn = open.filter((a) => a.severity === "warning").length;
  const [panel, setPanel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [recipients, setRecipients] = useState("");
  const [note, setNote] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [me, setMe] = useState("");

  useEffect(() => {
    api<{ has_key: boolean; sender_email: string; recipients: string[] }>("/admin/email").then((e) => {
      setConfigured(e.has_key && !!e.sender_email);
      setRecipients(e.recipients.join("\n"));
    });
    api<{ email: string }>("/admin/me").then((r) => setMe(r.email));
  }, []);

  const build = async () => {
    const [{ default: ExcelJS }, os, { logoPngBase64 }, prevDays] = await Promise.all([
      import("exceljs"),
      import("../../excel/orderSheet"),
      import("../../logoPng"),
      api<string[]>("/admin/export/days"),
    ]);
    const prevDay = prevDays.filter((d) => d < data.day).at(-1);
    const previous = prevDay ? await api<DayDetail>(`/admin/days/${prevDay}`) : null;
    const wb = os.buildOrderWorkbook(ExcelJS, data, { previous, sentBy: me, sentAt: new Date(), note, logoPng: await logoPngBase64() });
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    return { buf, name: os.orderFileName(data.day), base64: os.bufferToBase64(buf) };
  };

  const preview = async () => {
    setBusy("preview");
    setErr("");
    try {
      const f = await build();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = f.name;
      a.click();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (warn > 0 && !confirm(`${warn} warning(s) are still open on this day. Send anyway?`)) return;
    setBusy("send");
    setErr("");
    try {
      const f = await build();
      const r = await api<{ sent: NonNullable<DayDetail["sent"]>; to: string[] }>(`/admin/days/${data.day}/send`, {
        body: { recipients, note, filename: f.name, file_base64: f.base64 },
      });
      onSent(r.sent);
      setPanel(false);
      alert(`Sent to ${r.to.length} recipient(s).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={"send-bar" + (data.sent ? " sent" : crit ? " blocked" : " ready")}>
      <div>
        <strong>{data.sent ? "✓ Sent to factory & stores" : crit ? "Review needed before sending" : "Ready to send"}</strong>
        <span className="muted small">
          {data.sent
            ? ` ${fmtDateTime(data.sent.at)}${data.sent.by ? ` by ${data.sent.by}` : ""}. You can send again after changes.`
            : crit
              ? ` ${crit} critical issue(s) to fix or ignore${warn ? `, ${warn} warning(s)` : ""}.`
              : warn
                ? ` ${warn} warning(s) still open — check them or send anyway.`
                : " All checks are clear."}
        </span>
      </div>
      <div className="head-actions">
        <button className="btn ghost small" onClick={preview} disabled={!!busy}>
          {busy === "preview" ? "Building…" : "⤓ Preview Excel"}
        </button>
        <button className="btn primary small" onClick={() => setPanel(true)} disabled={!!busy || crit > 0 || dirty} title={dirty ? "Save your changes first" : crit ? "Fix the critical issues first" : ""}>
          {data.sent ? "Send again" : "Send to factory & stores"}
        </button>
      </div>
      {panel && (
        <div className="modal-back" onClick={() => !busy && setPanel(false)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send order">
            <h2>Send order for {formatDayLong(data.day)}</h2>
            {configured === false ? (
              <p className="notice">
                Set up the Brevo email first: <Link to="/admin/settings">Settings → Order email</Link>.
              </p>
            ) : (
              <>
                <p className="muted small">A branded Excel file (Order sheet + Factory summary) is attached to a short email with the totals.</p>
                <label className="field">
                  <span>Send to (one email per line)</span>
                  <textarea className="input" rows={5} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
                  <small className="muted">Defaults come from Settings; changes here apply to this send only.</small>
                </label>
                <label className="field">
                  <span>Note (optional, shown in the email and the Excel file)</span>
                  <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rawabi's Vanilla corrected from 40 to 4 after calling the branch." />
                </label>
              </>
            )}
            {err && <p className="error">{err}</p>}
            <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPanel(false)} disabled={!!busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={send} disabled={!!busy || configured === false || !recipients.trim()}>
                {busy === "send" ? "Sending…" : "Send now"}
              </button>
            </div>
          </div>
        </div>
      )}
      {err && !panel && <p className="error">{err}</p>}
    </div>
  );
}
