/**
 * `showreceipts report [--out FILE] [--open] [--hash-paths|--hash-paths=both]
 * [--full N] [--bench] […window]` (ARCHITECTURE §11, §12.1, S25): builds the
 * single-file HTML report — payload via S22 (`render/payload.ts`,
 * `render/budget.ts`, `render/html.ts`) — and writes it to
 * `<git root ?? cwd>/.showreceipts/report.html` (or `--out`).
 *
 * Prints bytes per section (`cards/receipts/timelines/template`) and the
 * §11.1 soft/hard budget messages. `--bench` prints the sizes and card count
 * without writing. `--open` launches the written file via the platform
 * opener — the ONLY `child_process` use in `src/` (§13.4, allow-listed in
 * `scripts/check-no-network.mjs`), always an argv array (never a shell
 * string), `detached`, `stdio: 'ignore'`, unref'd; tests inject a fake
 * spawner and never spawn.
 */
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import type { RateRow, Receipt } from '../model/types.js';
import { buildRateRows, buildSessionCard } from '../pipeline/cards.js';
import { buildReceipt, buildTurnReceipts, type ReceiptOptions } from '../pipeline/receipt.js';
import { loadSessions } from '../pipeline/run.js';
import { buildTimeline } from '../pipeline/timeline.js';
import { sessionKey, type ReceiptIndex } from '../reconcile/rate.js';
import { applyBudget, type BudgetReport } from '../render/budget.js';
import { glyphSet } from '../render/glyphs.js';
import { renderHtml, type HashPathsMode } from '../render/html.js';
import { buildReportPayload, type ReportSessionInput } from '../render/payload.js';
import { assertRealDirectory, atomicWriteFile, ensureDir, lstatOrNull } from '../util/fs.js';
import { findGitRoot } from '../util/gitroot.js';
import { stableStringify } from '../util/json.js';
import { displayPath } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { parseIso } from '../util/time.js';
import { loadOptionsOf, prepare, startProgress } from './common.js';

/** What a spawner returns: `unref` is always called; a real `ChildProcess` also exposes `on`, used to catch the async spawn 'error'. */
export interface SpawnHandle {
  unref(): void;
  /** Present on real child processes: a missing opener binary (ENOENT) arrives here asynchronously. */
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** The process-spawning seam (§13.4): argv array, detached, ignored stdio. */
export type Spawner = (command: string, args: readonly string[], options: { detached: true; stdio: 'ignore' }) => SpawnHandle;

const defaultSpawner: Spawner = (command, args, options) => spawn(command, [...args], options);

/** The platform opener command for a report path — always an argv array. */
export function openCommandFor(platform: string, target: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] };
  return { command: 'xdg-open', args: [target] };
}

/**
 * Opens the written report in the default browser: `open` (darwin) /
 * `xdg-open` (linux) / `cmd /c start ""` (win32), detached with ignored
 * stdio and unref'd so the CLI never waits on the browser. Tests pass a
 * fake `spawner`; the default is the real `child_process.spawn`.
 */
export function openReport(target: string, platform: string, spawner: Spawner = defaultSpawner, onError?: (message: string) => void): void {
  const { command, args } = openCommandFor(platform, target);
  const child = spawner(command, args, { detached: true, stdio: 'ignore' });
  // The opener binary can be missing (xdg-open on minimal Linux): spawn()
  // delivers ENOENT asynchronously on the child, after run() has returned,
  // so without a listener it becomes an unhandled 'error' event that kills
  // the CLI with a raw stack trace even though the report was written.
  // Mirror swallowEpipe's injected-sink guard (cli.ts): attach only when the
  // handle actually exposes `on` (test fakes may not).
  if (typeof child.on === 'function') {
    child.on('error', () => {
      onError?.(`showreceipts: could not open a browser (${command} missing or failed to start); open ${target} yourself\n`);
    });
  }
  child.unref();
}

/** The §11.1 printed sections; `template` is everything outside the data block. */
export interface SectionBytes {
  cards: number;
  receipts: number;
  timelines: number;
  template: number;
}

const DATA_BLOCK_RE = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/;

/** Splits an emitted document into data-block bytes and template bytes. */
export function sectionBytesOf(html: string, budget: BudgetReport): { bytes: number; sections: SectionBytes } {
  const bytes = Buffer.byteLength(html, 'utf8');
  const data = DATA_BLOCK_RE.exec(html);
  const dataBytes = data === null ? 0 : Buffer.byteLength(data[1] as string, 'utf8');
  return {
    bytes,
    sections: {
      cards: budget.sections.sessions,
      receipts: budget.sections.receipts,
      timelines: budget.sections.timelines,
      template: bytes - dataBytes,
    },
  };
}

/** `512 B`, `12.3 KB`, `4.0 MB`. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  const prepared = prepare(ctx);
  const flags = ctx.args.flags;
  const mode: HashPathsMode = flags['hash-paths'] === 'both' ? 'both' : flags['hash-paths'] === true ? 'on' : 'off';
  const benchOnly = flags['bench'] === true;

  const progress = startProgress(ctx, { json: prepared.json });
  const load = await loadSessions(loadOptionsOf(prepared, progress.onProgress));
  progress.finish();

  let sessions = load.sessions;
  if (prepared.untilMs !== undefined) {
    const until = prepared.untilMs;
    sessions = sessions.filter((s) => {
      const ms = parseIso(s.endedAt);
      return ms === null || ms < until;
    });
  }
  const limit = typeof flags['limit'] === 'number' ? flags['limit'] : undefined;
  if (limit !== undefined) sessions = sessions.slice(0, limit);

  const receiptOpts: ReceiptOptions = {
    now: prepared.now,
    prices: prepared.prices,
    homeDir: prepared.homeDir,
    asOf: prepared.asOf,
  };
  const receiptIndexMap = new Map<string, Map<number, Receipt>>();
  const inputs: ReportSessionInput[] = [];
  for (const session of sessions) {
    const turnReceipts = buildTurnReceipts(session, receiptOpts);
    receiptIndexMap.set(sessionKey(session), turnReceipts);
    const receipt = buildReceipt(session, receiptOpts);
    const card = buildSessionCard(session, turnReceipts);
    const input: ReportSessionInput = { card, receipt };
    const turn = session.turns.find((t) => t.index === receipt.turnIndex);
    if (turn !== undefined) {
      input.timeline = buildTimeline(session, turn, { table: prepared.prices, asOf: prepared.asOf });
    }
    inputs.push(input);
  }
  const index: ReceiptIndex = receiptIndexMap;
  const rows: RateRow[] = buildRateRows(sessions, index);

  const built = buildReportPayload(inputs, {
    now: prepared.now,
    full: typeof flags['full'] === 'number' ? flags['full'] : undefined,
    rows,
    toolVersion: prepared.versions.toolVersion,
    rulesVersion: prepared.versions.rulesVersion,
    pricesVersion: prepared.versions.pricesVersion,
  });
  const { payload, report: budget } = applyBudget(built.payload, built.fullKeys);
  const html = renderHtml(payload, { hashPaths: mode });
  const { bytes, sections } = sectionBytesOf(html, budget);
  const timelinesEmbedded = Object.keys(payload.timelines).length;
  const hiddenRows = Object.values(budget.hiddenRows).reduce((a, b) => a + b, 0);
  const g = glyphSet(prepared.render.unicode);
  const sep = ` ${g.sepGlyph} `;
  const sectionLine = `  cards ${fmtBytes(sections.cards)}${sep}receipts ${fmtBytes(sections.receipts)}${sep}timelines ${fmtBytes(sections.timelines)} (${timelinesEmbedded} embedded)${sep}template ${fmtBytes(sections.template)}`;

  if (benchOnly) {
    // §11.1: payload size per section and card count, nothing written.
    ctx.stdout.write(`report --bench${sep}${sessions.length} session card(s)${sep}${fmtBytes(bytes)} total\n${sectionLine}\n`);
    return 0;
  }

  const outFlag = flags['out'];
  const explicitOut = typeof outFlag === 'string' && outFlag !== '';
  const out = explicitOut
    ? normalize(isAbsolute(outFlag as string) ? (outFlag as string) : join(ctx.cwd, outFlag as string))
    : join(findGitRoot(ctx.cwd) ?? ctx.cwd, '.showreceipts', 'report.html');
  if (!explicitOut) {
    // SECURITY.md: a cloned repo can ship `.showreceipts` as a symlink and
    // redirect the default report anywhere its author names. Only a real
    // directory (or nothing yet) is written to; an explicit --out is the
    // user's own choice and stays exempt.
    const entry = lstatOrNull(dirname(out));
    if (entry !== null && !entry.isDirectory()) {
      throw new Error(`${dirname(out)} is not a real directory (symlink or file) — refusing to write the report through it (use --out)`);
    }
  }
  ensureDir(dirname(out));
  if (!explicitOut) assertRealDirectory(dirname(out));
  atomicWriteFile(out, html);

  if (prepared.json) {
    ctx.stdout.write(
      `${stableStringify({
        out,
        bytes,
        bytesBySection: { ...sections },
        sessions: sessions.length,
        timelinesEmbedded,
        hiddenRows,
      })}\n`,
    );
  } else {
    const lines = [`report ${g.arrow} ${sanitizeForCell(displayPath(out, prepared.homeDir))} (${fmtBytes(bytes)}, ${sessions.length} session(s))`, sectionLine];
    if (budget.degraded.length > 0) lines.push(`  degraded: ${budget.degraded.join(` ${g.arrow} `)}${hiddenRows > 0 ? ` (${hiddenRows} timeline row(s) hidden)` : ''}`);
    ctx.stdout.write(`${lines.join('\n')}\n`);
    if (budget.softExceeded) ctx.stderr.write(`showreceipts: warning: the report exceeds 8 MB (${fmtBytes(bytes)})\n`);
    if (budget.overCap) ctx.stderr.write('showreceipts: warning: the report still exceeds the 16 MB hard cap after degradation\n');
  }

  if (flags['open'] === true) {
    openReport(out, process.platform, undefined, (message) => {
      try {
        ctx.stderr.write(message);
      } catch {
        // the stream may already be gone; the report itself was written
      }
    });
  }
  return 0;
}
