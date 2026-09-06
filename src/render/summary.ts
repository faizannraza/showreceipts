/**
 * The `audit` screen's text pieces (§10.1 summary/rate tables, §10.2 header
 * and footer): the header/footer lines, the session table with the fitting
 * sequence (drop `turns` → fold harness+version → model 18 + `…` → verdict
 * abbreviations → id to 6) and the false-done rate table (one line per row
 * when it fits, else the numbers indented 4 on a second line).
 * Pure and deterministic; widths are computed on stripped text.
 */
import type { RateRow, SessionCard } from '../model/types.js';
import { HARNESS_LABELS } from '../model/types.js';
import { formatUsd } from '../cost/format.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { formatDateRange, isoDay, parseIso } from '../util/time.js';
import { displayWidth, padEnd, truncateToWidth, wrapToWidth } from '../util/width.js';
import { packLines } from './box.js';
import { glyphSet, transliterate, type GlyphSet } from './glyphs.js';

/** Options shared by the audit pieces. */
export interface SummaryOptions {
  cols: number;
  unicode: boolean;
  /** Session-table row cap (`--limit`, default 20). */
  limit?: number | undefined;
}

/** What the audit header line reports (§10.2: `showreceipts 0.1.0 · scanned 41 sessions · Claude Code 37 · Codex 4 · Aug 1–29`). */
export interface AuditScan {
  toolVersion: string;
  sessions: number;
  /** Per-harness session counts, in display order. */
  byHarness: readonly { label: string; sessions: number }[];
  /** ISO instants of the scan window (omitted when unknown). */
  from?: string | undefined;
  to?: string | undefined;
}

function budgetOf(cols: number): number {
  return Math.max(40, Math.min(cols, 200)) - 2;
}

/** `Aug 1–29` (same month), `Jul 18 – Aug 23`, `Dec 30 2025 – Jan 2 2026`. */
function dateSpan(fromIso: string, toIso: string, g: GlyphSet): string | null {
  const fromMs = parseIso(fromIso);
  const toMs = parseIso(toIso);
  if (fromMs === null || toMs === null) return null;
  const a = formatDateRange(fromMs, fromMs, 'utc');
  const b = formatDateRange(toMs, toMs, 'utc');
  if (a === b) return a;
  const sameYear = isoDay(fromMs).slice(0, 4) === isoDay(toMs).slice(0, 4);
  const sameMonth = sameYear && isoDay(fromMs).slice(0, 7) === isoDay(toMs).slice(0, 7);
  if (sameMonth) return `${a}${g.enDash}${b.split(' ')[1] ?? ''}`;
  if (sameYear) return `${a} ${g.enDash} ${b}`;
  return `${a} ${isoDay(fromMs).slice(0, 4)} ${g.enDash} ${b} ${isoDay(toMs).slice(0, 4)}`;
}

/** The audit header, wrapped at ` · ` to the column budget. */
export function renderAuditHeader(scan: AuditScan, opts: SummaryOptions): string[] {
  const g = glyphSet(opts.unicode);
  const chunks = [`showreceipts ${sanitizeForCell(scan.toolVersion)}`, `scanned ${scan.sessions} session${scan.sessions === 1 ? '' : 's'}`];
  for (const h of scan.byHarness) chunks.push(`${sanitizeForCell(h.label)} ${h.sessions}`);
  if (scan.from !== undefined && scan.to !== undefined) {
    const span = dateSpan(scan.from, scan.to, g);
    if (span !== null) chunks.push(span);
  }
  return packLines(chunks.map((c) => (g.unicode ? c : transliterate(c))), budgetOf(opts.cols), g.sepGlyph);
}

/** The audit footer: `report → <path>` and, when no hooks are installed, the `setup` hint (§10.2). */
export function renderAuditFooter(info: { reportPath: string; showSetupHint: boolean }, opts: SummaryOptions): string[] {
  const g = glyphSet(opts.unicode);
  const tlx = (s: string): string => (g.unicode ? s : transliterate(s));
  const report = tlx(`report → ${sanitizeForCell(info.reportPath)}`);
  const setup = tlx('setup → npx showreceipts setup');
  const budget = budgetOf(opts.cols);
  if (!info.showSetupHint) return [truncateToWidth(report, budget, g.ellipsis)];
  const joined = `${report}     ${setup}`;
  if (displayWidth(joined) <= budget) return [joined];
  return [truncateToWidth(report, budget, g.ellipsis), truncateToWidth(setup, budget, g.ellipsis)];
}

// ---------------------------------------------------------------------------
// Session table
// ---------------------------------------------------------------------------

/** Verdict abbreviations of fitting step 4. */
const VERDICT_ABBREV: Readonly<Record<string, string>> = {
  CONTRADICTED: 'CONTRA',
  UNVERIFIED: 'UNVER',
  VERIFIED: 'OK',
  NO_CLAIMS: 'NONE',
  NO_FINAL: '—',
  NO_TURNS: '—',
};

/** The §0.3 key form of a harness (`cc 2.1.214`, `codex 0.98.0`). */
function harnessKey(harness: SessionCard['harness']): string {
  return harness === 'claude-code' ? 'cc' : harness;
}

/** Middle-truncates a session id to `max` columns (fitting step 5). */
function middleTruncateId(id: string, max: number, ellipsis: string): string {
  if (displayWidth(id) <= max) return id;
  const tail = id.slice(-2);
  const headBudget = max - displayWidth(ellipsis) - displayWidth(tail);
  return headBudget <= 0 ? truncateToWidth(id, max, ellipsis) : `${id.slice(0, headBudget)}${ellipsis}${tail}`;
}

interface Column {
  header: string;
  cells: string[];
}

function widthOf(col: Column): number {
  let w = displayWidth(col.header);
  for (const cell of col.cells) if (displayWidth(cell) > w) w = displayWidth(cell);
  return w;
}

function tableWidth(cols: readonly Column[]): number {
  return cols.reduce((sum, c) => sum + widthOf(c), 0) + 2 * Math.max(0, cols.length - 1);
}

/**
 * The session table (§10.1): `id harness version model date turns claims
 * verdict cost`, sorted by (`endedAt` desc, `sessionId` asc), `limit` rows.
 * When the natural width exceeds `cols − 2` the fitting sequence applies in
 * order: drop `turns`, fold harness+version into the key form, truncate the
 * model to 18 + `…`, abbreviate verdicts, middle-truncate the id to 6.
 */
export function renderSessionTable(cards: readonly SessionCard[], opts: SummaryOptions): string[] {
  const g = glyphSet(opts.unicode);
  const budget = budgetOf(opts.cols);
  const limit = opts.limit ?? 20;
  const rows = [...cards]
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
  if (rows.length === 0) return ['no sessions'];

  const dateOf = (card: SessionCard): string => {
    const ms = parseIso(card.endedAt);
    return ms === null ? '—' : formatDateRange(ms, ms, 'utc');
  };
  let columns: Column[] = [
    { header: 'ID', cells: rows.map((r) => sanitizeForCell(r.shortId)) },
    { header: 'HARNESS', cells: rows.map((r) => sanitizeForCell(r.harnessLabel)) },
    { header: 'VERSION', cells: rows.map((r) => sanitizeForCell(r.harnessVersion ?? '')) },
    { header: 'MODEL', cells: rows.map((r) => sanitizeForCell(r.model)) },
    { header: 'DATE', cells: rows.map(dateOf) },
    { header: 'TURNS', cells: rows.map((r) => String(r.turns)) },
    { header: 'CLAIMS', cells: rows.map((r) => String(r.claims)) },
    { header: 'VERDICT', cells: rows.map((r) => r.verdict) },
    { header: 'COST', cells: rows.map((r) => (r.costUsd === null ? 'n/a' : formatUsd(r.costUsd, r.unverified))) },
  ];
  const col = (header: string): Column => columns.find((c) => c.header === header) as Column;

  if (tableWidth(columns) > budget) columns = columns.filter((c) => c.header !== 'TURNS');
  if (tableWidth(columns) > budget) {
    const harness = col('HARNESS');
    const versions = col('VERSION').cells;
    harness.cells = rows.map((r, i) => `${harnessKey(r.harness)}${(versions[i] ?? '') === '' ? '' : ` ${versions[i] as string}`}`);
    columns = columns.filter((c) => c.header !== 'VERSION');
  }
  if (tableWidth(columns) > budget) {
    const model = col('MODEL');
    model.cells = model.cells.map((m) => truncateToWidth(m, 18 + displayWidth(g.ellipsis), g.ellipsis));
  }
  if (tableWidth(columns) > budget) {
    const verdict = col('VERDICT');
    verdict.cells = verdict.cells.map((v) => VERDICT_ABBREV[v] ?? v);
  }
  if (tableWidth(columns) > budget) {
    const id = col('ID');
    id.cells = id.cells.map((v) => middleTruncateId(v, 6, g.ellipsis));
  }
  // Last resort below the sequence's floor (very narrow terminals; §10.1
  // lines must never overflow, so the cols − 2 budget binds at every accepted
  // width): shave the widest column down to 8, then — because 7 columns of
  // ≤ 8 still floor at ~56–58 — drop the lowest-priority columns entirely,
  // then shave further to a hard floor. Partial COST/DATE/CLAIMS cells are
  // worth less than fitting lines at --width 40.
  let guard = 0;
  const shaveTo = (floor: number): void => {
    while (tableWidth(columns) > budget && guard++ < 200) {
      let widest: Column | undefined;
      for (const c of columns) if (widthOf(c) > floor && (widest === undefined || widthOf(c) > widthOf(widest))) widest = c;
      if (widest === undefined) return;
      const target = widthOf(widest) - 1;
      widest.cells = widest.cells.map((v) => truncateToWidth(v, target, g.ellipsis));
      widest.header = truncateToWidth(widest.header, Math.max(target, 2), g.ellipsis);
    }
  };
  shaveTo(8);
  for (const header of ['COST', 'DATE', 'CLAIMS']) {
    if (tableWidth(columns) <= budget) break;
    if (columns.length > 2) columns = columns.filter((c) => c.header !== header);
  }
  shaveTo(3);

  const widths = columns.map(widthOf);
  const tlx = (s: string): string => (g.unicode ? s : transliterate(s));
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => padEnd(tlx(cell), widths[i] as number))
      .join('  ')
      .trimEnd();
  return [render(columns.map((c) => c.header)), ...rows.map((_, i) => render(columns.map((c) => c.cells[i] as string)))];
}

// ---------------------------------------------------------------------------
// Rate table
// ---------------------------------------------------------------------------

/**
 * The false-done rate table (§5.4, §10.1): rows sorted by (`doneTurns` desc,
 * `model`, `harness`, `harnessVersion`); label `<model> · <harness>
 * <version>`; numbers `3/29 done turns contradicted (10%) · 7 unverified`
 * on the same line when both fit `cols − 2`, else indented 4 on the next;
 * `—  (3 of 4)` under 10 done turns.
 */
export function renderRateTable(rows: readonly RateRow[], opts: SummaryOptions): string[] {
  const g = glyphSet(opts.unicode);
  const budget = budgetOf(opts.cols);
  const sep = g.unicode ? ' · ' : ' - ';
  const sorted = [...rows].sort(
    (a, b) =>
      b.doneTurns - a.doneTurns ||
      a.model.localeCompare(b.model) ||
      a.harness.localeCompare(b.harness) ||
      a.harnessVersion.localeCompare(b.harnessVersion),
  );
  const out: string[] = [];
  let smallSample = false;
  for (const row of sorted) {
    // A row with no done turns carries no rate at all — '(0 of 0)' is pure
    // noise on the screen (the JSON and HTML surfaces keep the raw rows).
    if (row.doneTurns === 0) continue;
    const version = row.harnessVersion === '' ? '' : ` ${sanitizeForCell(row.harnessVersion)}`;
    const label = `${sanitizeForCell(row.model)}${sep}${HARNESS_LABELS[row.harness]}${version}`;
    let numbers: string;
    if (row.doneTurns < 10) {
      smallSample = true;
      numbers = `${g.emDash}  (${row.contradictedTurns} of ${row.doneTurns})`;
    } else {
      const pct = Math.round((row.contradictedTurns / row.doneTurns) * 100);
      numbers = `${row.contradictedTurns}/${row.doneTurns} done turns contradicted (${pct}%)`;
      if (row.unverifiedTurns > 0) numbers += `${sep}${row.unverifiedTurns} unverified`;
    }
    if (displayWidth(label) + 2 + displayWidth(numbers) <= budget) {
      out.push(`${label}  ${numbers}`);
    } else {
      out.push(truncateToWidth(label, budget, g.ellipsis));
      out.push(`    ${truncateToWidth(numbers, budget - 4, g.ellipsis)}`);
    }
  }
  if (out.length === 0) return ['no rate data (no done turns)'];
  if (smallSample) out.push(...wrapToWidth(`${g.emDash} = fewer than 10 done turns (contradicted of total)`, budget, 9));
  return out;
}

/** The `≈` explanation printed once under a screen that showed an estimated cost (§8.3), wrapped to `cols − 2`. */
export function approxLegend(unicode: boolean, cols: number): string[] {
  const line = '≈ = estimated (unverified rate, unknown cache TTL, or unpriced model/speed/tier) — see docs/prices.md';
  return wrapToWidth(unicode ? line : transliterate(line), Math.max(40, Math.min(cols, 200)) - 2, 9);
}
