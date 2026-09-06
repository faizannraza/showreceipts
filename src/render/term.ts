/**
 * The boxed terminal receipt (§10.1, §10.2 samples): header, worst-first
 * CLAIMED/EVIDENCE, ALSO SAID / ALSO DID, stats, cost and VERDICT — wide and
 * narrow layouts, unicode and ASCII frames, optional 8-colour paint.
 *
 * Discipline: every transcript-derived string passes `sanitizeForCell`
 * before it is measured; renderer-emitted fragments (labels, evidence
 * strings, dates, stats) are additionally `transliterate`d in ASCII mode —
 * transcript text never is. Colour is applied after truncation and wrapping;
 * widths are computed on stripped text (`displayWidth` ignores ANSI). Pure:
 * no fs, no env, no clock — times come from the receipt's ISO fields.
 */
import type { Receipt, ReceiptLine } from '../model/types.js';
import { formatPct, formatUsd } from '../cost/format.js';
import { paint, type PaintKind } from '../util/ansi.js';
import { displayPath } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { formatClock, formatDateRange, formatDuration, parseIso, type Tz } from '../util/time.js';
import { displayWidth, padEnd, truncateToWidth } from '../util/width.js';
import {
  boxFrame,
  geometry,
  middleTruncatePath,
  packLines,
  packTokens,
  shrinkHeaderParts,
  wrapEvidence,
  wrapWords,
  type BoxFrame,
  type Geometry,
  type HeaderPart,
} from './box.js';
import { glyphSet, transliterate, type GlyphSet } from './glyphs.js';

/** Options of {@link renderReceipt} (§10.1; the CLI resolves them from flags and the environment). */
export interface TermOptions {
  /** Terminal columns (already resolved via `resolveCols`). */
  cols: number;
  /** Unicode frame and glyphs (already decided via `decideUnicode`). */
  unicode: boolean;
  /** Apply ANSI colour (already decided via `colorEnabled`). Default off. */
  color?: boolean | undefined;
  /** Time zone for printed clocks (default `utc`; the CLI passes `--tz`, default `local`). */
  tz?: Tz | undefined;
  /** The user's home directory (`~` display form of the cwd). */
  homeDir: string;
  /** `--all-claims`: lift the `capRows` cap. */
  allClaims?: boolean | undefined;
  /** Claim-row cap (`audit` passes 12); `undefined` shows all rows. */
  capRows?: number | undefined;
}

/** Everything one render carries around. */
interface Ctx {
  g: GlyphSet;
  geo: Geometry;
  frame: BoxFrame;
  color: boolean;
  tz: Tz;
  homeDir: string;
}

/** Renderer-emitted text: transliterated in ASCII mode. */
function tl(ctx: Ctx, s: string): string {
  return ctx.g.unicode ? s : transliterate(s);
}

/** Paints `s` when colour is on; identity otherwise. */
function pk(ctx: Ctx, kind: PaintKind, s: string): string {
  return paint(kind, s, ctx.color);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** `Jul 18 17:14 → 23:52` (the end clock gains `Mon D` when it crosses the start day). */
function timeRange(r: Receipt, tz: Tz): string | null {
  const startMs = parseIso(r.startedAt);
  const endMs = parseIso(r.endedAt);
  if (startMs === null || endMs === null) return null;
  return `${formatDateRange(startMs, startMs, tz)} ${formatClock(startMs, tz, startMs)} → ${formatClock(endMs, tz, startMs)}`;
}

/**
 * ` · session Jul 18 → Aug 23 (36d)` when the session spans more than two
 * calendar days. An overnight session (`days: 1`) renders no token — the end
 * clock already names its day (`Aug 23 23:15 → Aug 24 01:38`), so the token
 * would only repeat it (§10.1; S23b reconciliation decision).
 */
function sessionSpanToken(r: Receipt, tz: Tz): string | null {
  if (r.sessionSpan === undefined || r.sessionSpan.days < 2) return null;
  const fromMs = parseIso(r.sessionSpan.from);
  const toMs = parseIso(r.sessionSpan.to);
  if (fromMs === null || toMs === null) return null;
  return `session ${formatDateRange(fromMs, toMs, tz)} (${r.sessionSpan.days}d)`;
}

/**
 * The §10.1 branch display: `HEAD` (git's marker for a detached checkout,
 * never a legal branch name) renders `detached HEAD`; `null`/empty render
 * `no branch`; anything else is a real branch name, sanitised.
 */
export function branchLabel(branch: string | null): string {
  if (branch === null || branch === '') return 'no branch';
  if (branch === 'HEAD') return 'detached HEAD';
  return sanitizeForCell(branch);
}

/** Both header lines' parts, pre-sanitised; renderer fragments already transliterated. */
function headerParts(ctx: Ctx, r: Receipt): { line1: HeaderPart[]; line2: HeaderPart[] } {
  const version = r.harnessVersion === null ? '' : ` ${sanitizeForCell(r.harnessVersion)}`;
  const line1: HeaderPart[] = [
    { text: `RECEIPT  #${sanitizeForCell(r.shortId)}` },
    { text: `${sanitizeForCell(r.harnessLabel)}${version}` },
    { text: sanitizeForCell(r.model), role: 'model' },
  ];
  if (r.source === 'ledger') line1.push({ text: 'hook-captured' });
  const line2: HeaderPart[] = [
    { text: sanitizeForCell(displayPath(r.cwd, ctx.homeDir)), role: 'cwd' },
    { text: branchLabel(r.branch), role: 'branch' },
  ];
  const range = timeRange(r, ctx.tz);
  if (range !== null) line2.push({ text: tl(ctx, range) });
  if (r.kind !== 'no-turns') line2.push({ text: tl(ctx, formatDuration(r.turnActiveMs ?? r.durationMs)) });
  const span = sessionSpanToken(r, ctx.tz);
  if (span !== null) line2.push({ text: tl(ctx, span) });
  return { line1, line2 };
}

/** Wide header: shrink order per line, then ` · ` wrapping when the floors still exceed `I`. */
function wideHeader(ctx: Ctx, r: Receipt): string[] {
  const { line1, line2 } = headerParts(ctx, r);
  const out: string[] = [];
  for (const parts of [line1, line2]) {
    const texts = shrinkHeaderParts(parts, ctx.geo.I, ctx.g.ellipsis);
    out.push(...packLines(texts, ctx.geo.I, ctx.g.sepGlyph));
  }
  return out;
}

/** Narrow header: `RECEIPT #<id>` (single space), tokens greedy-packed, no indent, no leading separator. */
function narrowHeader(ctx: Ctx, r: Receipt): string[] {
  const { line1, line2 } = headerParts(ctx, r);
  const tokens = [...line1, ...line2].map((p) => p.text);
  tokens[0] = (tokens[0] as string).replace('RECEIPT  #', 'RECEIPT #');
  return packTokens(tokens, ctx.geo.T, ctx.g.sepGlyph, ctx.g.ellipsis);
}

// ---------------------------------------------------------------------------
// CLAIMED / EVIDENCE
// ---------------------------------------------------------------------------

const GLYPH_KIND: Readonly<Record<ReceiptLine['glyph'], PaintKind>> = { ok: 'ok', bad: 'bad', unk: 'unk', said: 'dim' };

/** Post-final agent notes rendered individually before the tail aggregates. */
const PF_NOTES_MAX = 3;

/**
 * Fits a claim into `budget` columns: the longest path-like token (contains
 * `/`) is middle-truncated first, keeping the basename (§10.1 file claims),
 * then the sentence is truncated with the ellipsis.
 */
function fitClaim(ctx: Ctx, claim: string, budget: number): string {
  let text = claim;
  let over = displayWidth(text) - budget;
  if (over > 0) {
    const tokens = text.split(' ');
    let best = -1;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (t.includes('/') && (best === -1 || displayWidth(t) > displayWidth(tokens[best] as string))) best = i;
    }
    if (best !== -1) {
      const token = tokens[best] as string;
      const target = Math.max(13, displayWidth(token) - over);
      if (target < displayWidth(token)) {
        tokens[best] = middleTruncatePath(token, target, ctx.g.ellipsis);
        text = tokens.join(' ');
      }
    }
  }
  over = displayWidth(text) - budget;
  return over > 0 ? truncateToWidth(text, budget, ctx.g.ellipsis) : text;
}

/** Evidence chunks of one row: split at ` · ` first, then sanitise and (ASCII) transliterate each chunk. */
function evidenceChunks(ctx: Ctx, line: ReceiptLine): string[] {
  const chunks: string[] = [];
  for (const s of line.evidence) for (const part of s.split(' · ')) chunks.push(tl(ctx, sanitizeForCell(part)));
  return chunks;
}

/** One claim's rows in wide mode: glyph + claim column, evidence column beside it (≤ 2 evidence lines). */
function wideClaimRows(ctx: Ctx, line: ReceiptLine): string[] {
  const { C, E } = ctx.geo;
  const glyph = pk(ctx, GLYPH_KIND[line.glyph], ctx.g[line.glyph]);
  const claim = fitClaim(ctx, sanitizeForCell(line.claim), C - 2);
  const evLines = wrapEvidence(evidenceChunks(ctx, line), E, ctx.g.sepGlyph, ctx.g.ellipsis);
  const rows = [padEnd(`${glyph} ${claim}`, C + 2) + (evLines[0] ?? '')];
  for (const ev of evLines.slice(1)) rows.push(padEnd('', C + 2) + ev);
  return rows;
}

/** One claim's rows in narrow mode: claim on one line, evidence indented 4 and wrapped to ≤ 2 lines. */
function narrowClaimRows(ctx: Ctx, line: ReceiptLine): string[] {
  const { T } = ctx.geo;
  const glyph = pk(ctx, GLYPH_KIND[line.glyph], ctx.g[line.glyph]);
  const claim = fitClaim(ctx, sanitizeForCell(line.claim), T - 2);
  const rows = [`${glyph} ${claim}`];
  for (const ev of wrapEvidence(evidenceChunks(ctx, line), T - 4, ctx.g.sepGlyph, ctx.g.ellipsis)) rows.push(`    ${ev}`);
  return rows;
}

/** The CLAIMED/EVIDENCE section (§5.2 cap: ≤ `capRows` rows + `+N more claims · showreceipts session <id>`). */
function claimsSection(ctx: Ctx, r: Receipt, opts: TermOptions): string[] {
  const out: string[] = [];
  if (ctx.geo.wide) out.push(padEnd('CLAIMED', ctx.geo.C + 2) + 'EVIDENCE');
  const cap = opts.allClaims === true ? undefined : opts.capRows;
  const shown = cap !== undefined && r.lines.length > cap ? r.lines.slice(0, cap) : r.lines;
  for (const line of shown) out.push(...(ctx.geo.wide ? wideClaimRows(ctx, line) : narrowClaimRows(ctx, line)));
  if (shown.length < r.lines.length) {
    const tail = tl(ctx, `+${r.lines.length - shown.length} more claims · showreceipts session ${sanitizeForCell(r.shortId)}`);
    out.push(...packLines(tail.split(tl(ctx, ' · ')), ctx.geo.T, ctx.g.sepGlyph));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kind texts, ALSO SAID / ALSO DID, stats, cost, verdict
// ---------------------------------------------------------------------------

/** The body text of a `no-claims`/`no-final`/`no-turns` receipt (§10.1 kind texts). */
function kindText(ctx: Ctx, r: Receipt): string {
  switch (r.kind) {
    case 'no-claims':
      return tl(ctx, `no claims recognized in the final message (0 claims · ${plural(r.stats.sentencesScanned, 'sentence')})`);
    case 'no-final': {
      const reason = r.finalStopReason === undefined || r.finalStopReason === null ? '' : ` (stop_reason: ${sanitizeForCell(r.finalStopReason)})`;
      return `turn ended without a final message${reason}`;
    }
    case 'no-turns': {
      const slash = r.slashCommands === undefined || r.slashCommands === 0 ? '' : `, ${plural(r.slashCommands, 'slash command')}`;
      return `no assistant turns in this session (${plural(r.records ?? 0, 'record')}${slash})`;
    }
    case 'scored':
      return '';
  }
}

/** ALSO SAID (dim), ALSO DID (`+N more` already applied by the pipeline) and the post-final note. */
function alsoSection(ctx: Ctx, r: Receipt): string[] {
  const { T } = ctx.geo;
  const out: string[] = [];
  if (r.alsoSaid.length > 0) {
    out.push(pk(ctx, 'dim', 'ALSO SAID (not scored)'));
    for (const said of r.alsoSaid) {
      const lines = wrapWords(sanitizeForCell(said), T - 2, 2, ctx.g.ellipsis);
      out.push(pk(ctx, 'dim', `${ctx.g.said} ${lines[0] ?? ''}`));
      for (const cont of lines.slice(1)) out.push(pk(ctx, 'dim', `  ${cont}`));
    }
  }
  if (r.alsoDid.length > 0) {
    out.push('ALSO DID (not mentioned)');
    for (const did of r.alsoDid) {
      const warn = did.warn === true;
      const bullet = warn ? pk(ctx, 'warn', ctx.g.warn) : pk(ctx, 'dim', ctx.g.did);
      const lines = wrapWords(tl(ctx, sanitizeForCell(did.text)), T - 2, 2, ctx.g.ellipsis);
      out.push(`${bullet} ${lines[0] ?? ''}`);
      for (const cont of lines.slice(1)) out.push(`  ${cont}`);
    }
  }
  // Per-agent notes cap: a real session with 46 post-final subagents rendered
  // 92 note lines and drowned the receipt, so beyond PF_NOTES_MAX agents the
  // tail collapses into one aggregate line (tool calls sum exactly; files
  // could double-count across agents, so the aggregate omits them).
  const pfs = r.postFinal ?? [];
  const pfShown = pfs.length > PF_NOTES_MAX ? pfs.slice(0, PF_NOTES_MAX) : pfs;
  for (const pf of pfShown) {
    const who = pf.agentId === null ? 'the main agent' : `agent ${sanitizeForCell(pf.agentId)}`;
    const note =
      `after this message: ${who} ran ${plural(pf.toolCalls, 'tool call')} ` +
      `(${plural(pf.files, 'file')}, ${plural(pf.testRuns, 'test run')}) ${ctx.g.emDash} not evidence for the claims above`;
    for (const line of wrapWords(tl(ctx, note), T, 2, ctx.g.ellipsis)) out.push(pk(ctx, 'dim', line));
  }
  if (pfs.length > pfShown.length) {
    const rest = pfs.slice(pfShown.length);
    const calls = rest.reduce((sum, pf) => sum + pf.toolCalls, 0);
    const note =
      `after this message: ${plural(rest.length, 'more agent')} ran ${plural(calls, 'tool call')} ` +
      `${ctx.g.emDash} not evidence for the claims above`;
    for (const line of wrapWords(tl(ctx, note), T, 2, ctx.g.ellipsis)) out.push(pk(ctx, 'dim', line));
  }
  return out;
}

/** Stats chunks (§10.1: zero items omitted except tool calls, files changed and test runs). */
function statsChunks(r: Receipt): string[] {
  if (r.kind === 'no-turns') return ['0 tool calls', '0 files changed'];
  const chunks = [
    plural(r.stats.toolCalls, 'tool call'),
    `${r.stats.filesChanged} files changed`,
    plural(r.stats.testRuns, 'test run'),
  ];
  if (r.stats.compactions > 0) chunks.push(plural(r.stats.compactions, 'compaction'));
  if (r.stats.subagents > 0) chunks.push(plural(r.stats.subagents, 'subagent'));
  return chunks;
}

/** Cost chunks (§8.3 wording); `null` when the cost line is omitted (`no-turns`). */
function costChunks(r: Receipt): string[] | null {
  if (r.kind === 'no-turns') return null;
  if (r.source === 'ledger') return ['cost n/a (hook-captured)'];
  const c = r.cost;
  const chunks = [`cost ${formatUsd(c.usd, c.unverified)} (API-equivalent)`];
  if (c.cacheHitPct !== null) chunks.push(`cache hit ${formatPct(c.cacheHitPct)}`);
  if (c.planUsagePct !== undefined) chunks.push(`plan usage ${formatPct(c.planUsagePct)}`);
  if (c.asOf !== undefined) chunks.push(`prices as of ${sanitizeForCell(c.asOf)}`);
  return chunks;
}

/** Verdict chunks (worst-first, zeros omitted) and the paint kind of the worst status. */
function verdictParts(r: Receipt): { chunks: string[]; kind: PaintKind } {
  switch (r.verdict) {
    case 'NO_TURNS':
      return { chunks: ['VERDICT: —'], kind: 'dim' };
    case 'NO_FINAL':
      return { chunks: ['VERDICT: NO FINAL MESSAGE'], kind: 'dim' };
    case 'NO_CLAIMS':
      return { chunks: ['VERDICT: NO CLAIMS'], kind: 'dim' };
    default: {
      const chunks: string[] = [];
      if (r.counts.CONTRADICTED > 0) chunks.push(`${r.counts.CONTRADICTED} CONTRADICTED`);
      if (r.counts.UNVERIFIED > 0) chunks.push(`${r.counts.UNVERIFIED} UNVERIFIED`);
      if (r.counts.VERIFIED > 0) chunks.push(`${r.counts.VERIFIED} VERIFIED`);
      (chunks[0] as string | undefined) === undefined ? chunks.push('VERDICT: NO CLAIMS') : (chunks[0] = `VERDICT: ${chunks[0] as string}`);
      const kind: PaintKind = r.verdict === 'CONTRADICTED' ? 'bad' : r.verdict === 'UNVERIFIED' ? 'unk' : 'ok';
      return { chunks, kind };
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Renders one receipt as the lines of the §10.1 box: header · rule ·
 * CLAIMED/EVIDENCE (or the kind text) · rule · ALSO SAID / ALSO DID · rule ·
 * stats · cost · VERDICT. Every line's display width is at most `opts.cols`
 * (the snapshot matrix asserts it at every width and mode).
 */
export function renderReceiptLines(receipt: Receipt, opts: TermOptions): string[] {
  const geo = geometry(opts.cols);
  const g = glyphSet(opts.unicode);
  const ctx: Ctx = { g, geo, frame: boxFrame(geo, g.box), color: opts.color === true, tz: opts.tz ?? 'utc', homeDir: opts.homeDir };
  const put = (lines: readonly string[], out: string[]): void => {
    for (const line of lines) out.push(ctx.frame.line(line));
  };

  const out: string[] = [ctx.frame.top];
  put(geo.wide ? wideHeader(ctx, receipt) : narrowHeader(ctx, receipt), out);
  out.push(ctx.frame.rule);

  if (receipt.kind === 'scored') {
    put(claimsSection(ctx, receipt, opts), out);
  } else {
    put(wrapWords(kindText(ctx, receipt), geo.T, 3, g.ellipsis), out);
  }

  const also = alsoSection(ctx, receipt);
  if (also.length > 0) {
    out.push(ctx.frame.rule);
    put(also, out);
  }

  out.push(ctx.frame.rule);
  put(packLines(statsChunks(receipt).map((c) => tl(ctx, c)), geo.T, g.sepGlyph), out);
  const cost = costChunks(receipt);
  if (cost !== null) put(packLines(cost.map((c) => tl(ctx, c)), geo.T, g.sepGlyph), out);
  const verdict = verdictParts(receipt);
  put(
    packLines(verdict.chunks.map((c) => tl(ctx, c)), geo.T, g.sepGlyph).map((line) => pk(ctx, verdict.kind, line)),
    out,
  );
  out.push(ctx.frame.bottom);
  return out;
}

/** {@link renderReceiptLines} joined with newlines, ending in exactly one. */
export function renderReceipt(receipt: Receipt, opts: TermOptions): string {
  return `${renderReceiptLines(receipt, opts).join('\n')}\n`;
}
