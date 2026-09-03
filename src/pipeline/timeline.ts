/**
 * The evidence timeline (ARCHITECTURE §5.2, §12.1 `session --timeline`,
 * S18): every tool call of one turn becomes a `TimelineEntry` with a
 * sanitised summary, semantic flags (`test|check|git|write|danger|error|
 * background`), the call's files and exit, and a per-call `usd` taken from
 * the *nearest* usage row (Claude Code) or `token_count` delta (Codex) —
 * the API call that produced the tool use. Ledger sessions have no usage,
 * so `usd` stays `null`.
 *
 * The Codex stdin facts are structured on the model (`ToolCall.stdinWrite`,
 * `stdinWrites[]`, `target.interrupted` — W1 merge note); the user-facing
 * wording "interactive input" / "interrupted by Ctrl-C" is composed here.
 */
import type { Session, TimelineEntry, ToolCall, Turn, UsageRow, TokenDelta } from '../model/types.js';
import { priceClaudeCode, priceCodex } from '../cost/cost.js';
import type { PriceTable } from '../cost/resolve.js';
import { sanitizeForCell } from '../util/sanitize.js';

/** Longest summary kept (renderers truncate further to their width). */
const SUMMARY_MAX = 160;

export interface TimelineOptions {
  table: PriceTable;
  asOf?: string | undefined;
}

/** Sanitised, capped one-line summary text. */
function summaryText(s: string): string {
  const clean = sanitizeForCell(s);
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
}

/** The stdin-interaction facts recorded on a call's *target* (§4.3.3): chars and Ctrl-C, by writer seq. */
function stdinFactsFor(seq: number, calls: readonly ToolCall[]): { chars: number; interrupted: boolean } | null {
  for (const target of calls) {
    for (const w of target.stdinWrites ?? []) {
      if (w.seq === seq) return { chars: w.chars, interrupted: w.interrupted === true || target.interrupted };
    }
  }
  return null;
}

/** The human summary of one call (command text, file, url or tool name — never result output). */
function summaryOf(call: ToolCall, turnCalls: readonly ToolCall[]): string {
  if (call.stdinWrite === true) {
    const facts = stdinFactsFor(call.seq, turnCalls);
    const chars = facts !== null ? ` (${facts.chars} chars)` : '';
    const tail = facts !== null && facts.interrupted ? ' · interrupted by Ctrl-C' : '';
    return `interactive input${chars}${tail}`;
  }
  if (call.kind === 'shell' && call.command !== undefined && call.command !== '') return summaryText(call.command);
  if (call.kind === 'edit' || call.kind === 'write' || call.kind === 'read') {
    const path = call.filesTouched[0] ?? (typeof call.input['file_path'] === 'string' ? call.input['file_path'] : '');
    if (path !== '') return summaryText(path);
  }
  if (call.kind === 'fetch' && typeof call.input['url'] === 'string') return summaryText(call.input['url']);
  if (call.description !== undefined && call.description !== '') return summaryText(call.description);
  return summaryText(call.tool);
}

/** Index of the nearest element (by `seq`) at or before `seq`, else the first after; `-1` when empty. */
function nearestIndex(seqs: readonly number[], seq: number): number {
  if (seqs.length === 0) return -1;
  let lo = 0;
  let hi = seqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((seqs[mid] as number) <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : 0;
}

/** Memoised per-row / per-delta pricing for the `usd` column. */
class UsdIndex {
  private readonly rowSeqs: number[];
  private readonly rows: UsageRow[];
  private readonly deltaSeqs: number[];
  private readonly deltas: TokenDelta[];
  private readonly memo = new Map<number, number | null>();

  constructor(
    private readonly session: Session,
    private readonly opts: TimelineOptions,
  ) {
    this.rows = [...session.usageRows].sort((a, b) => a.seq - b.seq);
    this.rowSeqs = this.rows.map((r) => r.seq);
    this.deltas = [...session.tokenDeltas].sort((a, b) => a.seq - b.seq);
    this.deltaSeqs = this.deltas.map((d) => d.seq);
  }

  usdFor(seq: number): number | null {
    if (this.session.source === 'ledger') return null;
    if (this.deltas.length > 0) {
      const i = nearestIndex(this.deltaSeqs, seq);
      if (i < 0) return null;
      return this.priced(i, () => priceCodex([this.deltas[i] as TokenDelta], { table: this.opts.table, asOf: this.opts.asOf }).usd);
    }
    const i = nearestIndex(this.rowSeqs, seq);
    if (i < 0) return null;
    const row = this.rows[i] as UsageRow;
    if (row.inherited === true) return null;
    return this.priced(i + 1_000_000, () => priceClaudeCode([row], { table: this.opts.table, asOf: this.opts.asOf }).usd);
  }

  private priced(key: number, compute: () => number | null): number | null {
    let usd = this.memo.get(key);
    if (usd === undefined) {
      usd = compute();
      this.memo.set(key, usd);
    }
    return usd;
  }
}

/** The semantic flags of one call, in fixed order. */
function flagsOf(call: ToolCall, session: Session): string[] {
  const ledger = session.ledger;
  const flags: string[] = [];
  if (ledger.testRuns.some((t) => t.toolCallId === call.id && t.kind === 'run')) flags.push('test');
  if (ledger.checks.some((c) => c.toolCallId === call.id)) flags.push('check');
  if (ledger.git.some((g) => g.seq === call.seq)) flags.push('git');
  if (call.kind === 'edit' || call.kind === 'write' || ledger.writes.some((w) => w.toolCallId === call.id && w.status === 'ok')) {
    flags.push('write');
  }
  if (ledger.danger.some((d) => d.seq === call.seq && d.tier === 'danger')) flags.push('danger');
  if (call.isError || (call.exitCode !== null && call.exitCode !== 0)) flags.push('error');
  if (call.background) flags.push('background');
  return flags;
}

/**
 * Builds the timeline of one turn (§5.2): its tool calls in `seq` order —
 * post-final calls included, they carry their `postFinal` mark on the model —
 * each with summary, flags, files, exit and the `usd` of the nearest usage
 * row / token delta priced with `opts.table` (and `--as-of`).
 */
export function buildTimeline(session: Session, turn: Turn, opts: TimelineOptions): TimelineEntry[] {
  const turnCalls = session.toolCalls.filter((c) => c.turnIndex === turn.index).sort((a, b) => a.seq - b.seq);
  const usd = new UsdIndex(session, opts);
  return turnCalls.map((call) => ({
    seq: call.seq,
    at: call.startedAt,
    tool: call.tool,
    kind: call.kind,
    summary: summaryOf(call, turnCalls),
    exit: call.exitCode,
    files: [...call.filesTouched],
    usd: usd.usdFor(call.seq),
    agentId: call.agentId,
    flags: flagsOf(call, session),
  }));
}
