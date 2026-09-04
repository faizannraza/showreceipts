/**
 * `showreceipts export <id|latest> (--md | --json) [--out FILE]
 * [--hash-paths] [--timeline] [--turn N]` (ARCHITECTURE §12.1, S21/S24): one
 * session's receipt as Markdown or canonical JSON, for PR descriptions and
 * CI artifacts.
 *
 * Exactly one of `--md`/`--json` is required (usage error → exit 2). The
 * selector resolves through `pipeline/resolve-session.ts`; not-found and
 * ambiguous selectors exit 5 with the candidates printed (§12.2). Output
 * goes to stdout or — atomically — to `--out`. `--hash-paths` runs the
 * §11.2 pass inside `buildReceipt` with a random salt that is never
 * written anywhere.
 *
 * S24 rewired this command through the shared preparation
 * (`commands/common.ts prepare`): roots resolve from the real environment
 * home while `--home-dir` stays display-only, prices honour the
 * `~/.showreceipts/prices.json` override and `--prices` (§8.1), and usage
 * problems raise `CommandUsageError` (exit 2 at the CLI shell). Like
 * `session`, this is a single-session command — the cross-session usage
 * dedupe (§8.3) must NOT run here.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import { buildReceipt, receiptToJson, type ReceiptOptions } from '../pipeline/receipt.js';
import { AmbiguousError, NotFoundError, resolveSession } from '../pipeline/resolve-session.js';
import { loadSessions, type LoadResult } from '../pipeline/run.js';
import { renderMarkdownReceipt } from '../render/md.js';
import { atomicWriteFile } from '../util/fs.js';
import { applyUntil } from './audit.js';
import { CommandUsageError, loadOptionsOf, prepare, startProgress } from './common.js';
import { reportResolveFailure } from './session.js';
import { sharedOptions, usage, type HelpSection } from './help.js';

/** The §12.4 help section of `export` (S24; pinned against `cli/help.ts` by the drift tests). */
export const HELP: HelpSection = {
  summary: 'Markdown (--md) or JSON (--json) receipt for PR descriptions and CI artifacts',
  synopsis: 'showreceipts export <id|latest> (--md | --json) [--out FILE] [--hash-paths] [--timeline] [--turn N]',
  detail:
    "Prints one session's receipt as Markdown (--md) or JSON (--json) for PR descriptions and CI artifacts; --out writes it to a file instead of stdout. Exits 5 when the id is not found or ambiguous.",
  options: [
    ...sharedOptions(['since', 'until', 'all', 'harness', 'project', 'json']),
    { flag: 'md', text: 'Markdown output' },
    { flag: 'out', arg: '<file>', text: 'Write to this file' },
    ...sharedOptions(['width', 'ascii', 'unicode', 'no-color', 'tz', 'now', 'no-cache', 'as-of', 'prices']),
    { flag: 'hash-paths', text: 'Replace absolute paths with hashes' },
    { flag: 'turn', arg: '<n>', text: 'Receipt for turn N instead of the last done turn' },
    { flag: 'timeline', text: 'Include the evidence timeline' },
    { flag: 'verbose', text: 'Print unknown-shape counts and other diagnostics' },
    ...sharedOptions(['debug']),
  ],
};

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  if (ctx.args.flags['help'] === true) {
    ctx.stdout.write(usage('export', HELP));
    return 0;
  }
  const flags = ctx.args.flags;
  const md = flags['md'] === true;
  const json = flags['json'] === true;
  if (md === json) {
    throw new CommandUsageError('export: exactly one of --md or --json is required', 'export');
  }
  const selector = ctx.args.positionals[0];
  if (selector === undefined || selector.trim() === '') {
    throw new CommandUsageError('export: missing <id|latest>', 'export');
  }

  const prepared = prepare(ctx);
  for (const note of prepared.priceNotes) ctx.stderr.write(`showreceipts: ${note}\n`);

  const progress = startProgress(ctx, { json: true });
  let load: LoadResult;
  try {
    load = await loadSessions(loadOptionsOf(prepared, progress.onProgress));
  } finally {
    progress.finish();
  }
  const sessions = applyUntil(load.sessions, prepared.untilMs);

  let session;
  try {
    session = await resolveSession(selector, { sessions, roots: prepared.roots, cwd: ctx.cwd });
  } catch (err) {
    if (err instanceof AmbiguousError || err instanceof NotFoundError) return reportResolveFailure(ctx, err);
    throw err;
  }

  const turn = typeof flags['turn'] === 'number' ? flags['turn'] : undefined;
  if (turn !== undefined && !session.turns.some((t) => t.index === turn)) {
    throw new CommandUsageError(`--turn: no turn ${turn} in session ${session.shortId}`, 'export');
  }

  const hashPaths = flags['hash-paths'] === true || flags['hash-paths'] === 'both';
  const receiptOpts: ReceiptOptions = {
    now: prepared.now,
    prices: prepared.prices,
    homeDir: prepared.homeDir,
    turnIndex: turn,
    timeline: flags['timeline'] === true,
    asOf: prepared.asOf,
    // §11.2: the salt is random and never written into the output.
    hashPaths: hashPaths ? randomBytes(16).toString('hex') : undefined,
  };
  const receipt = buildReceipt(session, receiptOpts);

  const output = json ? `${receiptToJson(receipt)}\n` : renderMarkdownReceipt(receipt, { tz: prepared.render.tz });

  const out = flags['out'];
  if (typeof out === 'string' && out !== '') {
    const target = normalize(isAbsolute(out) ? out : join(ctx.cwd, out));
    atomicWriteFile(target, output);
  } else {
    ctx.stdout.write(output);
  }
  return 0;
}
