/**
 * The evidence timeline as terminal text (§5.2, S20 instruction 5): one row
 * per `TimelineEntry` — time, tool, summary, exit, files, $ and agent badge —
 * as an unboxed column table in wide mode and a two-line-per-entry layout in
 * narrow mode. Danger rows carry the warn glyph; error exits are painted.
 * Pure and deterministic; widths are computed on stripped text.
 */
import type { TimelineEntry } from '../model/types.js';
import { formatUsd } from '../cost/format.js';
import { paint } from '../util/ansi.js';
import { basename } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { formatClock, parseIso, type Tz } from '../util/time.js';
import { displayWidth, padEnd, truncateToWidth } from '../util/width.js';
import { geometry } from './box.js';
import { glyphSet, transliterate } from './glyphs.js';

/** Options of {@link renderTimeline}. */
export interface TimelineOptions {
  cols: number;
  unicode: boolean;
  color?: boolean | undefined;
  /** Time zone for the time column (default `utc`). */
  tz?: Tz | undefined;
  /** Reference instant for `HH:MM` vs `Mon D HH:MM` (default: the first entry's time). */
  startedAt?: string | undefined;
}

/** The pre-formatted cells of one row. */
interface Row {
  time: string;
  tool: string;
  summary: string;
  exit: string;
  files: string;
  usd: string;
  agent: string;
  error: boolean;
  danger: boolean;
}

/** Longest tool-name column. */
const TOOL_MAX = 12;
/** Longest files column. */
const FILES_MAX = 18;

function fileCell(files: readonly string[]): string {
  if (files.length === 0) return '';
  if (files.length === 1) return basename(files[0] as string);
  return `${files.length} files`;
}

function rowsOf(entries: readonly TimelineEntry[], tz: Tz, refDayMs: number, warnGlyph: string, ascii: boolean): Row[] {
  return entries.map((e) => {
    const ms = parseIso(e.at);
    const danger = e.flags.includes('danger');
    const summary = sanitizeForCell(e.summary);
    return {
      time: ms === null ? '—' : formatClock(ms, tz, refDayMs),
      tool: truncateToWidth(sanitizeForCell(e.tool), TOOL_MAX, ascii ? '...' : '…'),
      summary: danger ? `${warnGlyph} ${summary}` : summary,
      exit: e.exit === null ? '' : String(e.exit),
      files: truncateToWidth(sanitizeForCell(fileCell(e.files)), FILES_MAX, ascii ? '...' : '…'),
      usd: e.usd === null ? '' : formatUsd(e.usd),
      agent: e.agentId === null ? '' : `a:${sanitizeForCell(e.agentId).slice(0, 7)}`,
      error: e.flags.includes('error'),
      danger,
    };
  });
}

/** Widest cell (header included) of one column. */
function colWidth(rows: readonly Row[], key: keyof Row, header: string): number {
  let w = displayWidth(header);
  for (const row of rows) {
    const v = row[key];
    if (typeof v === 'string' && displayWidth(v) > w) w = displayWidth(v);
  }
  return w;
}

/**
 * Renders the timeline (§5.2). Wide mode is a column table `TIME TOOL
 * SUMMARY EXIT FILES $ AGENT` with the summary flexed into the remaining
 * width; narrow mode renders `HH:MM tool exit` with the summary indented on
 * a second line. Every line's display width is at most `cols`.
 */
export function renderTimeline(entries: readonly TimelineEntry[], opts: TimelineOptions): string[] {
  const g = glyphSet(opts.unicode);
  const tz = opts.tz ?? 'utc';
  const color = opts.color === true;
  const ell = g.ellipsis;
  const refDayMs = parseIso(opts.startedAt ?? entries[0]?.at ?? '') ?? 0;
  const rows = rowsOf(entries, tz, refDayMs, g.warn, !g.unicode);
  const budget = Math.max(40, Math.min(opts.cols, 200)) - 2;
  const wide = geometry(opts.cols).wide;
  const tlx = (s: string): string => (g.unicode ? s : transliterate(s));

  if (!wide) {
    const out: string[] = [];
    for (const row of rows) {
      const exit = row.exit === '' ? '' : ` ${tlx('→')} exit ${row.exit}`;
      const head = truncateToWidth(`${row.time} ${row.tool}${exit}`, budget, ell);
      out.push(row.error && color ? paint('bad', head) : head);
      out.push(`  ${truncateToWidth(tlx(row.summary), budget - 2, ell)}`);
    }
    return out;
  }

  const widths = {
    time: colWidth(rows, 'time', 'TIME'),
    tool: colWidth(rows, 'tool', 'TOOL'),
    exit: colWidth(rows, 'exit', 'EXIT'),
    files: colWidth(rows, 'files', 'FILES'),
    usd: colWidth(rows, 'usd', '$'),
    agent: colWidth(rows, 'agent', 'AGENT'),
  };
  const fixed = widths.time + widths.tool + widths.exit + widths.files + widths.usd + widths.agent + 6 * 2;
  const summaryW = Math.max(8, budget - fixed);
  const line = (time: string, tool: string, summary: string, exit: string, files: string, usd: string, agent: string): string =>
    [
      padEnd(time, widths.time),
      padEnd(tool, widths.tool),
      padEnd(truncateToWidth(summary, summaryW, ell), summaryW),
      padEnd(exit, widths.exit),
      padEnd(files, widths.files),
      padEnd(usd, widths.usd),
      agent,
    ]
      .join('  ')
      .trimEnd();
  const out = [paint('dim', line('TIME', 'TOOL', 'SUMMARY', 'EXIT', 'FILES', '$', 'AGENT'), color)];
  for (const row of rows) {
    const exit = row.error && color ? paint('bad', row.exit) : row.exit;
    out.push(line(row.time, row.tool, tlx(row.summary), exit, row.files, row.usd, row.agent));
  }
  return out;
}
