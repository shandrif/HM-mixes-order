import { useEffect, useMemo, useState } from "react";
import { api, fmtDateTime } from "../../api";
import { Link } from "../../router";
import { formatDayLong } from "../../../shared/time";

interface DayRow {
  day: string;
  status: "open" | "locked";
  sheet_name: string;
  locked_at: string | null;
  entered: number;
  carried: number;
  critical: number;
  warning: number;
  info: number;
}

export default function Days() {
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [q, setQ] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  useEffect(() => {
    api<DayRow[]>("/admin/days").then(setRows);
  }, []);
  const list = useMemo(
    () => (rows ?? []).filter((r) => (!q || r.day.includes(q) || r.sheet_name.toLowerCase().includes(q.toLowerCase())) && (!onlyIssues || r.critical + r.warning > 0)),
    [rows, q, onlyIssues],
  );
  if (!rows) return <div className="center-msg">Loading…</div>;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>All days</h1>
          <p className="muted">One row per sheet. Locked days are hidden from stores; only admins can open and edit them.</p>
        </div>
      </header>
      <div className="toolbar">
        <input className="input" placeholder="Filter (e.g. 2026-10 or Oct)" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only days with issues
        </label>
      </div>
      <div className="table-wrap card flush">
        <table className="list stack days-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Sheet</th>
              <th>Status</th>
              <th className="num">Submitted</th>
              <th className="num">Copied</th>
              <th>Open issues</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.day}>
                <td className="card-title">
                  <Link to={`/admin/day/${r.day}`}>{formatDayLong(r.day)}</Link>
                </td>
                <td className="mono" data-label="Sheet">{r.sheet_name}</td>
                <td data-label="Status">
                  {r.status === "open" ? <span className="pill open">Open</span> : <span className="pill locked" title={r.locked_at ? `Locked ${fmtDateTime(r.locked_at)}` : ""}>Locked</span>}
                </td>
                <td className="num" data-label="Submitted">{r.entered}</td>
                <td className="num" data-label="Copied">{r.carried}</td>
                <td data-label="Open issues">
                  {r.critical > 0 && <span className="sev critical">{r.critical} critical</span>} {r.warning > 0 && <span className="sev warning">{r.warning} warning</span>}{" "}
                  {r.info > 0 && <span className="sev info">{r.info} info</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <p className="muted pad">No days match.</p>}
      </div>
    </div>
  );
}
