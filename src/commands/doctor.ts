/**
 * `showreceipts doctor [--json] [--clear-cache] [--prune-ledgers <days>]
 * [--verbose]` (ARCHITECTURE §12.1–§12.3, S25): what was found on disk,
 * unknown record shapes, hook status, price coverage. Exit 4 only for the
 * §12.2 core-shape/environment problems; warnings alone exit 0.
 *
 * `--clear-cache` empties only `cache/` (this run then scans with the cache
 * bypassed so nothing is silently repopulated); `--prune-ledgers <days>` is
 * explicit and prints every ledger file it removed. Both are performed
 * before the scan so the report reflects the resulting state.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import type { DoctorReport } from '../model/types.js';
import { createCache } from '../cache/cache.js';
import { collectDoctorReport } from '../doctor/collect.js';
import { renderDoctor } from '../render/doctor.js';
import { inspectHooks } from '../setup/inspect.js';
import { statOrNull } from '../util/fs.js';
import { stableStringify } from '../util/json.js';
import { displayPath } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { wrapToWidth } from '../util/width.js';
import { prepare, startProgress } from './common.js';

const DAY_MS = 86_400_000;

/** The §12.3 durability note both `doctor` and `bench` print. */
export const CLEANUP_NOTE =
  'Claude Code deletes transcripts after cleanupPeriodDays (default 30); hook-captured receipts under ~/.showreceipts/last/ are the durable record';

/** {@link CLEANUP_NOTE} (or any note) word-wrapped to the `cols − 2` budget every doctor/bench line honours. */
export function noteLines(note: string, cols: number): string[] {
  return wrapToWidth(note, Math.max(40, Math.min(cols, 200)) - 2, 99);
}

/** `512 B`, `12.3 KB`, `4.0 MB`. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deletes `ledger/<harness>/*.jsonl` files older than `cutoffMs` and returns
 * one line per removal plus a summary. Never touches anything else.
 */
function pruneLedgers(showreceiptsHome: string, cutoffMs: number, homeDir: string): string[] {
  const lines: string[] = [];
  let removed = 0;
  const ledgerRoot = join(showreceiptsHome, 'ledger');
  let harnessDirs: string[];
  try {
    harnessDirs = fs.readdirSync(ledgerRoot).sort();
  } catch {
    harnessDirs = [];
  }
  for (const harness of harnessDirs) {
    const dir = join(ledgerRoot, harness);
    const stat = statOrNull(dir);
    if (stat === null || !stat.isDirectory()) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const fileStat = statOrNull(path);
      if (fileStat === null || !fileStat.isFile() || fileStat.mtimeMs >= cutoffMs) continue;
      try {
        fs.unlinkSync(path);
        removed += 1;
        lines.push(`pruned ${sanitizeForCell(displayPath(path, homeDir))}`);
      } catch {
        lines.push(`could not prune ${sanitizeForCell(displayPath(path, homeDir))}`);
      }
    }
  }
  lines.push(`pruned ${removed} ledger file(s)`);
  return lines;
}

/** `--verbose`: the unknown-shape keys per harness, one line per non-empty record. */
function verboseLines(report: DoctorReport): string[] {
  const out: string[] = [];
  for (const row of report.harnesses) {
    const records: [string, Record<string, number>][] = [
      ['unknownRecordTypes', row.unknownRecordTypes],
      ['unknownSubtypes', row.unknownSubtypes],
      ['unknownToolShapes', row.unknownToolShapes],
      ['unknownContentBlocks', row.unknownContentBlocks],
      ['unknownCodexPayloads', row.unknownCodexPayloads],
      ['legacyShapes', row.legacyShapes],
    ];
    for (const [name, record] of records) {
      const keys = Object.keys(record).sort();
      if (keys.length === 0) continue;
      const detail = keys.map((k) => `${sanitizeForCell(k)}=${record[k] ?? 0}`).join(', ');
      out.push(`  ${row.harness} ${name}: ${detail}`);
    }
  }
  return out;
}

/** Runs the command; returns the exit code (§12.2: 0, or 4 on problems). */
export async function run(ctx: CommandContext): Promise<number> {
  const prepared = prepare(ctx);
  const flags = ctx.args.flags;
  const showreceiptsHome = prepared.roots.showreceiptsHome;
  const actionNotes: string[] = [];

  const pruneDays = typeof flags['prune-ledgers'] === 'number' ? flags['prune-ledgers'] : undefined;
  if (pruneDays !== undefined) {
    actionNotes.push(...pruneLedgers(showreceiptsHome, prepared.now.getTime() - pruneDays * DAY_MS, prepared.homeDir));
  }

  let noCache = prepared.noCache;
  if (flags['clear-cache'] === true) {
    const cache = createCache({ dir: join(showreceiptsHome, 'cache'), toolVersion: prepared.versions.toolVersion });
    const before = cache.stats();
    cache.clear();
    // This run must not silently repopulate what it just cleared.
    noCache = true;
    actionNotes.push(`cache cleared (${before.entries} entr${before.entries === 1 ? 'y' : 'ies'}, ${fmtBytes(before.bytes)})`);
  }

  const hooks = inspectHooks(prepared.userHome, ctx.cwd, {
    claudeConfigDir: prepared.roots.claudeConfigDir,
    codexHome: prepared.roots.codexHome,
    showreceiptsHome,
  });

  const progress = startProgress(ctx, { json: prepared.json });
  let report: DoctorReport;
  try {
    report = await collectDoctorReport({
      roots: prepared.roots,
      homeDir: prepared.homeDir,
      prices: prepared.prices,
      priceNotes: prepared.priceNotes,
      toolVersion: prepared.versions.toolVersion,
      now: prepared.now,
      noCache,
      harness: prepared.harness,
      hooks,
    });
  } finally {
    progress.finish();
  }

  if (prepared.json) {
    ctx.stdout.write(`${stableStringify(report)}\n`);
  } else {
    const lines: string[] = [...actionNotes];
    lines.push(...renderDoctor(report, { cols: prepared.render.cols, unicode: prepared.render.unicode, color: prepared.render.color }));
    if (prepared.verbose) lines.push(...verboseLines(report));
    lines.push('', ...noteLines(CLEANUP_NOTE, prepared.render.cols));
    ctx.stdout.write(`${lines.join('\n')}\n`);
  }
  return report.problems.length > 0 ? 4 : 0;
}
