// Date helpers. Saudi Arabia has no daylight saving, so a fixed offset is exact.
//
// A sheet dated D is open for entries from (D-1 at cutoff) until (D at cutoff),
// local time. At D's cutoff it locks and D+1 opens.

export function parseCutoff(cutoff: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cutoff.trim());
  if (!m) return 18 * 60 + 30;
  return Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]));
}

export function localParts(nowMs: number, offsetMin: number) {
  const d = new Date(nowMs + offsetMin * 60_000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The day whose sheet currently accepts entries. */
export function openDayAt(nowMs: number, cutoffMin: number, offsetMin: number): string {
  const p = localParts(nowMs, offsetMin);
  return p.minutes >= cutoffMin ? addDays(p.date, 1) : p.date;
}

/** UTC instant at which the sheet for `day` locks. */
export function cutoffInstant(day: string, cutoffMin: number, offsetMin: number): number {
  return Date.parse(day + "T00:00:00Z") + (cutoffMin - offsetMin) * 60_000;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Sheet name for a day, e.g. format "MMM- DD" -> "Nov- 05". Tokens: MMM, MM, DD, D, YYYY. */
export function sheetNameFor(day: string, format: string): string {
  const [y, m, d] = day.split("-");
  const out = format
    .replace("YYYY", y)
    .replace("MMM", "\u0001")
    .replace("MM", m)
    .replace("DD", d)
    .replace(/\bD\b/, String(Number(d)))
    .replace("\u0001", MONTHS[Number(m) - 1]);
  // Excel forbids : \ / ? * [ ] and limits names to 31 chars
  return out.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
}

export function formatDayLong(day: string, locale = "en-GB"): string {
  return new Date(day + "T12:00:00Z").toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
