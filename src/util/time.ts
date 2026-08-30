/**
 * Time parsing and formatting without `Intl` (§10.1): every function is pure
 * over millisecond timestamps; `tz: 'local'` uses only
 * `Date#getTimezoneOffset`, so output is fully determined by `TZ`.
 */

export type Tz = 'local' | 'utc';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const SINCE_DAYS_RE = /^(\d{1,5})d$/;

/** True when `y-m-d` names a real calendar date (no 2026-02-30, no month 13). */
function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Parses an ISO-8601 date (`YYYY-MM-DD`, taken as UTC midnight) or timestamp
 * (`T` or space separator, optional seconds/fraction, `Z` or `±HH:MM`
 * offset; no offset ⇒ UTC). Returns epoch milliseconds, or `null` when the
 * text is malformed or names an impossible date or time.
 */
export function parseIso(s: string): number | null {
  const m = ISO_RE.exec(s.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isCalendarDate(y, mo, d)) return null;
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const frac = m[7] === undefined ? 0 : Number(`0.${m[7]}`) * 1000;
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  const utc = Date.UTC(y, mo - 1, d, hh, mi, ss) + Math.floor(frac);
  return utc - offsetMinutes * MINUTE;
}

/** Milliseconds shifted so that UTC getters yield wall-clock fields in `tz`. */
function shifted(ms: number, tz: Tz): number {
  if (tz === 'utc') return ms;
  return ms - new Date(ms).getTimezoneOffset() * MINUTE;
}

/** Zero-based day index (days since the epoch) of the calendar day containing `ms` in `tz`. */
function dayIndex(ms: number, tz: Tz): number {
  return Math.floor(shifted(ms, tz) / DAY);
}

function monthDay(ms: number, tz: Tz): string {
  const d = new Date(shifted(ms, tz));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function clock(ms: number, tz: Tz): string {
  const d = new Date(shifted(ms, tz));
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * `HH:MM` when `ms` falls on the same calendar day (in `tz`) as `refDayMs`,
 * else `Mon D HH:MM` (§10.1: the reference day is the day the turn started).
 */
export function formatClock(ms: number, tz: Tz, refDayMs: number): string {
  const time = clock(ms, tz);
  return dayIndex(ms, tz) === dayIndex(refDayMs, tz) ? time : `${monthDay(ms, tz)} ${time}`;
}

/**
 * A calendar-day range for the header (`Jul 18 → Aug 23`); a single day
 * renders once (`Jul 18`); a range crossing a year boundary carries the
 * years (`Dec 30 2025 → Jan 2 2026`).
 */
export function formatDateRange(fromMs: number, toMs: number, tz: Tz): string {
  const from = new Date(shifted(fromMs, tz));
  const to = new Date(shifted(toMs, tz));
  if (dayIndex(fromMs, tz) === dayIndex(toMs, tz)) return monthDay(fromMs, tz);
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    return `${monthDay(fromMs, tz)} ${from.getUTCFullYear()} → ${monthDay(toMs, tz)} ${to.getUTCFullYear()}`;
  }
  return `${monthDay(fromMs, tz)} → ${monthDay(toMs, tz)}`;
}

/**
 * `<1m`, `Nm`, `Nh MMm` (minutes zero-padded: `2h 05m`), `Nd Nh` (§10.1).
 * Negative or non-finite input renders as `<1m`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return '<1m';
  const totalMinutes = Math.floor(ms / MINUTE);
  if (ms < HOUR) return `${totalMinutes}m`;
  const totalHours = Math.floor(ms / HOUR);
  if (ms < DAY) return `${totalHours}h ${pad2(totalMinutes - totalHours * 60)}m`;
  const days = Math.floor(ms / DAY);
  return `${days}d ${totalHours - days * 24}h`;
}

/**
 * The start of a `--since`/`--until` window: `Nd` counts back from `nowMs`,
 * `YYYY-MM-DD` is UTC midnight of that day. `null` for anything else.
 */
export function parseSince(spec: string, nowMs: number): number | null {
  const days = SINCE_DAYS_RE.exec(spec.trim());
  if (days !== null) return nowMs - Number(days[1]) * DAY;
  if (!DATE_RE.test(spec.trim())) return null;
  return parseIso(spec.trim());
}

/** `--as-of YYYY-MM-DD` as UTC midnight; `null` for a malformed or impossible date. */
export function parseAsOf(spec: string): number | null {
  const m = DATE_RE.exec(spec);
  if (m === null) return null;
  return parseIso(spec);
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Number of calendar-day boundaries crossed between `a` and `b` in `tz`
 * (0 on the same day, 1 across midnight, negative when `b` precedes `a`).
 */
export function calendarDaysBetween(a: number, b: number, tz: Tz): number {
  return dayIndex(b, tz) - dayIndex(a, tz);
}

/** `YYYY-MM` of the UTC month containing an ISO timestamp; `null` when it does not parse. */
export function monthOf(iso: string): string | null {
  const ms = parseIso(iso);
  return ms === null ? null : isoDay(ms).slice(0, 7);
}
