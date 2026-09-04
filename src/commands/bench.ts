/**
 * `showreceipts bench [--since 30d] [--month YYYY-MM] [--harness …]
 * [--publish [FILE]] [--json]` (ARCHITECTURE §12.1, §13.3, S25): the
 * false-done / unverified / test-run rates per model × harness × version.
 *
 * The default window is the last 30 days (`--since` overrides; `--month`
 * snaps to one calendar month over `Turn.endedAt` in UTC). Aggregate totals
 * dedupe usage across sessions (`dedupeUsage`, §8.3) before receipts are
 * built. `--publish` snaps to a month (default: the previous complete one),
 * builds the §13.3 aggregates-only payload, validates it against every
 * Appendix D rule and refuses to write on any violation — the written bytes
 * are exactly the validated bytes, and two consecutive runs are
 * byte-identical.
 */
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import type { Receipt, Session } from '../model/types.js';
import { buildPublishPayload, buildPublishRows, monthBoundsMs, snapPeriod } from '../bench/publish.js';
import { validatePublish } from '../bench/validate.js';
import { RULES_VERSION } from '../claims/rules.js';
import { loadPriceTable } from '../cost/resolve.js';
import { dedupeUsage } from '../pipeline/dedupe.js';
import { buildTurnReceipts, type ReceiptOptions } from '../pipeline/receipt.js';
import { loadSessions } from '../pipeline/run.js';
import { aggregateRate, sessionKey, type ReceiptIndex } from '../reconcile/rate.js';
import { renderRateTable } from '../render/summary.js';
import { atomicWriteFile, ensureDir } from '../util/fs.js';
import { findGitRoot } from '../util/gitroot.js';
import { stableStringify } from '../util/json.js';
import { basename, displayPath } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { parseIso } from '../util/time.js';
import { loadOptionsOf, prepare, startProgress } from './common.js';
import { CLEANUP_NOTE } from './doctor.js';

const DAY_MS = 86_400_000;

/** A session copy whose turns are restricted to those ending in `[startMs, endMs)`. */
function turnsInWindow(session: Session, startMs: number, endMs: number): Session {
  return {
    ...session,
    turns: session.turns.filter((t) => {
      const ms = parseIso(t.endedAt);
      return ms !== null && ms >= startMs && ms < endMs;
    }),
  };
}

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  const prepared = prepare(ctx);
  const flags = ctx.args.flags;
  const month = typeof flags['month'] === 'string' ? flags['month'] : undefined;
  const publishFlag = flags['publish'];
  const publishing = publishFlag === true || (typeof publishFlag === 'string' && publishFlag !== '');

  // The month window (--month, or --publish's snap) over Turn.endedAt in UTC.
  let monthWindow: { startMs: number; endMs: number } | undefined;
  const period = publishing ? snapPeriod(prepared.now, month) : undefined;
  const windowMonth = period?.from ?? month;
  if (windowMonth !== undefined) {
    monthWindow = monthBoundsMs(windowMonth);
    // mtime prefilter with a day of tolerance; the turn filter is exact.
    prepared.all = false;
    prepared.sinceMs = monthWindow.startMs - DAY_MS;
  } else if (typeof flags['since'] !== 'string' && !prepared.all) {
    // bench defaults to 30d, not the shared 90d (§12.1).
    prepared.sinceMs = prepared.now.getTime() - 30 * DAY_MS;
  }

  const progress = startProgress(ctx, { json: prepared.json || publishing });
  const load = await loadSessions(loadOptionsOf(prepared, progress.onProgress));
  progress.finish();

  let sessions = load.sessions;
  if (monthWindow === undefined && prepared.untilMs !== undefined) {
    const until = prepared.untilMs;
    sessions = sessions.filter((s) => {
      const ms = parseIso(s.endedAt);
      return ms === null || ms < until;
    });
  }

  // Aggregate totals dedupe usage across every scanned session (§8.3).
  dedupeUsage(sessions);
  const receiptOpts: ReceiptOptions = {
    now: prepared.now,
    prices: prepared.prices,
    homeDir: prepared.homeDir,
    asOf: prepared.asOf,
  };
  const receipts = new Map<string, Map<number, Receipt>>();
  for (const session of sessions) receipts.set(sessionKey(session), buildTurnReceipts(session, receiptOpts));
  const index: ReceiptIndex = receipts;

  const rateSessions = monthWindow === undefined ? sessions : sessions.map((s) => turnsInWindow(s, monthWindow.startMs, monthWindow.endMs));
  const rows = aggregateRate(rateSessions, index);

  if (publishing && period !== undefined) {
    const builtin = loadPriceTable();
    const publishRows = buildPublishRows(rows, builtin);
    const payload = buildPublishPayload(publishRows, {
      version: prepared.versions.toolVersion,
      rulesVersion: RULES_VERSION,
      pricesVersion: builtin.version,
      os: process.platform,
      nodeMajor: String(Number(process.versions.node.split('.')[0])),
      period,
    });
    const serialized = `${stableStringify(payload)}\n`;
    const user = basename(prepared.userHome);
    const violations = validatePublish(payload, serialized, {
      builtinModelKeys: new Set(Object.keys(builtin.models)),
      homePaths: [prepared.userHome],
      hostname: hostname(),
      usernames: user.length >= 6 ? [user] : [],
      sessionIds: sessions.map((s) => s.sessionId),
      shortIds: sessions.map((s) => s.shortId),
    });
    if (violations.length > 0) {
      ctx.stderr.write(`showreceipts: bench --publish refused: ${violations[0] ?? 'validation failed'}\n`);
      if (prepared.verbose) for (const v of violations.slice(1)) ctx.stderr.write(`  ${v}\n`);
      return 1;
    }
    let out: string;
    if (typeof publishFlag === 'string' && publishFlag !== '') {
      out = normalize(isAbsolute(publishFlag) ? publishFlag : join(ctx.cwd, publishFlag));
    } else {
      const gitRoot = findGitRoot(ctx.cwd);
      const dir = gitRoot !== null ? join(gitRoot, '.showreceipts') : join(prepared.roots.showreceiptsHome, 'publish');
      out = join(dir, `${period.from}-${payload.contentHash}.json`);
    }
    ensureDir(dirname(out));
    atomicWriteFile(out, serialized);
    const arrow = prepared.render.unicode ? '→' : '->';
    ctx.stdout.write(
      `publish ${arrow} ${sanitizeForCell(displayPath(out, prepared.homeDir))} (${publishRows.length} row(s), ${period.from}${period.partial ? ', partial month' : ''})\n${CLEANUP_NOTE}\n`,
    );
    return 0;
  }

  if (prepared.json) {
    const fromMs = monthWindow?.startMs ?? prepared.sinceMs;
    const toMs = monthWindow?.endMs ?? prepared.untilMs;
    const window = {
      from: fromMs !== undefined ? new Date(fromMs).toISOString() : (load.scanned.from ?? new Date(0).toISOString()),
      to: toMs !== undefined ? new Date(toMs).toISOString() : prepared.now.toISOString(),
    };
    ctx.stdout.write(`${stableStringify({ schema: 'showreceipts.bench/1', window, rows })}\n`);
    return 0;
  }

  const sep = prepared.render.unicode ? ' · ' : ' - ';
  const header =
    windowMonth !== undefined
      ? `bench${sep}${windowMonth}${sep}${sessions.length} session(s)`
      : `bench${sep}${sessions.length} session(s)`;
  const lines = [header, ...renderRateTable(rows, { cols: prepared.render.cols, unicode: prepared.render.unicode }), '', CLEANUP_NOTE];
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
