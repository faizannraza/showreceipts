/**
 * PR-ready Markdown receipt (ARCHITECTURE §5.2, §12.1 `export --md`, S21):
 * a searchable badge line, header facts, the CLAIMED/EVIDENCE table with
 * glyph words (`VERIFIED`/`CONTRADICTED`/`UNVERIFIED`), ALSO SAID and ALSO
 * DID lists, stats, the API-equivalent cost line, the "evidence from log
 * only" footer, and — when the receipt carries one — the evidence timeline
 * table.
 *
 * Safety discipline: every dynamic string (all of them may derive from a
 * transcript) passes `sanitizeForCell` (§10.1: no control bytes, no bidi or
 * line separators) and then Markdown entity-escaping — `&` → `&amp;`,
 * `<` → `&lt;`, `|` → `&#124;`, backtick → `&#96;` — so a hostile final
 * message can neither break a table cell, open an HTML tag nor smuggle a
 * code span. Renderer-emitted text goes through the same escape (the `<` of
 * `<1m` included), so the output never contains a raw `<`, a raw backtick,
 * or a `|` outside table structure. `--hash-paths` is a final `hashStrings`
 * pass (S18 `util/hashpaths.ts`, imported, never extended) over the whole
 * receipt before any text is composed.
 *
 * Pure and deterministic: no fs, no env, no clock — times come from the
 * receipt's ISO fields via `util/time` in the requested `tz`.
 */
import type { Receipt, ReceiptLine, TimelineEntry } from '../model/types.js';
import { formatPct, formatUsd } from '../cost/format.js';
import { hashStrings } from '../util/hashpaths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { formatClock, formatDateRange, formatDuration, parseIso, type Tz } from '../util/time.js';

/** Options of {@link renderMarkdownReceipt}. */
export interface MarkdownOptions {
  /** Time zone for printed clocks (default `utc`; the CLI passes `--tz`, default `local`). */
  tz?: Tz | undefined;
  /**
   * Apply the §11.2 `--hash-paths` pass before rendering (skipped when the
   * receipt is already hashed, i.e. `receipt.hashPaths === true`). The salt
   * never appears in the output.
   */
  hashPaths?: { salt: string; cwd: string; extraTokens?: readonly string[] } | undefined;
}

/** Glyph words for the CLAIMED table (§5.2; `said` never reaches `lines`). */
const GLYPH_WORD: Readonly<Record<ReceiptLine['glyph'], string>> = {
  ok: 'VERIFIED',
  bad: 'CONTRADICTED',
  unk: 'UNVERIFIED',
  said: 'ALSO SAID',
};

/** Entity-escapes Markdown/HTML-active characters; the output has no raw `<`, `|` or backtick. */
function escapeMd(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;');
}

/** Sanitises (§10.1) then escapes one dynamic string for embedding anywhere in the document. */
function text(s: string): string {
  return escapeMd(sanitizeForCell(s));
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The badge's verdict summary — one searchable phrase per verdict. */
function verdictSummary(r: Receipt): string {
  switch (r.verdict) {
    case 'NO_TURNS':
      return 'NO TURNS';
    case 'NO_FINAL':
      return 'NO FINAL MESSAGE';
    case 'NO_CLAIMS':
      return 'NO CLAIMS';
    default: {
      const scored = r.counts.VERIFIED + r.counts.UNVERIFIED + r.counts.CONTRADICTED;
      if (r.verdict === 'VERIFIED') return `VERIFIED (${plural(scored, 'claim')})`;
      const worst = r.verdict === 'CONTRADICTED' ? r.counts.CONTRADICTED : r.counts.UNVERIFIED;
      return `${r.verdict} (${worst} of ${plural(scored, 'claim')})`;
    }
  }
}

/**
 * The badge line: `**showreceipts** · <verdict summary> · <harness>
 * <version> · <model> · rules <rulesVersion> · v<toolVersion>` — one
 * greppable line that identifies tool, rules and verdict at a glance.
 */
function badge(r: Receipt): string {
  const harness = r.harnessVersion === null ? text(r.harnessLabel) : `${text(r.harnessLabel)} ${text(r.harnessVersion)}`;
  const parts = [
    '**showreceipts**',
    `**${verdictSummary(r)}**`,
    harness,
    text(r.model),
    `rules ${text(r.rulesVersion)}`,
    `v${text(r.toolVersion)}`,
  ];
  return parts.join(' · ');
}

/** `Jul 18 10:02 → 11:14` (or with `Mon D` on the end clock when it crosses a day) in `tz`. */
function timeRange(r: Receipt, tz: Tz): string | null {
  const startMs = parseIso(r.startedAt);
  const endMs = parseIso(r.endedAt);
  if (startMs === null || endMs === null) return null;
  return `${formatDateRange(startMs, startMs, tz)} ${formatClock(startMs, tz, startMs)} → ${formatClock(endMs, tz, startMs)}`;
}

/** Header facts (§10.1 header, one Markdown line): short id, cwd, branch, times, duration, turn. */
function header(r: Receipt, tz: Tz): string {
  const parts: string[] = [`**receipt #${text(r.shortId)}**`];
  if (r.cwd !== '') parts.push(text(r.cwd));
  // §10.1 branch display, as in `term.ts branchLabel`: `HEAD` marks a
  // detached checkout, empty/unknown shows `no branch`.
  parts.push(r.branch === null || r.branch === '' ? 'no branch' : r.branch === 'HEAD' ? 'detached HEAD' : text(r.branch));
  const range = timeRange(r, tz);
  if (range !== null) parts.push(range);
  if (r.kind !== 'no-turns') parts.push(text(formatDuration(r.turnActiveMs ?? r.durationMs)));
  if (r.turnIndex >= 0) parts.push(`turn ${r.turnIndex}`);
  if (r.source === 'ledger') parts.push('hook-captured');
  if (r.sessionSpan !== undefined) {
    const fromMs = parseIso(r.sessionSpan.from);
    const toMs = parseIso(r.sessionSpan.to);
    if (fromMs !== null && toMs !== null) {
      parts.push(`session ${formatDateRange(fromMs, toMs, tz)} (${r.sessionSpan.days}d)`);
    }
  }
  return parts.join(' · ');
}

/** The CLAIMED/EVIDENCE table (worst-first rows come pre-ordered on the receipt). */
function claimsTable(r: Receipt): string[] {
  const rows = r.lines.map((line) => {
    const evidence = line.evidence.length === 0 ? '—' : line.evidence.map(text).join('; ');
    return `| ${GLYPH_WORD[line.glyph]} | ${text(line.claim)} | ${evidence} |`;
  });
  return ['| | CLAIMED | EVIDENCE |', '| --- | --- | --- |', ...rows];
}

/** ALSO SAID (dim `~` prefix) and ALSO DID (`!` marks a warning) lists plus post-final activity (§5.2). */
function alsoSections(r: Receipt): string[] {
  const out: string[] = [];
  if (r.alsoSaid.length > 0) {
    out.push('**ALSO SAID (not scored)**', '');
    for (const said of r.alsoSaid) out.push(`- ~ ${text(said)}`);
    out.push('');
  }
  if (r.alsoDid.length > 0) {
    out.push('**ALSO DID (not mentioned)**', '');
    for (const did of r.alsoDid) out.push(`- ${did.warn === true ? '**!** ' : ''}${text(did.text)}`);
    out.push('');
  }
  for (const pf of r.postFinal ?? []) {
    const who = pf.agentId === null ? 'the main agent' : `agent ${text(pf.agentId)}`;
    out.push(
      `_after this message: ${who} ran ${plural(pf.toolCalls, 'tool call')} ` +
        `(${plural(pf.files, 'file')}, ${plural(pf.testRuns, 'test run')}) — not evidence for the claims above_`,
      '',
    );
  }
  return out;
}

/** The stats block: claims recognized (§5.3, always for judged kinds) and the §10.1 counters. */
function statsLines(r: Receipt): string[] {
  const out: string[] = [];
  if (r.kind === 'scored' || r.kind === 'no-claims') {
    out.push(
      `claims recognized: ${r.claimsRecognized} (of which ${r.counts.NOT_SCORED} not scored)` +
        ` · ${plural(r.stats.sentencesScanned, 'sentence')} scanned`,
    );
  }
  if (r.kind === 'no-turns') {
    out.push('0 tool calls · 0 files changed');
    return out;
  }
  const parts = [
    plural(r.stats.toolCalls, 'tool call'),
    plural(r.stats.filesChanged, 'file') + ' changed',
    plural(r.stats.testRuns, 'test run'),
  ];
  if (r.stats.compactions > 0) parts.push(plural(r.stats.compactions, 'compaction'));
  if (r.stats.subagents > 0) parts.push(plural(r.stats.subagents, 'subagent'));
  out.push(parts.join(' · '));
  return out;
}

/** The §8.3 cost line; `null` for a `no-turns` receipt (cost omitted, §10.1). */
function costLine(r: Receipt): string | null {
  if (r.kind === 'no-turns') return null;
  if (r.source === 'ledger') return 'cost n/a (hook-captured)';
  const c = r.cost;
  const parts = [`cost ${text(formatUsd(c.usd, c.unverified))} (API-equivalent)`];
  if (c.cacheHitPct !== null) parts.push(`cache hit ${formatPct(c.cacheHitPct)}`);
  if (c.planUsagePct !== undefined) parts.push(`plan usage ${formatPct(c.planUsagePct)}`);
  if (c.asOf !== undefined) parts.push(`prices as of ${text(c.asOf)}`);
  return parts.join(' · ');
}

/** The verdict word rendered under the receipt (`—` for `no-turns`, §10.1). */
function verdictLine(r: Receipt): string {
  switch (r.verdict) {
    case 'NO_TURNS':
      return '**VERDICT: —**';
    case 'NO_FINAL':
      return '**VERDICT: NO FINAL MESSAGE**';
    case 'NO_CLAIMS':
      return '**VERDICT: NO CLAIMS**';
    default:
      return `**VERDICT: ${r.verdict}**`;
  }
}

/** One timeline row (`--timeline`): time, tool, summary, exit, files, $, agent, flags. */
function timelineRow(e: TimelineEntry, tz: Tz, refDayMs: number): string {
  const ms = parseIso(e.at);
  const time = ms === null ? '—' : formatClock(ms, tz, refDayMs);
  const cells = [
    time,
    text(e.tool),
    text(e.summary),
    e.exit === null ? '' : String(e.exit),
    e.files.map(text).join(', '),
    e.usd === null ? '' : text(formatUsd(e.usd)),
    e.agentId === null ? '' : text(e.agentId),
    e.flags.join(' '),
  ];
  return `| ${cells.join(' | ')} |`;
}

/** The `--timeline` table (§5.2): every tool call of the receipt turn, in `seq` order. */
function timelineTable(r: Receipt, tz: Tz): string[] {
  const entries = r.timeline ?? [];
  const refDayMs = parseIso(r.startedAt) ?? 0;
  return [
    '**TIMELINE**',
    '',
    '| time | tool | summary | exit | files | $ | agent | flags |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((e) => timelineRow(e, tz, refDayMs)),
  ];
}

/** The body paragraph or table for the receipt's `kind` (§10.1 kind texts). */
function body(r: Receipt): string[] {
  switch (r.kind) {
    case 'no-turns':
      return [`no assistant turns in this session (${plural(r.records ?? 0, 'record')})`];
    case 'no-final':
      return ['turn ended without a final message'];
    case 'no-claims':
      return [`no claims recognized in the final message (0 claims · ${plural(r.stats.sentencesScanned, 'sentence')})`];
    case 'scored':
      return claimsTable(r);
  }
}

/**
 * Renders one receipt as PR-ready Markdown (S21): badge line, header facts,
 * CLAIMED/EVIDENCE table (or the `no-claims`/`no-final`/`no-turns` text),
 * ALSO SAID / ALSO DID, post-final note, stats, the API-equivalent cost
 * line, `VERDICT`, the timeline table when the receipt carries one, and the
 * "evidence from log only" footer. Every dynamic string is sanitised and
 * entity-escaped; `opts.hashPaths` applies the §11.2 pass first (unless the
 * receipt is already hashed). Ends with exactly one trailing newline.
 */
export function renderMarkdownReceipt(receipt: Receipt, opts: MarkdownOptions = {}): string {
  let r = receipt;
  if (opts.hashPaths !== undefined && receipt.hashPaths !== true) {
    r = hashStrings(receipt, opts.hashPaths.salt, opts.hashPaths.cwd, opts.hashPaths.extraTokens ?? []);
    r.hashPaths = true;
  }
  const tz: Tz = opts.tz ?? 'utc';
  const blocks: string[][] = [[badge(r)], [header(r, tz)], body(r)];
  const also = alsoSections(r);
  // `alsoSections` ends every subsection with a spacer line; drop the last
  // one — the block joiner inserts the blank line between blocks itself.
  if (also.length > 0) blocks.push(also[also.length - 1] === '' ? also.slice(0, -1) : also);
  blocks.push(statsLines(r));
  const cost = costLine(r);
  if (cost !== null) blocks.push([cost]);
  blocks.push([verdictLine(r)]);
  if (r.timeline !== undefined) blocks.push(timelineTable(r, tz));
  blocks.push(['_evidence from log only_']);
  return `${blocks.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
