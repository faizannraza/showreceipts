/**
 * Shared command preparation (S23c; §12.1–§12.4): everything `audit`,
 * `session`, `report`, `export`, `bench` and `doctor` must resolve the same
 * way — config roots, the `--since`/`--until` window, the harness filter, the
 * effective price table, `--as-of`, render options, tool/rules/prices
 * versions, the hidden `--home-dir` display override and the stderr progress
 * line. `demo` deliberately bypasses this module (§14.1: fixed defaults) and
 * `hook` has its own runtime (§9).
 *
 * Error contract (§12.2): usage problems raise {@link CommandUsageError}
 * (`name: 'UsageError'`, `exitCode: 2`), which `cli.ts` maps to exit 2 exactly
 * like an argv-level parse error; an invalid `--prices` file raises
 * `PriceTableError`, which the CLI shell reports as exit 1. The
 * `~/.showreceipts/prices.json` home override is different by design (§8.1):
 * when invalid it is reported once via {@link Prepared.priceNotes} and
 * ignored, never fatal.
 *
 * `--home-dir` (env `SHOWRECEIPTS_DISPLAY_HOME`) is display-only: it feeds the
 * `homeDir` parameter of `buildReceipt` and the renderers so paths print as
 * `~/…`, and it never reaches the roots, the cache keys or any ledger path.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandName } from '../cli/args.js';
import type { CommandContext } from '../cli/context.js';
import { loadPriceTable, PriceTableError, type PriceTable } from '../cost/resolve.js';
import { mergeTables, parsePriceTable } from '../cost/validate.js';
import { resolveRoots } from '../discover/roots.js';
import { HARNESSES, type Harness, type Roots } from '../model/types.js';
import { RECEIPT_RULES_VERSION } from '../pipeline/receipt.js';
import type { LoadOptions } from '../pipeline/run.js';
import { resolveCols } from '../render/box.js';
import { decideUnicode, type UnicodeEnv } from '../render/glyphs.js';
import { colorEnabled } from '../util/ansi.js';
import { parseAsOf, parseSince, type Tz } from '../util/time.js';
import { TOOL_VERSION } from '../version.js';

const DAY_MS = 86_400_000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A usage error raised below the cli layer (§0.5 forbids a runtime import of
 * `cli/args.ts` from here). It carries `name: 'UsageError'` and
 * `exitCode: 2`, the duck shape `cli.ts` maps to exit 2 with the usage
 * footer of `command`.
 */
export class CommandUsageError extends Error {
  override readonly name = 'UsageError';
  readonly exitCode = 2;
  readonly command: CommandName | undefined;

  constructor(message: string, command?: CommandName) {
    super(message);
    this.command = command;
  }
}

/** The resolved render options (§10.1), ready for `render/term.ts`. */
export interface RenderPrep {
  /** Columns via `resolveCols` (already capped at 102). */
  cols: number;
  /** Unicode frame/glyphs via `decideUnicode`. */
  unicode: boolean;
  /** ANSI colour via `colorEnabled`. */
  color: boolean;
  /** `--tz` (default `local`). */
  tz: Tz;
}

/** The version triple stamped into receipts and `--json` envelopes (§12.3). */
export interface Versions {
  toolVersion: string;
  rulesVersion: string;
  pricesVersion: string;
}

/** Everything {@link prepare} resolves for a scanning/rendering command. */
export interface Prepared {
  /** Config roots (§4.1), resolved from the real environment home — never from `--home-dir`. */
  roots: Roots;
  /** The real user home the roots were resolved against. */
  userHome: string;
  /** Display home for `~` forms (`--home-dir` → `SHOWRECEIPTS_DISPLAY_HOME` → {@link Prepared.userHome}). */
  homeDir: string;
  /** `--json`. */
  json: boolean;
  /** `--verbose`. */
  verbose: boolean;
  /** `--debug`. */
  debug: boolean;
  /** `--all` (disables the window entirely). */
  all: boolean;
  /** Window start (epoch ms); `undefined` under `--all`. Default: 90d before `now`. */
  sinceMs: number | undefined;
  /** Window end (epoch ms, exclusive); a `YYYY-MM-DD` names its whole day (midnight UTC + 24 h). */
  untilMs: number | undefined;
  /** Validated `--harness` filter; `undefined` = every harness. */
  harness: Harness[] | undefined;
  /** `--project`. */
  project: string | undefined;
  /** `--no-cache` or non-empty `SHOWRECEIPTS_NO_CACHE` (any value but `0`). */
  noCache: boolean;
  /** Effective price table: bundled ← `~/.showreceipts/prices.json` ← `--prices` (§8.1). */
  prices: PriceTable;
  /** One line per ignored home-override problem (§8.1: reported once, never fatal). */
  priceNotes: string[];
  /** `--as-of YYYY-MM-DD`, validated. */
  asOf: string | undefined;
  /** The command clock (`ctx.now`; `--now` → `SHOWRECEIPTS_NOW` → wall clock). */
  now: Date;
  /** Tool, rules and prices versions (§12.3 envelopes). */
  versions: Versions;
  /** Resolved render options (§10.1). */
  render: RenderPrep;
}

/**
 * Injection seams for facts the `CommandContext` does not carry. `platform`
 * steers only the unicode default (§10.1) and defaults to
 * `process.platform`.
 */
export interface PrepareSeams {
  platform?: string | undefined;
}

/** A non-empty, non-whitespace env value, else `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The env slice `decideUnicode` reads, taken from the command context. */
function unicodeEnvOf(env: CommandContext['env']): UnicodeEnv {
  return {
    LC_ALL: env['LC_ALL'],
    LC_CTYPE: env['LC_CTYPE'],
    LANG: env['LANG'],
    TERM: env['TERM'],
    WT_SESSION: env['WT_SESSION'],
    TERM_PROGRAM: env['TERM_PROGRAM'],
    ConEmuANSI: env['ConEmuANSI'],
  };
}

/** The validated `--harness` list, or `undefined` when the flag is absent/empty. */
function harnessFilter(ctx: CommandContext): Harness[] | undefined {
  const raw = ctx.args.flags['harness'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  for (const h of raw) {
    if (!(HARNESSES as readonly string[]).includes(h)) {
      throw new CommandUsageError(`--harness: unknown harness '${h}' (expected ${HARNESSES.join(', ')})`, ctx.args.command);
    }
  }
  return raw as Harness[];
}

/**
 * The effective price table (§8.1): bundled `prices.json`, then the
 * `~/.showreceipts/prices.json` home override (invalid ⇒ a
 * {@link Prepared.priceNotes} line, ignored), then `--prices FILE` (missing
 * or invalid ⇒ `PriceTableError`, which the CLI shell maps to exit 1).
 */
function effectivePrices(ctx: CommandContext, roots: Roots, priceNotes: string[]): PriceTable {
  let table = loadPriceTable();
  const overridePath = join(roots.showreceiptsHome, 'prices.json');
  let overrideText: string | null = null;
  try {
    overrideText = readFileSync(overridePath, 'utf8');
  } catch {
    overrideText = null; // no home override — the common case
  }
  if (overrideText !== null) {
    try {
      table = mergeTables(table, parsePriceTable(overrideText, overridePath, table));
    } catch (err) {
      if (!(err instanceof PriceTableError)) throw err;
      priceNotes.push(`${err.message} — override ignored`);
    }
  }
  const flag = ctx.args.flags['prices'];
  if (typeof flag === 'string' && flag !== '') {
    let text: string;
    try {
      text = readFileSync(flag, 'utf8');
    } catch {
      throw new PriceTableError(`prices: ${flag}: cannot read file`);
    }
    table = mergeTables(table, parsePriceTable(text, flag, table));
  }
  return table;
}

/**
 * Resolves the shared preparation of one command invocation. Pure over the
 * context except for `process.platform` (overridable via `seams`) and the
 * filesystem reads behind the roots and price tables.
 */
export function prepare(ctx: CommandContext, seams: PrepareSeams = {}): Prepared {
  const flags = ctx.args.flags;
  const command = ctx.args.command;

  const userHome = nonEmpty(ctx.env['HOME']) ?? nonEmpty(ctx.env['USERPROFILE']) ?? homedir();
  const roots = resolveRoots(ctx.env, userHome);
  const homeDirFlag = flags['home-dir'];
  const homeDir =
    (typeof homeDirFlag === 'string' && homeDirFlag !== '' ? homeDirFlag : undefined) ??
    nonEmpty(ctx.env['SHOWRECEIPTS_DISPLAY_HOME']) ??
    userHome;

  const harness = harnessFilter(ctx);
  const all = flags['all'] === true;
  const nowMs = ctx.now.getTime();

  const sinceSpec = typeof flags['since'] === 'string' ? flags['since'] : '90d';
  const sinceParsed = parseSince(sinceSpec, nowMs);
  if (sinceParsed === null) throw new CommandUsageError(`--since: expected YYYY-MM-DD or <N>d (got '${sinceSpec}')`, command);
  const sinceMs = all ? undefined : sinceParsed;

  let untilMs: number | undefined;
  const untilSpec = flags['until'];
  if (typeof untilSpec === 'string') {
    const parsed = parseSince(untilSpec, nowMs);
    if (parsed === null) throw new CommandUsageError(`--until: expected YYYY-MM-DD or <N>d (got '${untilSpec}')`, command);
    // A calendar date names its whole day: the boundary is the following midnight.
    untilMs = DATE_ONLY_RE.test(untilSpec.trim()) ? parsed + DAY_MS : parsed;
  }

  let asOf: string | undefined;
  const asOfSpec = flags['as-of'];
  if (typeof asOfSpec === 'string') {
    if (parseAsOf(asOfSpec) === null) throw new CommandUsageError(`--as-of: expected YYYY-MM-DD (got '${asOfSpec}')`, command);
    asOf = asOfSpec;
  }

  const priceNotes: string[] = [];
  const prices = effectivePrices(ctx, roots, priceNotes);

  const width = typeof flags['width'] === 'number' ? flags['width'] : undefined;
  const cols = resolveCols({ width, stdoutColumns: ctx.columns, COLUMNS: ctx.env['COLUMNS'], isTTY: ctx.isTTY });
  const unicode = decideUnicode({
    ascii: flags['ascii'] === true,
    unicode: flags['unicode'] === true,
    // The platform steers only the unicode default; the context has no seam for it (S23b/S23c decision).
    platform: seams.platform ?? process.platform,
    env: unicodeEnvOf(ctx.env),
  });
  const color = colorEnabled({
    noColor: flags['no-color'] === true,
    forceColor: ctx.env['FORCE_COLOR'],
    noColorEnv: ctx.env['NO_COLOR'],
    term: ctx.env['TERM'],
    isTTY: ctx.isTTY,
  });
  const tz: Tz = flags['tz'] === 'utc' ? 'utc' : 'local';

  const noCacheEnv = nonEmpty(ctx.env['SHOWRECEIPTS_NO_CACHE']);
  const noCache = flags['no-cache'] === true || (noCacheEnv !== undefined && noCacheEnv !== '0');

  return {
    roots,
    userHome,
    homeDir,
    json: flags['json'] === true,
    verbose: flags['verbose'] === true,
    debug: flags['debug'] === true,
    all,
    sinceMs,
    untilMs,
    harness,
    project: typeof flags['project'] === 'string' && flags['project'] !== '' ? flags['project'] : undefined,
    noCache,
    prices,
    priceNotes,
    asOf,
    now: ctx.now,
    versions: { toolVersion: TOOL_VERSION, rulesVersion: RECEIPT_RULES_VERSION, pricesVersion: prices.version },
    render: { cols, unicode, color, tz },
  };
}

/**
 * The `loadSessions` options of a preparation (S18). `--until` is not part
 * of `LoadOptions` — commands apply {@link Prepared.untilMs} to the loaded
 * sessions themselves.
 */
export function loadOptionsOf(prepared: Prepared, onProgress?: (done: number, total: number) => void): LoadOptions {
  return {
    roots: prepared.roots,
    ...(prepared.all ? { all: true } : prepared.sinceMs !== undefined ? { since: prepared.sinceMs } : {}),
    ...(prepared.harness !== undefined ? { harness: prepared.harness } : {}),
    ...(prepared.project !== undefined ? { project: prepared.project } : {}),
    ...(prepared.noCache ? { noCache: true } : {}),
    versions: { tool: prepared.versions.toolVersion },
    now: prepared.now,
    ...(onProgress !== undefined ? { onProgress } : {}),
  };
}

/** Options of {@link startProgress}. */
export interface ProgressOptions {
  /** `--json` suppresses the progress line entirely. */
  json: boolean;
  /** Delay before the line first appears (default 500 ms). */
  delayMs?: number | undefined;
}

/** A live progress line: feed `onProgress` to `loadSessions`, call `finish()` before any output. */
export interface Progress {
  onProgress(done: number, total: number): void;
  /** Clears the line (idempotent). Always call before writing command output. */
  finish(): void;
}

/**
 * The stderr progress line (S23c): on an interactive terminal a scan that
 * takes longer than `delayMs` (500 ms) shows `scanning … <done>/<total>
 * sessions` on stderr, updated per session and cleared before any output.
 * Never on a non-TTY, never with `--json` — those return no-op handlers.
 */
export function startProgress(ctx: CommandContext, opts: ProgressOptions): Progress {
  if (!ctx.isTTY || opts.json) {
    return { onProgress: () => undefined, finish: () => undefined };
  }
  let armed = false;
  let finished = false;
  let written = 0;
  let last: { done: number; total: number } | null = null;

  const paint = (): void => {
    if (!armed || finished || last === null) return;
    const text = `scanning … ${last.done}/${last.total} sessions`;
    const pad = text.length < written ? ' '.repeat(written - text.length) : '';
    ctx.stderr.write(`\r${text}${pad}`);
    written = Math.max(written, text.length);
  };

  const timer = setTimeout(() => {
    armed = true;
    paint();
  }, opts.delayMs ?? 500);
  timer.unref?.();

  return {
    onProgress(done: number, total: number): void {
      last = { done, total };
      paint();
    },
    finish(): void {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (written > 0) ctx.stderr.write(`\r${' '.repeat(written)}\r`);
    },
  };
}
