// Read-only order sheet for stores: everyone's order for the open day (updating
// as branches submit) or the last locked, reviewed day. No editing here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClayBackdrop } from "@/components/ClayBackdrop";
import { api, fmtCutoff, fmtDateTime, fmtQty, fmtTime } from "../api";
import { useLang, type Lang } from "../i18n";
import { navigate } from "../router";

interface SheetData {
  day: string | null;
  status: "open" | "locked";
  cutoff_at: string;
  sent_at: string | null;
  total_label: string;
  items: { id: number; name: string; name_ar: string | null; step: number }[];
  stores: { id: number; name: string; name_ar: string | null; status: string | null; at: string | null; q: (number | null)[] }[];
}

type View = "branches" | "totals" | "table";

const dayLabel = (day: string, lang: Lang) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDay = (day: string, lang: Lang) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function SheetPreview() {
  const { lang, t, toggle } = useLang();
  const [which, setWhich] = useState<"open" | "last">("open");
  const [data, setData] = useState<{ open?: SheetData; last?: SheetData }>({});
  const [view, setView] = useState<View>(() => (window.matchMedia("(min-width: 900px)").matches ? "table" : "branches"));
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async (w: "open" | "last") => {
    try {
      const d = await api<SheetData>(`/public/sheet?which=${w}`);
      setData((p) => ({ ...p, [w]: d }));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load("open");
    load("last");
  }, [load]);

  // The open sheet changes while branches order: refresh every minute while visible.
  useEffect(() => {
    if (which !== "open") return;
    const id = setInterval(() => document.visibilityState === "visible" && load("open"), 60_000);
    return () => clearInterval(id);
  }, [which, load]);

  const d = data[which];
  const name = (x: { name: string; name_ar: string | null }) => (lang === "ar" && x.name_ar ? x.name_ar : x.name);
  const stores = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (d?.stores ?? []).filter((s) => !n || s.name.toLowerCase().includes(n) || (s.name_ar ?? "").includes(n));
  }, [d, q]);
  const totals = useMemo(() => (d ? d.items.map((_, j) => d.stores.reduce((a, s) => a + (s.q[j] ?? 0), 0)) : []), [d]);
  const ordered = d ? d.stores.filter((s) => s.status).length : 0;

  return (
    <div className="m-shell">
      <ClayBackdrop />
      <header className="m-appbar">
        <button className="m-chip-btn" onClick={() => navigate("/")} aria-label={t.backToOrder}>
          ‹ {t.backToOrder}
        </button>
        <div className="m-brand">
          <span>{t.sheetTitle}</span>
        </div>
        <button className="m-chip-btn" onClick={toggle} aria-label="Language">
          {t.lang}
        </button>
      </header>

      <main className="m-main sheet-preview">
        <div className="seg sp-tabs" role="tablist">
          {(["open", "last"] as const).map((w) => (
            <button key={w} role="tab" aria-selected={which === w} className={which === w ? "on" : ""} onClick={() => setWhich(w)}>
              <span>{w === "open" ? t.nowOrdering : t.lastOrder}</span>
              {data[w]?.day && <small>{shortDay(data[w]!.day!, lang)}</small>}
            </button>
          ))}
        </div>

        {err && <p className="error">{err}</p>}
        {!d && !err && [0, 1, 2].map((i) => <div key={i} className="m-skel" />)}
        {d && !d.day && <p className="m-empty">{t.noSheet}</p>}

        {d?.day && (
          <>
            <section className="sp-head">
              <span className="m-eyebrow">
                {t.orderFor} · {t.readOnly}
              </span>
              <strong>{dayLabel(d.day, lang)}</strong>
              <span className={"sp-state " + (d.sent_at ? "sent" : d.status)}>
                {d.sent_at
                  ? `✓ ${t.sentToFactory} ${fmtDateTime(d.sent_at)}`
                  : d.status === "locked"
                    ? t.reviewedLocked
                    : `${t.stillOpen} ${fmtCutoff(d.cutoff_at, lang)}`}
              </span>
              <span className="m-sub">
                {ordered}/{d.stores.length} {t.branchesOrdered}
              </span>
            </section>

            <div className="sp-toolbar">
              <div className="seg sp-views">
                {(["branches", "totals", "table"] as const).map((v) => (
                  <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                    {v === "branches" ? t.byBranch : v === "totals" ? t.totals : t.table}
                  </button>
                ))}
              </div>
              {view !== "totals" && (
                <div className="m-search sp-search">
                  <span aria-hidden>⌕</span>
                  <input type="search" placeholder={t.searchStore} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t.searchStore} />
                </div>
              )}
            </div>

            {view === "totals" && (
              <ul className="sp-totals">
                {d.items.map((it, j) => (
                  <li key={it.id} style={{ "--i": Math.min(j, 10) } as React.CSSProperties}>
                    <span>{name(it)}</span>
                    <b>{fmtQty(totals[j])}</b>
                  </li>
                ))}
              </ul>
            )}

            {view === "branches" && (
              <div className="sp-cards">
                {stores.map((s, idx) => (
                  <article key={s.id} className={"sp-card " + (s.status ?? "none")} style={{ "--i": Math.min(idx, 10) } as React.CSSProperties}>
                    <header>
                      <strong>{name(s)}</strong>
                      <span className="sp-badge">
                        {s.status === "entered" && s.at ? `${t.ordered} ${fmtTime(s.at, lang === "ar" ? "ar-SA" : "en-GB")}` : s.status === "carried_forward" ? t.copied : s.status ? t.ordered : t.noOrder}
                      </span>
                    </header>
                    {s.status ? (
                      <dl>
                        {d.items.map((it, j) => (
                          <div key={it.id} className={s.q[j] ? "" : "zero"}>
                            <dt>{name(it)}</dt>
                            <dd>{s.q[j] ? fmtQty(s.q[j]) : "–"}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </article>
                ))}
              </div>
            )}

            {view === "table" && (
              <div className="sheet-wrap sp-table-wrap">
                <table className="sheet sp-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">{lang === "ar" ? "الفرع" : "Branch"}</th>
                      {d.items.map((it) => (
                        <th key={it.id}>{name(it)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stores.map((s) => (
                      <tr key={s.id} className={s.status ? "" : "none"}>
                        <th className="sticky-col store-cell">
                          <span>{name(s)}</span>
                          <small className={"sub " + (s.status ?? "none")}>{s.status === "carried_forward" ? t.copied : s.status ? t.ordered : t.noOrder}</small>
                        </th>
                        {s.q.map((v, j) => (
                          <td key={j} className="ro">
                            {v ? fmtQty(v) : "–"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th className="sticky-col">{d.total_label}</th>
                      {totals.map((v, j) => (
                        <td key={j}>{fmtQty(v)}</td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
