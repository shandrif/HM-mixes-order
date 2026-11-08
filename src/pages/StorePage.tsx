import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDayLong } from "../../shared/time";
import { api, ApiError, fmtQty, fmtTime } from "../api";
import { strings, useLang } from "../i18n";

interface PublicInfo {
  open_day: string;
  cutoff_at: string;
  server_now: string;
  require_pin: boolean;
  stores: { id: number; name: string; name_ar: string | null; region: string | null }[];
}

interface OrderItem {
  id: number;
  name: string;
  name_ar: string | null;
  code: string | null;
  step: number;
  kind: "input" | "derived";
  source_item_id: number | null;
  factor: number | null;
}

interface OrderData {
  store: { id: number; name: string; name_ar: string | null };
  day: string;
  cutoff_at: string;
  server_now: string;
  items: OrderItem[];
  lines: Record<string, number | null>;
  last: Record<string, number | null>;
  submission: { source: string; submitted_at: string } | null;
}

export default function StorePage() {
  const { lang, t, toggle } = useLang();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [state, setState] = useState<"loading" | "login" | "order">("loading");

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderData>("/store/order"));
      setState("order");
    } catch (e) {
      // 401 = not signed in (or store deactivated): show the store picker.
      if (!(e instanceof ApiError) || e.status !== 401) console.warn(e);
      setState("login");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="store-shell">
      <header className="store-top">
        <div className="brand">
          <img src="/logo.svg" alt="" width={36} height={36} />
          <span>{t.appName}</span>
        </div>
        <button className="btn ghost small on-dark" onClick={toggle}>
          {t.lang}
        </button>
      </header>
      {state === "loading" && <div className="center-msg">…</div>}
      {state === "login" && <Login lang={lang} onDone={load} />}
      {state === "order" && order && (
        <OrderForm
          key={order.day + order.store.id}
          data={order}
          lang={lang}
          onReload={load}
          onSwitch={async () => {
            await api("/store/logout", { method: "POST" });
            setOrder(null);
            setState("login");
          }}
        />
      )}
      <footer className="store-foot">
        <a href="/admin">{t.admin}</a>
      </footer>
    </div>
  );
}

function Login({ lang, onDone }: { lang: "en" | "ar"; onDone: () => void }) {
  const t = strings(lang);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [q, setQ] = useState("");
  const [storeId, setStoreId] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicInfo>("/public/info").then(setInfo, (e) => setErr(e.message));
  }, []);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (info?.stores ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.name_ar ?? "").includes(needle));
  }, [info, q]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeId) return;
    setBusy(true);
    setErr("");
    try {
      await api("/store/login", { body: { store_id: storeId, pin } });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selected = info?.stores.find((s) => s.id === storeId);
  return (
    <main className="store-main">
      <form className="card login-card" onSubmit={submit}>
        <h1>{t.chooseStore}</h1>
        {info && (
          <p className="muted">
            {t.orderFor} <strong>{formatDayLong(info.open_day, lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB")}</strong> · {t.closesAt} {fmtTime(info.cutoff_at, lang === "ar" ? "ar-SA" : "en-GB")}
          </p>
        )}
        {info && info.stores.length === 0 && <p className="notice">{t.noStores}</p>}
        <input className="input" placeholder={t.searchStore} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t.searchStore} />
        <div className="store-list" role="listbox" aria-label={t.chooseStore}>
          {list.map((s) => (
            <button
              type="button"
              key={s.id}
              role="option"
              aria-selected={s.id === storeId}
              className={"store-option" + (s.id === storeId ? " selected" : "")}
              onClick={() => setStoreId(s.id)}
            >
              {lang === "ar" && s.name_ar ? s.name_ar : s.name}
            </button>
          ))}
        </div>
        {info?.require_pin && (
          <label className="field">
            <span>
              {t.pin} {selected && <b>· {selected.name}</b>}
            </span>
            <input
              className="input pin"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d*"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="••••"
            />
            <small className="muted">{t.pinHelp}</small>
          </label>
        )}
        {err && <p className="error">{err}</p>}
        <button className="btn primary block" disabled={!storeId || busy || (info?.require_pin && pin.length < 4)}>
          {t.continue}
        </button>
      </form>
    </main>
  );
}

function useCountdown(targetIso: string, serverNowIso: string) {
  const skew = useMemo(() => Date.parse(serverNowIso) - Date.now(), [serverNowIso]);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(id);
  }, [skew]);
  return Math.max(0, Date.parse(targetIso) - now);
}

function OrderForm({ data, lang, onReload, onSwitch }: { data: OrderData; lang: "en" | "ar"; onReload: () => void; onSwitch: () => void }) {
  const t = strings(lang);
  const inputs = data.items.filter((i) => i.kind === "input");
  const derived = data.items.filter((i) => i.kind === "derived");
  const [vals, setVals] = useState<Record<number, string>>(() =>
    Object.fromEntries(inputs.map((i) => [i.id, data.lines[i.id] != null ? String(data.lines[i.id]) : ""])),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submittedAt, setSubmittedAt] = useState(data.submission?.source === "entered" ? data.submission.submitted_at : null);
  const left = useCountdown(data.cutoff_at, data.server_now);
  const closed = left <= 0;
  const locale = lang === "ar" ? "ar-SA" : "en-GB";
  const name = (i: { name: string; name_ar: string | null }) => (lang === "ar" && i.name_ar ? i.name_ar : i.name);

  const num = (id: number) => {
    const v = vals[id];
    return v === "" || v === undefined ? null : Number(v);
  };
  const setNum = (it: OrderItem, n: number) => {
    const v = Math.max(0, Math.round(n / it.step) * it.step);
    setVals((p) => ({ ...p, [it.id]: String(Number(v.toFixed(3))) }));
    setMsg(null);
  };
  const allFilled = inputs.every((i) => num(i.id) !== null && Number.isFinite(num(i.id)!));

  const save = async () => {
    if (!allFilled) {
      setMsg({ kind: "error", text: t.fillAll });
      return;
    }
    const high = inputs.filter((i) => {
      const last = data.last[i.id];
      const v = num(i.id)!;
      return last != null && v > Math.max(last * 3, last + 4);
    });
    if (high.length && !confirm(`${t.confirmHigh}\n\n${high.map((i) => `${name(i)}: ${num(i.id)} (${t.last}: ${fmtQty(data.last[i.id])})`).join("\n")}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ submitted_at: string }>("/store/order", {
        method: "PUT",
        body: { day: data.day, qty: Object.fromEntries(inputs.map((i) => [i.id, num(i.id)])) },
      });
      setSubmittedAt(r.submitted_at);
      setMsg({ kind: "ok", text: t.saved });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);

  return (
    <main className="store-main">
      <section className="order-head card">
        <div>
          <div className="eyebrow">{name(data.store)}</div>
          <h1>
            {t.orderFor} {formatDayLong(data.day, lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB")}
          </h1>
          <div className={"status-line " + (submittedAt ? "ok" : "pending")}>
            {submittedAt ? (
              <>
                ✓ {t.submittedAt} {fmtTime(submittedAt, locale)} — {t.canChange}
              </>
            ) : (
              <>
                {t.notSubmitted}. {t.carriedNote}
              </>
            )}
          </div>
        </div>
        <div className={"countdown" + (left < 3_600_000 ? " soon" : "")} aria-live="polite">
          {closed ? (
            <span>{t.closed}</span>
          ) : (
            <>
              <small>{t.closesIn}</small>
              <strong>
                {h > 0 && `${h}${t.hours} `}
                {m}
                {t.minutes} {h === 0 && `${String(s).padStart(2, "0")}s`}
              </strong>
              <small>
                {t.closesAt} {fmtTime(data.cutoff_at, locale)}
              </small>
            </>
          )}
        </div>
      </section>

      {closed ? (
        <section className="card center">
          <h2>{t.closed}</h2>
          <p className="muted">{t.closedHelp}</p>
          <button className="btn primary" onClick={onReload}>
            {t.reload}
          </button>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <button className="btn ghost" onClick={() => setVals(Object.fromEntries(inputs.map((i) => [i.id, data.last[i.id] != null ? String(data.last[i.id]) : ""])))} disabled={!Object.keys(data.last).length}>
              ↺ {t.copyLast}
            </button>
            <button className="btn ghost" onClick={() => setVals(Object.fromEntries(inputs.map((i) => [i.id, ""])))}>
              {t.clear}
            </button>
          </div>
          <section className="items">
            {inputs.map((it) => {
              const v = num(it.id);
              return (
                <div className={"item-row" + (v === null ? " empty" : "")} key={it.id}>
                  <div className="item-name">
                    <span>{name(it)}</span>
                    <small className="muted">
                      {it.code && <span className="code">#{it.code}</span>}
                      {data.last[it.id] != null && (
                        <span>
                          {t.last}: {fmtQty(data.last[it.id])}
                        </span>
                      )}
                    </small>
                  </div>
                  <div className="stepper">
                    <button type="button" aria-label="−" onClick={() => setNum(it, (v ?? 0) - it.step)} disabled={!v}>
                      −
                    </button>
                    <input
                      inputMode="decimal"
                      aria-label={it.name}
                      value={vals[it.id] ?? ""}
                      placeholder="–"
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d.٠-٩]/g, "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
                        setVals((p) => ({ ...p, [it.id]: raw }));
                        setMsg(null);
                      }}
                      onBlur={() => v !== null && setNum(it, v)}
                    />
                    <button type="button" aria-label="+" onClick={() => setNum(it, (v ?? 0) + it.step)}>
                      +
                    </button>
                  </div>
                </div>
              );
            })}
            {derived.map((it) => {
              const src = it.source_item_id != null ? num(it.source_item_id) ?? 0 : 0;
              return (
                <div className="item-row derived" key={it.id}>
                  <div className="item-name">
                    <span>{name(it)}</span>
                    <small className="muted">{t.calculated}</small>
                  </div>
                  <div className="derived-val">{fmtQty(src * (it.factor ?? 0))}</div>
                </div>
              );
            })}
          </section>
          <div className="submit-bar">
            {msg && <span className={msg.kind === "ok" ? "ok-text" : "error"}>{msg.text}</span>}
            <button className="btn primary big" onClick={save} disabled={busy}>
              {busy ? t.saving : submittedAt ? t.update : t.submit}
            </button>
          </div>
        </>
      )}
      <div className="center">
        <button className="btn link" onClick={onSwitch}>
          {t.switchStore}
        </button>
      </div>
    </main>
  );
}
