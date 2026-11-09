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

const NAV = [
  ["/admin", "Today"],
  ["/admin/days", "All days"],
  ["/admin/anomalies", "Anomalies"],
  ["/admin/stores", "Stores"],
  ["/admin/items", "Items"],
  ["/admin/excel", "Excel"],
  ["/admin/settings", "Settings"],
] as const;

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
          {NAV.map(([to, label]) => {
            const active = to === "/admin" ? path === "/admin" || path === "/admin/" : path.startsWith(to);
            return (
              <Link key={to} to={to} className={active ? "active" : ""}>
                {label}
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
      <main className="admin-main">{page}</main>
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
