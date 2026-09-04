/**
 * `showreceipts audit` (ARCHITECTURE §12.1, §10.1–§10.2, S24) — the default
 * command: scan every session log on disk, then print the audit screen
 * (header · session table · latest receipt · false-done rate table ·
 * footer) or, with `--json`, the `showreceipts.audit/1` envelope (§12.3).
 *
 * Composition per §5.3/§5.4: the shared preparation (`commands/common.ts`)
 * resolves roots, window, prices and render options; `loadSessions` scans;
 * `--until` is applied post-load (S23c decision); the cross-session usage
 * dedupe (`pipeline/dedupe.ts`, §8.3 scope rule) runs before any total —
 * `audit` is an aggregate command, unlike `session`/`export`. The latest
 * receipt is the newest session with ≥ 1 done turn, capped at 12 claim rows
 * unless `--all-claims` (§10.1).
 *
 * Failure containment (§12.2): `audit` never fails because of one bad file —
 * per-file problems land in `diagnostics.problems` and a stderr note; the
 * command still exits 0. "No sessions found" is a success with a friendly
 * hint at `showreceipts demo`.
 */
import type { Harness, RateRow, Receipt, Session, SessionCard } from '../model/types.js';
import { HARNESSES, HARNESS_LABELS } from '../model/types.js';
import type { CommandContext } from '../cli/context.js';
import { buildRateRows, buildSessionCard, sessionKey } from '../pipeline/cards.js';
import { dedupeUsage } from '../pipeline/dedupe.js';
import { buildReceipt, buildTurnReceipts, type ReceiptOptions } from '../pipeline/receipt.js';
import { loadSessions, type LoadDiagnostics, type LoadResult, type ScannedSummary } from '../pipeline/run.js';
import { glyphSet } from '../render/glyphs.js';
import { renderAuditFooter, renderAuditHeader, renderRateTable, renderSessionTable, type AuditScan } from '../render/summary.js';
import { renderReceipt } from '../render/term.js';
import { inspectHooks } from '../setup/inspect.js';
import { stableStringify } from '../util/json.js';
import { parseIso } from '../util/time.js';
import { loadOptionsOf, prepare, startProgress, type Prepared } from './common.js';
import { sharedOptions, usage, type HelpSection } from './help.js';

/** The audit-table claim-row cap the latest receipt renders under (§10.1). */
const AUDIT_CAP_ROWS = 12;

/** The §12.4 help section of `audit` (S24; pinned against `cli/help.ts` by the drift tests). */
export const HELP: HelpSection = {
  summary: 'Scan agent session logs on disk; print a summary, the latest receipt and your false-done rate',
  synopsis:
    'showreceipts [audit] [--since 90d|YYYY-MM-DD] [--until …] [--all] [--harness h[,h]] [--project <substr|path>] [--limit N] [--all-claims] [--json] [--no-cache] [--as-of DATE] [--prices FILE] [--width N] [--ascii|--unicode] [--no-color] [--tz local|utc] [--now ISO]',
  detail:
    'Scans the agent session logs found on this machine (Claude Code and Codex transcripts, hook-captured ledgers), builds a receipt for the last "done" turn of every session in the window, then prints a summary table, the most recent receipt and your false-done rate. Read-only over the logs; never fails because of one bad file; exits 0 even when no session is found.',
  options: [
    ...sharedOptions(['since', 'until', 'all', 'harness', 'project']),
    { flag: 'limit', arg: '<n>', text: 'Rows in the session table (default 20)' },
    { flag: 'all-claims', text: 'Show every claim of the latest receipt (default: 12 rows)' },
    ...sharedOptions(['json', 'width', 'ascii', 'unicode', 'no-color', 'tz', 'now', 'no-cache', 'as-of', 'prices']),
    { flag: 'verbose', text: 'Print unknown-shape counts and other diagnostics' },
    ...sharedOptions(['debug']),
  ],
};

/** The `audit --json` envelope (§12.3, `docs/receipt-schema.md` block `audit`). */
export interface AuditJson {
  schema: 'showreceipts.audit/1';
  toolVersion: string;
  rulesVersion: string;
  pricesVersion: string;
  generatedAt: string;
  scanned: ScannedSummary;
  sessions: SessionCard[];
  rate: RateRow[];
  latest: Receipt | null;
  diagnostics: LoadDiagnostics;
}

/** Applies the `--until` boundary (exclusive, S23c) to the loaded sessions; unknown `endedAt` is kept. */
export function applyUntil(sessions: readonly Session[], untilMs: number | undefined): Session[] {
  if (untilMs === undefined) return [...sessions];
  return sessions.filter((s) => {
    const endedMs = parseIso(s.endedAt);
    return endedMs === null || endedMs < untilMs;
  });
}

/** Recomputes the `scanned` block over the post-`--until` session set (bytes/cacheHits stay load facts). */
function scannedOf(sessions: readonly Session[], load: LoadResult): ScannedSummary {
  const byHarness: Partial<Record<Harness, number>> = {};
  let fromMs: number | null = null;
  let from: string | null = null;
  let toMs: number | null = null;
  let to: string | null = null;
  for (const s of sessions) {
    byHarness[s.harness] = (byHarness[s.harness] ?? 0) + 1;
    const startMs = parseIso(s.startedAt);
    if (startMs !== null && (fromMs === null || startMs < fromMs)) {
      fromMs = startMs;
      from = s.startedAt;
    }
    const endMs = parseIso(s.endedAt);
    if (endMs !== null && (toMs === null || endMs > toMs)) {
      toMs = endMs;
      to = s.endedAt;
    }
  }
  return { sessions: sessions.length, byHarness, from, to, bytes: load.scanned.bytes, cacheHits: load.scanned.cacheHits };
}

/** The newest session with ≥ 1 done turn (§10.1 "latest"); `sessions` is already (`endedAt` desc) sorted. */
function latestDoneSession(sessions: readonly Session[]): Session | null {
  return sessions.find((s) => s.kind === 'normal' && s.turns.some((t) => t.isDone)) ?? null;
}

/** The header's per-harness counts, in the fixed enum order, zero rows omitted (§10.2). */
function headerScan(prepared: Prepared, scanned: ScannedSummary): AuditScan {
  const byHarness: { label: string; sessions: number }[] = [];
  for (const h of HARNESSES) {
    const n = scanned.byHarness[h];
    if (n !== undefined && n > 0) byHarness.push({ label: HARNESS_LABELS[h], sessions: n });
  }
  return {
    toolVersion: prepared.versions.toolVersion,
    sessions: scanned.sessions,
    byHarness,
    from: scanned.from ?? undefined,
    to: scanned.to ?? undefined,
  };
}

/** True when no showreceipts hook is installed anywhere `inspectHooks` can see (§10.2 footer hint). */
function noHooksInstalled(prepared: Prepared, cwd: string): boolean {
  try {
    const rows = inspectHooks(prepared.userHome, cwd, {
      claudeConfigDir: prepared.roots.claudeConfigDir,
      codexHome: prepared.roots.codexHome,
      showreceiptsHome: prepared.roots.showreceiptsHome,
    });
    return !rows.some((r) => r.installed);
  } catch {
    return true; // nothing inspectable ⇒ nothing installed
  }
}

/** Writes the non-fatal notes (§8.1 price-override problems, skipped files) to stderr. */
function writeNotes(ctx: CommandContext, prepared: Prepared, diagnostics: LoadDiagnostics): void {
  for (const note of prepared.priceNotes) ctx.stderr.write(`showreceipts: ${note}\n`);
  if (diagnostics.problems.length === 0) return;
  if (prepared.verbose) {
    for (const problem of diagnostics.problems) ctx.stderr.write(`showreceipts: skipped ${problem}\n`);
  } else {
    const n = diagnostics.problems.length;
    ctx.stderr.write(`showreceipts: skipped ${n} unreadable file${n === 1 ? '' : 's'} (run with --verbose for details)\n`);
  }
}

/** `--verbose`: unknown-shape warning counts on stderr (§12.2 — warnings, never failures). */
function writeVerboseDiagnostics(ctx: CommandContext, diagnostics: LoadDiagnostics): void {
  const maps: [string, Record<string, number>][] = [
    ['unknown record types', diagnostics.unknownRecordTypes],
    ['unknown subtypes', diagnostics.unknownSubtypes],
    ['unknown tool shapes', diagnostics.unknownToolShapes],
    ['unknown content blocks', diagnostics.unknownContentBlocks],
    ['unknown codex payloads', diagnostics.unknownCodexPayloads],
  ];
  for (const [label, map] of maps) {
    const entries = Object.entries(map);
    if (entries.length === 0) continue;
    const text = entries.map(([k, v]) => `${k}=${v}`).join(', ');
    ctx.stderr.write(`showreceipts: ${label}: ${text}\n`);
  }
  if (diagnostics.badLines > 0) ctx.stderr.write(`showreceipts: bad lines: ${diagnostics.badLines}\n`);
}

/** The receipt options every audit receipt shares (§5.2; prices/`--as-of` run post-cache). */
function receiptOptionsOf(prepared: Prepared): ReceiptOptions {
  return {
    now: prepared.now,
    prices: prepared.prices,
    homeDir: prepared.homeDir,
    asOf: prepared.asOf,
  };
}

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  if (ctx.args.flags['help'] === true) {
    ctx.stdout.write(usage('audit', HELP));
    return 0;
  }
  const prepared = prepare(ctx);

  const progress = startProgress(ctx, { json: prepared.json });
  let load: LoadResult;
  try {
    load = await loadSessions(loadOptionsOf(prepared, progress.onProgress));
  } finally {
    progress.finish();
  }

  const sessions = applyUntil(load.sessions, prepared.untilMs);
  // §8.3 scope rule: aggregate totals dedupe `message.id`s across every
  // scanned session; receipts themselves stay per-session.
  dedupeUsage(sessions);

  const opts = receiptOptionsOf(prepared);
  const turnReceipts = new Map(sessions.map((s) => [sessionKey(s), buildTurnReceipts(s, opts)] as const));
  const cards = sessions.map((s) => buildSessionCard(s, turnReceipts.get(sessionKey(s)) as Map<number, Receipt>));
  const rate = buildRateRows(sessions, turnReceipts);
  const latestSession = latestDoneSession(sessions);
  const latest = latestSession === null ? null : buildReceipt(latestSession, opts);
  const scanned = scannedOf(sessions, load);

  writeNotes(ctx, prepared, load.diagnostics);
  if (prepared.verbose && !prepared.json) writeVerboseDiagnostics(ctx, load.diagnostics);

  if (prepared.json) {
    const envelope: AuditJson = {
      schema: 'showreceipts.audit/1',
      toolVersion: prepared.versions.toolVersion,
      rulesVersion: prepared.versions.rulesVersion,
      pricesVersion: prepared.versions.pricesVersion,
      generatedAt: prepared.now.toISOString(),
      scanned,
      sessions: cards,
      rate,
      latest,
      diagnostics: load.diagnostics,
    };
    ctx.stdout.write(`${stableStringify(envelope)}\n`);
    return 0;
  }

  const { cols, unicode, color, tz } = prepared.render;
  const g = glyphSet(unicode);
  const sep = g.unicode ? ' · ' : ' - ';

  if (sessions.length === 0) {
    ctx.stdout.write(`no sessions found${sep}try 'showreceipts demo' for sample receipts\n`);
    return 0;
  }

  const summary = { cols, unicode };
  const limit = typeof ctx.args.flags['limit'] === 'number' ? ctx.args.flags['limit'] : undefined;
  const lines: string[] = [
    ...renderAuditHeader(headerScan(prepared, scanned), summary),
    '',
    ...renderSessionTable(cards, { ...summary, limit }),
  ];
  if (latest !== null) {
    lines.push(
      '',
      renderReceipt(latest, {
        cols,
        unicode,
        color,
        tz,
        homeDir: prepared.homeDir,
        capRows: AUDIT_CAP_ROWS,
        allClaims: ctx.args.flags['all-claims'] === true,
      }).trimEnd(),
    );
  }
  lines.push('', ...renderRateTable(rate, summary));
  lines.push(
    '',
    ...renderAuditFooter({ reportPath: '.showreceipts/report.html', showSetupHint: noHooksInstalled(prepared, ctx.cwd) }, summary),
  );
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
