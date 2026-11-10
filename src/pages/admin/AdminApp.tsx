import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Link, navigate, useLocation } from "../../router";
import Anomalies from "./Anomalies";
import Dashboard from "./Dashboard";
import DayGrid from "./DayGrid";
import Days from "./Days";
import ImportExport from "./ImportExport";
import Items from "./Items";
import SettingsPage from "./Settings";
import Stores from "./Stores";

export interface Overview {
  open_day: string;
  cutoff_at: string;
  server_now: string;
  stores_active: number;
  submitted_today: number;
  anomalies: Partial<Record<"critical" | "warning" | "info", number>>;
  days: { n: number; first: string | null; last: string | null };
  has_orders: boolean;
  last_locked: { day: string; entered: number | null; carried: number | null; critical: number | null; warning: number | null; sent_at: string | null } | null;
}

// [path, label, short label for the phone tab bar, icon]
const NAV = [
  ["/admin", "Today", "Today", "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
  ["/admin/days", "All days", "Days", "M4 6h16M4 6v14h16V6M4 6V4m16 2V4M8 3v4m8-4v4M4 11h16"],
  ["/admin/anomalies", "Anomalies", "Issues", "M12 3l9.5 17h-19zM12 10v4m0 3v.01"],
  ["/admin/stores", "Stores", "Stores", "M4 10l1.5-5h13L20 10M4 10v10h16V10M4 10h16M9 20v-5h6v5"],
  ["/admin/items", "Items", "Items", "M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"],
  ["/admin/excel", "Excel", "Excel", "M6 3h9l4 4v14H6zM14 3v5h5M9 13l4 5m0-5l-4 5"],
  ["/admin/settings", "Settings", "Settings", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.4 19.6l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 14H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"],
] as const;

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function AdminApp() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [overview, setOverview] = useState<Overview | null>(null);
  const { path, search } = useLocation();

  useEffect(() => {
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
    api<{ email: string }>("/admin/me").then(
      (r) => setMe(r.email),
      () => setMe(null),
    );
  }, []);

  const refresh = useCallback(() => {
    api<Overview>("/admin/overview").then(setOverview, (e) => {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    });
  }, []);

  useEffect(() => {
    if (me) refresh();
  }, [me, refresh, path]);

  if (me === undefined) return <div className="center-msg">Loading…</div>;
  if (me === null) return <AdminLogin onDone={(e) => setMe(e)} />;

  const crit = overview?.anomalies.critical ?? 0;
  const warn = overview?.anomalies.warning ?? 0;
  const dayMatch = /^\/admin\/day\/(\d{4}-\d{2}-\d{2})/.exec(path);

  let page: React.ReactNode;
  if (dayMatch) page = <DayGrid day={dayMatch[1]} focus={new URLSearchParams(search).get("focus")} onChange={refresh} />;
  else if (path === "/admin/days") page = <Days />;
  else if (path === "/admin/anomalies") page = <Anomalies onChange={refresh} />;
  else if (path === "/admin/stores") page = <Stores />;
  else if (path === "/admin/items") page = <Items />;
  else if (path === "/admin/excel") page = <ImportExport overview={overview} onChange={refresh} />;
  else if (path === "/admin/settings") page = <SettingsPage me={me} onChange={refresh} />;
  else page = <Dashboard overview={overview} onChange={refresh} />;

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <div className="brand">
          <img src="/logo.svg" alt="" width={34} height={34} />
          <div>
            <strong>Mixes Order</strong>
            <small>Admin</small>
          </div>
        </div>
        <nav>
          {NAV.map(([to, label, short, icon]) => {
            const active = to === "/admin" ? path === "/admin" || path === "/admin/" : path.startsWith(to);
            return (
              <Link key={to} to={to} className={active ? "active" : ""} aria-current={active ? "page" : undefined} title={label}>
                <NavIcon d={icon} />
                <span className="nav-label">{label}</span>
                <span className="nav-short">{short}</span>
                {to === "/admin/anomalies" && (crit > 0 || warn > 0) && (
                  <span className={"badge " + (crit ? "critical" : "warning")} title={`${crit} critical, ${warn} warnings`}>
                    {crit || warn}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="nav-foot">
          <span className="muted small" title={me}>
            {me}
          </span>
          <button
            className="btn ghost small on-dark"
            onClick={async () => {
              await api("/admin/logout", { method: "POST" });
              setMe(null);
              navigate("/admin");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <div className="page-enter" key={path}>
          {page}
        </div>
      </main>
    </div>
  );
}

function AdminLogin({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ needs_setup: boolean }>("/admin/setup").then(
      (r) => setSetup(r.needs_setup),
      () => setSetup(false),
    );
  }, []);
  if (setup === null) return <div className="center-msg">Loading…</div>;
  return (
    <div className="login-page">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          try {
            const r = await api<{ email: string }>(setup ? "/admin/setup" : "/admin/login", { body: { email, password } });
            onDone(r.email);
            if (setup) navigate("/admin/excel");
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand dark">
          <img src="/logo.svg" alt="" width={40} height={40} />
          <div>
            <strong>Mixes Order</strong>
            <small>{setup ? "Welcome — create your admin account" : "Admin sign-in"}</small>
          </div>
        </div>
        {setup && <p className="muted">This is the first visit. Choose the email and password you will use to sign in as admin.</p>}
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>{setup ? "New password (8+ characters)" : "Password"}</span>
          <input className="input" type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "Please wait…" : setup ? "Create admin account" : "Sign in"}
        </button>
        <a className="btn link" href="/">
          ← Store ordering page
        </a>
      </form>
    </div>
  );
}
