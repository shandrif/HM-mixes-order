import { useEffect, useState } from "react";
import { formatDayLong } from "../../../shared/time";
import type { DayDetail } from "../../../shared/types";
import { api, fmtCutoff, fmtDateTime, shortDay } from "../../api";
import { Link } from "../../router";
import type { Overview } from "./AdminApp";

export default function Dashboard({ overview, onChange }: { overview: Overview | null; onChange: () => void }) {
  const [day, setDay] = useState<DayDetail | null>(null);
  const prev = overview?.last_locked ?? null;

  useEffect(() => {
    if (!overview) return;
    api<DayDetail>(`/admin/days/${overview.open_day}`).then(setDay, () => setDay(null));
  }, [overview]);

  if (!overview) return <div className="center-msg">Loading…</div>;
  const noData = !overview.has_orders || overview.stores_active === 0;
  const subs = new Map((day?.submissions ?? []).map(([s, src, at]) => [s, { src, at }]));
  const stores = day?.layout.stores ?? [];
  const pending = stores.filter((s) => subs.get(s.id)?.src !== "entered");

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Open for ordering · delivery day</div>
          <h1>{formatDayLong(overview.open_day)}</h1>
          <p className="muted">
            Stores can enter quantities until <strong>{fmtCutoff(overview.cutoff_at)}</strong> (Riyadh). Then the sheet locks, missing stores get the previous day copied, checks run, and the next day opens.
          </p>
        </div>
        <Link className="btn primary" to={`/admin/day/${overview.open_day}`}>
          Open today’s sheet
        </Link>
      </header>

      {noData && (
        <div className="notice">
          No stores or history yet. Go to <Link to="/admin/excel">Excel → Import</Link> to load your current workbook, or add stores and items manually.
        </div>
      )}

      <div className="stats">
        <Stat label="Stores submitted" value={`${overview.submitted_today} / ${overview.stores_active}`} tone={overview.submitted_today >= overview.stores_active ? "ok" : undefined} />
        <Stat label="Critical anomalies" value={overview.anomalies.critical ?? 0} tone={(overview.anomalies.critical ?? 0) > 0 ? "critical" : "ok"} to="/admin/anomalies" />
        <Stat label="Warnings" value={overview.anomalies.warning ?? 0} tone={(overview.anomalies.warning ?? 0) > 0 ? "warning" : undefined} to="/admin/anomalies" />
        <Stat label="Days on record" value={overview.days.n} sub={overview.days.first ? `${shortDay(overview.days.first)} – ${shortDay(overview.days.last!)}` : undefined} to="/admin/days" />
      </div>

      {prev && (
        <section className="card">
          <h2>Last locked day · {formatDayLong(prev.day)}</h2>
          <p>
            {(prev.entered ?? 0) + (prev.carried ?? 0) === 0 ? "Imported from the workbook." : `${prev.entered} stores submitted, ${prev.carried} copied from the previous day.`}{" "}
            {(prev.critical ?? 0) + (prev.warning ?? 0) > 0 ? (
              <>
                <strong className={(prev.critical ?? 0) > 0 ? "critical-text" : "warning-text"}>
                  {prev.critical ?? 0} critical · {prev.warning ?? 0} warnings
                </strong>{" "}
                to review.
              </>
            ) : (
              "No open issues."
            )}{" "}
            {prev.sent_at ? (
              <span className="pill open">✓ Sent to factory & stores {fmtDateTime(prev.sent_at)}</span>
            ) : (
              <strong className="warning-text">Not sent to the factory yet.</strong>
            )}{" "}
            <Link to={`/admin/day/${prev.day}`}>{prev.sent_at ? "Open sheet →" : "Review & send →"}</Link>
          </p>
        </section>
      )}

      {day && stores.length > 0 && (
        <section className="card">
          <div className="row-between">
            <h2>Waiting for {pending.length} store{pending.length === 1 ? "" : "s"}</h2>
            <button className="btn ghost small" onClick={onChange}>
              Refresh
            </button>
          </div>
          <div className="chips">
            {stores.map((s) => {
              const sub = subs.get(s.id);
              return (
                <span key={s.id} className={"chip " + (sub?.src === "entered" ? "ok" : "")} title={sub ? `Submitted ${fmtDateTime(sub.at)}` : "Not submitted yet"}>
                  {sub?.src === "entered" ? "✓ " : ""}
                  {s.name}
                </span>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone, to }: { label: string; value: React.ReactNode; sub?: string; tone?: "ok" | "critical" | "warning"; to?: string }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className={"stat " + (tone ?? "")}>
      {body}
    </Link>
  ) : (
    <div className={"stat " + (tone ?? "")}>{body}</div>
  );
}
