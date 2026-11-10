import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fmtCutoff, fmtQty, fmtTime } from "../api";
import { strings, useLang, type Lang } from "../i18n";
import { navigate } from "../router";

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
  buttons_only?: number;
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

type Toast = { id: number; kind: "ok" | "error"; text: string };
type ToastFn = (kind: Toast["kind"] | "clear", text?: string) => void;

const dayLocale = (lang: Lang) => (lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB");
const compactDay = (day: string, lang: Lang) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(dayLocale(lang), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const shortDayLabel = (day: string, lang: Lang) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(dayLocale(lang), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** Light haptic tick where supported (Android). */
const tick = () => {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not supported */
  }
};

export default function StorePage() {
  const { lang, t, toggle } = useLang();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [state, setState] = useState<"loading" | "login" | "order">("loading");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback<ToastFn>((kind, text = "") => {
    if (kind === "clear") return setToasts([]);
    const id = Date.now() + Math.random();
    setToasts([{ id, kind, text }]); // one at a time: a new message replaces the old one
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), kind === "ok" ? 2600 : 4500);
  }, []);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderData>("/store/order"));
      setState("order");
    } catch (e) {
      // 401 = not signed in (or store deactivated): show the branch picker.
      if (!(e instanceof ApiError) || e.status !== 401) console.warn(e);
      setState("login");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="m-shell">
      <header className="m-appbar">
        <div className="m-brand">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <span>{t.appName}</span>
        </div>
        <button className="m-chip-btn" onClick={toggle} aria-label="Language">
          {t.lang}
        </button>
      </header>

      {state === "loading" && <Skeleton />}
      {state === "login" && <BranchPicker lang={lang} onDone={load} onError={(m) => toast("error", m)} />}
      {state === "order" && order && (
        <OrderForm
          key={order.day + order.store.id}
          data={order}
          lang={lang}
          toast={toast}
          onReload={load}
          onSwitch={async () => {
            await api("/store/logout", { method: "POST" });
            setOrder(null);
            setState("login");
          }}
        />
      )}

      <div className="m-toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={"m-toast " + x.kind} role="status">
            {x.kind === "ok" ? "✓" : "!"} <span>{x.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <main className="m-main">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="m-skel" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </main>
  );
}

// ───────────────────────── Branch picker ─────────────────────────

function BranchPicker({ lang, onDone, onError }: { lang: Lang; onDone: () => void; onError: (m: string) => void }) {
  const t = strings(lang);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pinFor, setPinFor] = useState<PublicInfo["stores"][number] | null>(null);
  const [pin, setPin] = useState("");

  useEffect(() => {
    api<PublicInfo>("/public/info").then(setInfo, (e) => onError(e.message));
  }, [onError]);

  const label = (s: { name: string; name_ar: string | null }) => (lang === "ar" && s.name_ar ? s.name_ar : s.name);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (info?.stores ?? []).filter((s) => !n || s.name.toLowerCase().includes(n) || (s.name_ar ?? "").includes(n));
  }, [info, q]);

  const enter = async (id: number, pinValue = "") => {
    setBusyId(id);
    try {
      await api("/store/login", { body: { store_id: id, pin: pinValue } });
      tick();
      onDone();
    } catch (e) {
      onError((e as Error).message);
      setBusyId(null);
    }
  };

  return (
    <main className="m-main picker">
      {info && (
        <div className="m-hero">
          <span className="m-eyebrow">{t.orderFor}</span>
          <strong>{shortDayLabel(info.open_day, lang)}</strong>
          <span className="m-sub">
            {t.closesAt} {fmtCutoff(info.cutoff_at, lang)}
          </span>
        </div>
      )}
      <a
        className="m-preview-link"
        data-ripple
        href="/sheet"
        onClick={(e) => {
          e.preventDefault();
          navigate("/sheet");
        }}
      >
        <span className="m-preview-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span className="m-preview-text">
          <strong>{t.viewSheet}</strong>
          <small>{t.viewSheetHelp}</small>
        </span>
        <span className="m-chev" aria-hidden>
          ›
        </span>
      </a>
      <h1 className="m-title">{t.chooseStore}</h1>
      <div className="m-search">
        <span aria-hidden>⌕</span>
        <input type="search" enterKeyHint="search" placeholder={t.searchStore} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t.searchStore} />
        {q && (
          <button className="m-clear" onClick={() => setQ("")} aria-label="Clear">
            ×
          </button>
        )}
      </div>
      {info && info.stores.length === 0 && <p className="m-empty">{t.noStores}</p>}
      <ul className="m-branches" role="listbox" aria-label={t.chooseStore}>
        {list.map((s, i) => (
          <li key={s.id} style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}>
            <button
              className="m-branch"
              role="option"
              aria-selected={busyId === s.id}
              disabled={busyId !== null}
              onClick={() => {
                if (info?.require_pin) {
                  setPinFor(s);
                  setPin("");
                } else enter(s.id);
              }}
            >
              <span className="m-avatar" aria-hidden>
                {label(s).trim().charAt(0).toUpperCase()}
              </span>
              <span className="m-branch-name">{label(s)}</span>
              {busyId === s.id ? <span className="m-spinner" aria-hidden /> : <span className="m-chev" aria-hidden>›</span>}
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={!!pinFor} onClose={() => setPinFor(null)} title={pinFor ? label(pinFor) : ""}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pinFor) enter(pinFor.id, pin);
          }}
        >
          <label className="m-field">
            <span>{t.pin}</span>
            <input className="m-pin" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••" autoFocus />
            <small>{t.pinHelp}</small>
          </label>
          <button className="m-primary" disabled={pin.length < 4 || busyId !== null}>
            {t.continue}
          </button>
        </form>
      </Sheet>

      <footer className="m-foot">
        <a href="/admin">{t.admin}</a>
      </footer>
    </main>
  );
}

// ───────────────────────── Order form ─────────────────────────

function useCountdown(targetIso: string, serverNowIso: string) {
  const skew = useMemo(() => Date.parse(serverNowIso) - Date.now(), [serverNowIso]);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(id);
  }, [skew]);
  return Math.max(0, Date.parse(targetIso) - now);
}

// "+ / − only" items can't be typed, so they start at 0 instead of empty.
const blank = (i: { buttons_only?: number }) => (i.buttons_only ? "0" : "");
const isHigh = (v: number | null, last: number | null | undefined) => v != null && last != null && v > Math.max(last * 3, last + 4);

function OrderForm({ data, lang, toast, onReload, onSwitch }: { data: OrderData; lang: Lang; toast: ToastFn; onReload: () => void; onSwitch: () => void }) {
  const t = strings(lang);
  const inputs = data.items.filter((i) => i.kind === "input");
  const derived = data.items.filter((i) => i.kind === "derived");
  const initial = () => Object.fromEntries(inputs.map((i) => [i.id, data.lines[i.id] != null ? String(data.lines[i.id]) : blank(i)]));
  const [vals, setVals] = useState<Record<number, string>>(initial);
  const [saved, setSaved] = useState<Record<number, string>>(() => (data.submission?.source === "entered" ? initial() : {}));
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [missing, setMissing] = useState<number | null>(null);
  const [submittedAt, setSubmittedAt] = useState(data.submission?.source === "entered" ? data.submission.submitted_at : null);
  const left = useCountdown(data.cutoff_at, data.server_now);
  const closed = left <= 0;
  const name = (i: { name: string; name_ar: string | null }) => (lang === "ar" && i.name_ar ? i.name_ar : i.name);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const num = (id: number) => {
    const v = vals[id];
    return v === "" || v === undefined ? null : Number(v);
  };
  const filledCount = inputs.filter((i) => num(i.id) !== null && Number.isFinite(num(i.id)!)).length;
  const allFilled = filledCount === inputs.length;
  const dirty = !submittedAt || inputs.some((i) => (vals[i.id] ?? "") !== (saved[i.id] ?? ""));

  useEffect(() => {
    if (!dirty || !submittedAt) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submittedAt]);

  const stepBy = useCallback((it: OrderItem, dir: 1 | -1) => {
    setVals((p) => {
      const cur = p[it.id] === "" || p[it.id] === undefined ? 0 : Number(p[it.id]) || 0;
      const next = Math.max(0, Math.round((cur + dir * it.step) / it.step) * it.step);
      if (next === cur && p[it.id] !== "") return p;
      tick();
      return { ...p, [it.id]: String(Number(next.toFixed(3))) };
    });
  }, []);

  const openReview = () => {
    if (!allFilled) {
      const first = inputs.find((i) => num(i.id) === null);
      if (first) {
        setMissing(first.id);
        rowRefs.current[first.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => setMissing(null), 1600);
      }
      toast("error", t.fillAll);
      return;
    }
    toast("clear");
    setReviewOpen(true);
  };

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ submitted_at: string }>("/store/order", {
        method: "PUT",
        body: { day: data.day, qty: Object.fromEntries(inputs.map((i) => [i.id, num(i.id)])) },
      });
      toast("ok", submittedAt ? t.updated : t.sent);
      setSubmittedAt(r.submitted_at);
      setSaved({ ...vals });
      setReviewOpen(false);
      tick();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const countdown = h > 0 ? `${h}${t.hours} ${String(m).padStart(2, "0")}${t.minutes}` : `${m}:${String(s).padStart(2, "0")}`;
  const urgency = left < 15 * 60_000 ? "urgent" : left < 60 * 60_000 ? "soon" : "";

  return (
    <>
      <section className="m-orderbar">
        <div className="m-orderbar-row">
          <div className="m-who">
            <strong>{name(data.store)}</strong>
            <button className="m-link" onClick={onSwitch}>
              {t.switchStore}
            </button>
          </div>
          {!closed && (
            <div className={"m-timer " + urgency} aria-label={`${t.closesIn} ${countdown}`}>
              <small>{t.closesIn}</small>
              <span>{countdown}</span>
            </div>
          )}
        </div>
        <div className="m-orderbar-row sub">
          <span>
            {t.orderFor} <b>{compactDay(data.day, lang)}</b>
          </span>
          <span className={"m-status " + (submittedAt ? "ok" : "pending")}>
            {submittedAt ? `✓ ${t.submitted} ${fmtTime(submittedAt, lang === "ar" ? "ar-SA" : "en-GB")}` : t.notYet}
          </span>
        </div>
      </section>

      {closed ? (
        <main className="m-main">
          <div className="m-card center">
            <div className="m-big-icon" aria-hidden>
              🔒
            </div>
            <h2>{t.closed}</h2>
            <p className="m-muted">{t.closedHelp}</p>
            <button className="m-primary" onClick={onReload}>
              {t.reload}
            </button>
          </div>
        </main>
      ) : (
        <main className="m-main with-bar">
          {!submittedAt && <p className="m-note">{t.carriedNote}</p>}
          <div className="m-actions">
            <button
              className="m-chip-btn light"
              onClick={() => {
                setVals(Object.fromEntries(inputs.map((i) => [i.id, data.last[i.id] != null ? String(data.last[i.id]) : blank(i)])));
                tick();
              }}
              disabled={!Object.keys(data.last).length}
            >
              ↺ {t.copyLast}
            </button>
            <button className="m-chip-btn light" onClick={() => setVals(Object.fromEntries(inputs.map((i) => [i.id, blank(i)])))}>
              {t.clear}
            </button>
          </div>

          <div className="m-items">
            {inputs.map((it, idx) => {
              const v = num(it.id);
              const last = data.last[it.id];
              const changed = submittedAt && (vals[it.id] ?? "") !== (saved[it.id] ?? "");
              return (
                <div
                  key={it.id}
                  ref={(el) => {
                    rowRefs.current[it.id] = el;
                  }}
                  className={["m-item", v === null ? "empty" : "", missing === it.id ? "shake" : "", isHigh(v, last) ? "high" : ""].join(" ")}
                  style={{ "--i": Math.min(idx, 10) } as React.CSSProperties}
                >
                  <div className="m-item-text">
                    <span className="m-item-name">
                      {changed && <i className="m-dot" aria-label="changed" />}
                      {name(it)}
                    </span>
                    <span className="m-item-meta">
                      {last != null ? (
                        <>
                          {t.last} <b>{fmtQty(last)}</b>
                        </>
                      ) : (
                        " "
                      )}
                      {isHigh(v, last) && <em> · {t.highWarn}</em>}
                    </span>
                  </div>
                  <Stepper
                    item={it}
                    value={vals[it.id] ?? ""}
                    onStep={(d) => stepBy(it, d)}
                    onType={(raw) => setVals((p) => ({ ...p, [it.id]: raw }))}
                    onBlur={() => v !== null && setVals((p) => ({ ...p, [it.id]: String(Math.max(0, Math.round(v / it.step) * it.step)) }))}
                  />
                </div>
              );
            })}
            {derived.map((it) => {
              const src = it.source_item_id != null ? num(it.source_item_id) ?? 0 : 0;
              return (
                <div className="m-item derived" key={it.id}>
                  <div className="m-item-text">
                    <span className="m-item-name">{name(it)}</span>
                    <span className="m-item-meta">{t.calculated}</span>
                  </div>
                  <div className="m-derived">{fmtQty(src * (it.factor ?? 0))}</div>
                </div>
              );
            })}
          </div>
          <p className="m-hint">{t.holdHint}</p>
        </main>
      )}

      {!closed && (
        <div className="m-bottombar">
          <div className="m-progress" aria-label={`${filledCount} ${t.of} ${inputs.length} ${t.filled}`}>
            <div className="m-progress-track">
              <div className="m-progress-fill" style={{ transform: `scaleX(${inputs.length ? filledCount / inputs.length : 0})` }} />
            </div>
            <span>
              {filledCount}/{inputs.length} {t.filled}
            </span>
          </div>
          <button className="m-primary" onClick={openReview} disabled={!dirty}>
            {dirty ? t.review : t.noChanges}
          </button>
        </div>
      )}

      <Sheet open={reviewOpen} onClose={() => !busy && setReviewOpen(false)} title={t.reviewTitle}>
        <p className="m-muted small">
          {t.reviewHint} <b>{shortDayLabel(data.day, lang)}</b> · {name(data.store)}
        </p>
        <ul className="m-review">
          {inputs.map((it) => {
            const v = num(it.id) ?? 0;
            const high = isHigh(v, data.last[it.id]);
            return (
              <li key={it.id} className={(v === 0 ? "zero " : "") + (high ? "high" : "")}>
                <span>{name(it)}</span>
                <b>{v === 0 ? "—" : fmtQty(v)}</b>
                {high && <small>⚠ {t.highWarn}</small>}
              </li>
            );
          })}
        </ul>
        <div className="m-sheet-actions">
          <button className="m-secondary" onClick={() => setReviewOpen(false)} disabled={busy}>
            {t.back}
          </button>
          <button className="m-primary" onClick={send} disabled={busy}>
            {busy ? <span className="m-spinner light" aria-hidden /> : submittedAt ? t.sendUpdate : t.send}
          </button>
        </div>
      </Sheet>
    </>
  );
}

// ───────────────────────── Stepper (tap, or hold to repeat) ─────────────────────────

function Stepper({ item, value, onStep, onType, onBlur }: { item: OrderItem; value: string; onStep: (d: 1 | -1) => void; onType: (raw: string) => void; onBlur: () => void }) {
  const hold = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval>; repeated?: boolean }>({});
  const stop = () => {
    clearTimeout(hold.current.t);
    clearInterval(hold.current.i);
  };
  useEffect(() => stop, []);
  const press = (d: 1 | -1) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      stop();
      hold.current.repeated = false;
      hold.current.t = setTimeout(() => {
        hold.current.repeated = true;
        onStep(d);
        hold.current.i = setInterval(() => onStep(d), 110);
      }, 420);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => {
      // A hold already stepped repeatedly; the release click must not add one more.
      if (hold.current.repeated) {
        hold.current.repeated = false;
        return;
      }
      onStep(d);
    },
  });
  const n = value === "" ? null : Number(value);
  return (
    <div className={"m-stepper" + (item.buttons_only ? " locked" : "")}>
      <button type="button" className="m-step" aria-label="−" disabled={!n} {...press(-1)}>
        −
      </button>
      <input
        key={item.buttons_only ? value : "typed" /* re-mount to replay the pop animation */}
        className={"m-val" + (item.buttons_only ? " pop" : "")}
        inputMode={item.step % 1 === 0 ? "numeric" : "decimal"}
        enterKeyHint="next"
        readOnly={!!item.buttons_only}
        tabIndex={item.buttons_only ? -1 : undefined}
        aria-label={item.name}
        value={value}
        onFocus={(e) => !item.buttons_only && e.currentTarget.select()}
        onChange={(e) => onType(e.target.value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, ""))}
        onBlur={onBlur}
      />
      <button type="button" className="m-step" aria-label="+" {...press(1)}>
        +
      </button>
    </div>
  );
}

// ───────────────────────── Bottom sheet ─────────────────────────

function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else {
      setShown(false);
      const id = setTimeout(() => setMounted(false), 320);
      return () => clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted) return null;
  return (
    <div className={"m-sheet-root" + (shown ? " shown" : "")}>
      <div className="m-backdrop" onClick={onClose} />
      <div className={"m-sheet" + (drag ? " dragging" : "")} role="dialog" aria-modal="true" aria-label={title} style={drag ? { transform: `translateY(${drag}px)` } : undefined}>
        <div
          className="m-grab"
          onPointerDown={(e) => {
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            if (drag > 90) onClose();
            start.current = null;
            setDrag(0);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDrag(0);
          }}
        >
          <span />
        </div>
        {title && <h2 className="m-sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
