/**
 * `showreceipts session <id|prefix|path|latest>` (ARCHITECTURE §12.1, S24) —
 * the full receipt for one session: every claim with its evidence
 * (no 12-row cap, §10.1), `--timeline` appending the evidence timeline,
 * `--explain-claim` the per-claim explanation block (rule, trigger, cue,
 * reconcile row, facts examined — §5.1), `--turn N` picking another turn,
 * and `--json` emitting the canonical `Receipt` (§12.3, with `timeline` /
 * `explanations` embedded when requested).
 *
 * Selector resolution is S21's `pipeline/resolve-session.ts`: not-found and
 * ambiguous prefixes exit 5 with the candidates printed (§12.2). This is a
 * single-session command — the cross-session usage dedupe (§8.3) must NOT
 * run here; receipts stay per-session.
 */
import type { Explanation, Receipt } from '../model/types.js';
import type { CommandContext } from '../cli/context.js';
import { buildReceipt, receiptToJson, type ReceiptOptions } from '../pipeline/receipt.js';
import { AmbiguousError, NotFoundError, resolveSession } from '../pipeline/resolve-session.js';
import { loadSessions, type LoadResult } from '../pipeline/run.js';
import { packLines } from '../render/box.js';
import { glyphSet, transliterate } from '../render/glyphs.js';
import { renderReceipt } from '../render/term.js';
import { renderTimeline } from '../render/timeline.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { truncateToWidth } from '../util/width.js';
import { applyUntil } from './audit.js';
import { CommandUsageError, loadOptionsOf, prepare, startProgress, type Prepared } from './common.js';
import { sharedOptions, usage, type HelpSection } from './help.js';

/** The §12.4 help section of `session` (S24; pinned against `cli/help.ts` by the drift tests). */
export const HELP: HelpSection = {
  summary: 'Full receipt for one session (id prefix, path, or "latest") with the evidence timeline',
  synopsis: 'showreceipts session <id|prefix|path|latest> [--turn N] [--json] [--explain-claim] [--timeline] [--no-cache] [common options]',
  detail:
    'Prints the full receipt for one session, every claim with its evidence, selected by id prefix, transcript path or "latest". --timeline adds the evidence timeline, --explain-claim shows how each claim was recognised and judged, --turn N picks a turn other than the last done one. Exits 5 when the id is not found or the prefix is ambiguous (the candidates are listed).',
  options: [
    ...sharedOptions(['since', 'until', 'all', 'harness', 'project', 'json', 'width', 'ascii', 'unicode', 'no-color', 'tz', 'now', 'no-cache', 'as-of', 'prices']),
    { flag: 'turn', arg: '<n>', text: 'Receipt for turn N instead of the last done turn' },
    { flag: 'explain-claim', text: 'Show how each claim was recognised and judged' },
    { flag: 'timeline', text: 'Include the evidence timeline' },
    { flag: 'verbose', text: 'Print unknown-shape counts and other diagnostics' },
    ...sharedOptions(['debug']),
  ],
};

/** Prints an exit-5 resolver failure (message plus, for an ambiguous prefix, the candidate rows — §12.2). */
export function reportResolveFailure(ctx: CommandContext, err: AmbiguousError | NotFoundError): number {
  ctx.stderr.write(`showreceipts: ${err.message}\n`);
  if (err instanceof AmbiguousError) {
    for (const c of err.candidates) {
      ctx.stderr.write(`  ${c.shortId}  ${c.harness}  ${c.sessionId}  ${c.endedAt}\n`);
    }
  }
  return 5;
}

/**
 * The `--explain-claim` text block (§5.1): one numbered entry per judgement
 * with the claim clause, the recognising rule (trigger and cue re-derived
 * from the final text), the §4.8 reconcile row, the one-line verdict `why`
 * and the facts the row examined. Transcript-derived pieces (clause,
 * trigger, cue) are sanitised but never transliterated; engine-composed
 * pieces (`why`, facts) are transliterated in ASCII mode (§10.1 discipline).
 */
export function renderExplanations(explanations: readonly Explanation[], opts: { cols: number; unicode: boolean }): string[] {
  const g = glyphSet(opts.unicode);
  const budget = Math.max(40, Math.min(opts.cols, 200)) - 2;
  const engine = (s: string): string => (g.unicode ? s : transliterate(s));
  const cut = (s: string): string => truncateToWidth(s, budget, g.ellipsis);
  const lines: string[] = ['EXPLANATIONS'];
  if (explanations.length === 0) {
    lines.push('  no claims to explain');
    return lines;
  }
  explanations.forEach((e, i) => {
    lines.push(cut(`${i + 1}. ${sanitizeForCell(e.clause)}`));
    const parts = [`rule ${sanitizeForCell(e.rule)}`];
    if (e.trigger !== '') parts.push(`trigger "${sanitizeForCell(e.trigger)}"`);
    if (e.cue !== '') parts.push(`cue "${sanitizeForCell(e.cue)}"`);
    parts.push(`reconcile row ${e.row}`);
    // wrap at the separator instead of truncating — no part may be dropped
    for (const packed of packLines(parts, budget - 3, g.sepGlyph)) lines.push(cut(`   ${packed}`));
    lines.push(cut(`   ${engine(sanitizeForCell(e.why))}`));
    for (const fact of e.factsExamined) lines.push(cut(`     - ${engine(sanitizeForCell(fact))}`));
  });
  return lines;
}

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  if (ctx.args.flags['help'] === true) {
    ctx.stdout.write(usage('session', HELP));
    return 0;
  }
  const flags = ctx.args.flags;
  const selector = ctx.args.positionals[0];
  if (selector === undefined || selector.trim() === '') {
    throw new CommandUsageError('session: missing <id|prefix|path|latest>', 'session');
  }

  const prepared: Prepared = prepare(ctx);
  for (const note of prepared.priceNotes) ctx.stderr.write(`showreceipts: ${note}\n`);

  const progress = startProgress(ctx, { json: prepared.json });
  let load: LoadResult;
  try {
    load = await loadSessions(loadOptionsOf(prepared, progress.onProgress));
  } finally {
    progress.finish();
  }
  const sessions = applyUntil(load.sessions, prepared.untilMs);

  let session;
  try {
    session = await resolveSession(selector, {
      sessions,
      roots: prepared.roots,
      cwd: ctx.cwd,
      window: { all: prepared.all, since: typeof flags['since'] === 'string' ? flags['since'] : '90d' },
    });
  } catch (err) {
    if (err instanceof AmbiguousError || err instanceof NotFoundError) return reportResolveFailure(ctx, err);
    throw err;
  }

  const turn = typeof flags['turn'] === 'number' ? flags['turn'] : undefined;
  if (turn !== undefined && !session.turns.some((t) => t.index === turn)) {
    throw new CommandUsageError(`--turn: no turn ${turn} in session ${session.shortId}`, 'session');
  }

  const wantTimeline = flags['timeline'] === true;
  const wantExplain = flags['explain-claim'] === true;
  const opts: ReceiptOptions = {
    now: prepared.now,
    prices: prepared.prices,
    homeDir: prepared.homeDir,
    turnIndex: turn,
    asOf: prepared.asOf,
    timeline: wantTimeline,
    explain: wantExplain,
  };
  const receipt: Receipt = buildReceipt(session, opts);

  if (prepared.json) {
    ctx.stdout.write(`${receiptToJson(receipt)}\n`);
    return 0;
  }

  const { cols, unicode, color, tz } = prepared.render;
  const pieces: string[] = [renderReceipt(receipt, { cols, unicode, color, tz, homeDir: prepared.homeDir }).trimEnd()];
  if (wantTimeline) {
    const entries = receipt.timeline ?? [];
    pieces.push(
      '',
      ...(entries.length === 0
        ? ['no timeline (no tool calls in this turn)']
        : renderTimeline(entries, { cols, unicode, color, tz, startedAt: receipt.startedAt })),
    );
  }
  if (wantExplain) {
    pieces.push('', ...renderExplanations(receipt.explanations ?? [], { cols, unicode }));
  }
  ctx.stdout.write(`${pieces.join('\n')}\n`);
  return 0;
}
