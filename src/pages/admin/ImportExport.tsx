import { useMemo, useState } from "react";
import { RULES, type DayDetail } from "../../../shared/types";
import { api } from "../../api";
import type { ParsedWorkbook } from "../../excel/importer";
import type { Overview } from "./AdminApp";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function inBatches<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export default function ImportExport({ overview, onChange }: { overview: Overview | null; onChange: () => void }) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Excel</h1>
          <p className="muted">Download the up-to-date workbook, or load your existing workbook (all sheets, including hidden ones).</p>
        </div>
      </header>
      <Export overview={overview} />
      <Import hasData={!!overview?.has_orders} onChange={onChange} />
    </div>
  );
}

function Export({ overview }: { overview: Overview | null }) {
  const [range, setRange] = useState("all");
  const [override, setOverride] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const critical = overview?.anomalies.critical ?? 0;
  const blocked = critical > 0 && !override;

  const run = async () => {
    setErr("");
    try {
      setProgress("Loading days…");
      let days = await api<string[]>("/admin/export/days");
      if (range !== "all") days = days.slice(-Number(range));
      const details: DayDetail[] = [];
      let done = 0;
      await inBatches(days, 6, async (d) => {
        details.push(await api<DayDetail>(`/admin/days/${d}`));
        setProgress(`Loading sheets ${++done} / ${days.length}…`);
      });
      setProgress("Building workbook…");
      const [{ default: ExcelJS }, { buildWorkbook, workbookToBlob }] = await Promise.all([import("exceljs"), import("../../excel/exporter")]);
      const wb = buildWorkbook(ExcelJS, details);
      const blob = await workbookToBlob(wb);
      const last = days[days.length - 1] ?? "";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = last ? `Mixes_Orders_${last.slice(8, 10)}_${MON[Number(last.slice(5, 7)) - 1]}.xlsx` : "Mixes_Orders.xlsx";
      a.click();
      setProgress(`Downloaded ${days.length} sheet(s).`);
    } catch (e) {
      setErr((e as Error).message);
      setProgress(null);
    }
  };

  return (
    <section className="card">
      <h2>Download Excel</h2>
      <p className="muted">
        Same layout as your workbook: one sheet per day, every sheet hidden except the latest, Cookie/Pecan as <code>=J4*$K$3</code>-style formulas and a SUM totals row. Cells
        where a calculated value was deliberately typed over are kept and shaded orange.
      </p>
      <div className="toolbar">
        <label className="inline">
          Sheets
          <select className="input" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="all">All days</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
      </div>
      {critical > 0 && (
        <div className="notice critical">
          <strong>{critical} critical issue(s) are still open.</strong> Fix or ignore them on the Anomalies page first.
          <label className="check">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Download anyway
          </label>
        </div>
      )}
      <button className="btn primary" onClick={run} disabled={blocked || (!!progress && !progress.startsWith("Downloaded"))}>
        ⤓ Download .xlsx
      </button>
      {progress && <p className="muted">{progress}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Import({ hasData, onChange }: { hasData: boolean; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [wbBuf, setWbBuf] = useState<ArrayBuffer | null>(null);
  const [parsed, setParsed] = useState<ParsedWorkbook | null>(null);
  const [prefer, setPrefer] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Map<string, string | null>>(new Map());
  const [replace, setReplace] = useState(false);
  // Cloudflare's free plan allows ~100k database writes a day; ~60 days of history fits comfortably.
  const [keepDays, setKeepDays] = useState("60");
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const parse = async (buf: ArrayBuffer, preferSheets: string[]) => {
    setErr("");
    setProgress("Reading workbook…");
    try {
      const [{ default: ExcelJS }, imp] = await Promise.all([import("exceljs"), import("../../excel/importer")]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const p = imp.parseWorkbook(wb, { preferSheets });
      setParsed(p);
      setMapping(imp.suggestStoreMapping(p));
      setProgress(null);
    } catch (e) {
      setErr("Could not read this file: " + (e as Error).message);
      setProgress(null);
    }
  };

  const findingCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const d of parsed?.days ?? []) for (const a of d.anomalies) c.set(a.rule, (c.get(a.rule) ?? 0) + 1);
    return [...c];
  }, [parsed]);

  const variants = useMemo(() => [...mapping].filter(([raw, to]) => raw !== to), [mapping]);

  const run = async () => {
    if (!parsed) return;
    setErr("");
    setDone(false);
    try {
      const imp = await import("../../excel/importer");
      const payload = imp.buildImportPayload(parsed, mapping);
      if (keepDays !== "all") payload.days = payload.days.slice(-Number(keepDays));
      setProgress("Creating stores and items…");
      const ids = await api<{ itemIds: Record<string, number>; storeIds: Record<string, number> }>("/admin/import/begin", {
        body: { replace, items: payload.items, stores: payload.stores },
      });
      const items = new Map(payload.items.map((i) => [i.key, i]));
      let n = 0;
      for (const d of payload.days) {
        const layout = {
          items: d.itemKeys.map((k) => {
            const it = items.get(k)!;
            return { id: ids.itemIds[k], name: it.name, code: it.code, kind: it.kind, source_item_id: it.source_key ? ids.itemIds[it.source_key] ?? null : null, factor: it.factor, step: it.step };
          }),
          stores: d.storeKeys.map((k, i) => ({ id: ids.storeIds[k], name: d.storeNamesAsShown[i] })),
          total_label: parsed.totalLabel,
        };
        await api("/admin/import/day", {
          body: {
            day: d.day,
            sheet_name: d.sheet_name,
            layout,
            lines: d.lines.map(([s, i, q]) => [ids.storeIds[s], ids.itemIds[i], q]),
            anomalies: imp.resolveAnomalies(d.anomalies, ids.storeIds, ids.itemIds),
          },
        });
        setProgress(`Importing sheets ${++n} / ${payload.days.length}…`);
      }
      await api("/admin/import/finish", { body: {} });
      // Typo/spike checks for the most recent two weeks (older history was already checked
      // for workbook problems while reading the file). Kept small to stay within D1 limits.
      const recent = payload.days.slice(-14);
      n = 0;
      for (const d of recent) {
        await api(`/admin/days/${d.day}/check`, { body: {} });
        setProgress(`Checking recent days for typos ${++n} / ${recent.length}…`);
      }
      setProgress(`Done — imported ${payload.days.length} days, ${payload.stores.filter((s) => s.active).length} stores, ${payload.items.filter((i) => i.active).length} items.`);
      setDone(true);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const conflicts = parsed?.skippedSheets.filter((s) => s.conflictWith) ?? [];
  const busy = !!progress && !done && !err && !progress.startsWith("Done");

  return (
    <section className="card">
      <h2>Import existing workbook</h2>
      <p className="muted">
        Loads every sheet (hidden too) as history, sets up stores and items from the latest sheet, and checks all of it for problems. The file is read in your browser; only the
        order data is sent to the app.
      </p>
      <input
        type="file"
        accept=".xlsx"
        onChange={async (e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          setParsed(null);
          setDone(false);
          setPrefer([]);
          if (f) {
            const buf = await f.arrayBuffer();
            setWbBuf(buf);
            parse(buf, []);
          }
        }}
      />
      {parsed && file && (
        <div className="import-preview">
          <div className="stats small">
            <div className="stat">
              <span className="stat-label">Sheets / days</span>
              <span className="stat-value">{parsed.days.length}</span>
              <span className="stat-sub">
                {parsed.days[0]?.day} → {parsed.days.at(-1)?.day}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Stores (latest sheet)</span>
              <span className="stat-value">{parsed.canonicalStores.length}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Items</span>
              <span className="stat-value">{parsed.items.filter((i) => i.active).length}</span>
              <span className="stat-sub">{parsed.items.filter((i) => !i.active).length} retired</span>
            </div>
          </div>

          <h3>Items</h3>
          <ul className="plain small">
            {parsed.items.map((i) => (
              <li key={i.key}>
                {i.active ? "" : <span className="pill">retired</span>} {i.name}{" "}
                <span className="muted">
                  {i.kind === "derived" ? `= ${parsed.items.find((x) => x.key === i.source_key)?.name} × ${i.factor}` : i.code ? `#${i.code}` : ""}
                  {i.step !== 1 ? ` · step ${i.step}` : ""}
                </span>
              </li>
            ))}
          </ul>

          {conflicts.length > 0 && (
            <>
              <h3>Sheets with the same date</h3>
              {conflicts.map((c) => (
                <div key={c.name} className="notice">
                  “{c.name}” and “{c.conflictWith}” both are {c.day}. Currently using <strong>{c.conflictWith}</strong>.{" "}
                  <button
                    className="btn small"
                    onClick={() => {
                      const p = [...prefer.filter((x) => x !== c.conflictWith), c.name];
                      setPrefer(p);
                      if (wbBuf) parse(wbBuf, p);
                    }}
                  >
                    Use “{c.name}” instead
                  </button>
                </div>
              ))}
            </>
          )}

          <h3>Store names to merge ({variants.length})</h3>
          <p className="muted small">The same store was spelled differently over time. Check each suggestion; pick “Keep separate” for stores that really are different (they’ll be kept as inactive).</p>
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>Name in old sheets</th>
                  <th>Last seen</th>
                  <th>Merge into</th>
                </tr>
              </thead>
              <tbody>
                {variants.map(([raw, to]) => (
                  <tr key={raw}>
                    <td>{raw}</td>
                    <td className="nowrap">{parsed.allStoreNames.get(raw)}</td>
                    <td>
                      <select className="input" value={to ?? ""} onChange={(e) => setMapping(new Map(mapping).set(raw, e.target.value || null))}>
                        <option value="">— Keep separate (inactive) —</option>
                        {parsed.canonicalStores.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Problems found in the workbook</h3>
          <ul className="plain small">
            {findingCounts.map(([rule, n]) => (
              <li key={rule}>
                <strong>{n}</strong> × {RULES[rule]?.label ?? rule} <span className="muted">— {RULES[rule]?.help}</span>
              </li>
            ))}
            <li className="muted">After importing, every day is also checked for typos and unusual quantities. All findings appear on the Anomalies page.</li>
          </ul>

          <label className="inline">
            History to import
            <select className="input" value={keepDays} onChange={(e) => setKeepDays(e.target.value)}>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days (recommended on the free plan)</option>
              <option value="90">Last 90 days</option>
              <option value="all">All {parsed.days.length} days (needs Cloudflare Workers Paid)</option>
            </select>
          </label>
          <p className="muted small">The free Cloudflare plan allows about 100,000 database writes per day; each day of history is ~800 rows.</p>
          {hasData && (
            <label className="check notice critical">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace ALL existing data (stores, items, days, orders) with this workbook
            </label>
          )}
          <button className="btn primary" disabled={busy || (hasData && !replace)} onClick={run}>
            Import {keepDays === "all" ? parsed.days.length : Math.min(parsed.days.length, Number(keepDays))} days
          </button>
        </div>
      )}
      {progress && <p className="muted">{progress}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
