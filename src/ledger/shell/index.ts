/**
 * Public surface of `ledger/shell`: `tokenize` (the §4.5.1 entry point,
 * assembled from the `lex.ts` state machine and the `segments.ts` builder),
 * exit-code attribution (§4.5.5) and the family table. The harness reports
 * one exit code per command; `attributeExit` spreads it over the parsed
 * segments: the last segment owns it, `&&` chains propagate, failures are
 * re-attributed by output signatures, and the pipeline-sink rule takes
 * precedence over chain propagation.
 */
import type { ExitSource, ShellSegment } from '../../model/types.js';
import { initialCwd } from './cwd.js';
import { lexRaw } from './lex.js';
import { buildItems, finalizePipes, type BuildContext, type SegLink, type ShellParse } from './segments.js';

export { lexRaw } from './lex.js';
export { classifySegment, families, gitSubcommand } from './families.js';
export { applyCd, cloneCwd, initialCwd, isUntrackedDirOp, type CwdState } from './cwd.js';
export { parseAssignment, resolveWord, substitute, type Assignment, type ResolvedText, type WordLike } from './vars.js';
export type { RawLex, SegLink, ShellParse, Word } from './segments.js';

/**
 * Lexes and classifies one logged command (§4.5.1–§4.5.4): segments with
 * programs, families, redirect targets, assignments and per-segment cwd; the
 * chain metadata `attributeExit` needs; heredoc summaries; and the final
 * working directory. Never throws. Exit codes are attributed separately by
 * `attributeExit` (§4.5.5). Without `opts.home`, `~` stays symbolic.
 */
export function tokenize(raw: string, cwd: string, opts?: { home?: string }): ShellParse {
  const home = opts?.home ?? '~';
  const lex = lexRaw(raw);
  const parse: ShellParse = {
    segments: [],
    links: [],
    chained: false,
    background: false,
    pipefail: false,
    heredocs: [],
    notes: [...lex.notes],
    cwdAfter: cwd,
    resolved: true,
  };
  const ctx: BuildContext = {
    state: initialCwd(cwd, home),
    vars: new Map(),
    home,
    relex: lexRaw,
    segments: parse.segments,
    links: parse.links,
    notes: parse.notes,
    heredocs: parse.heredocs,
    flags: { pipefail: false },
    top: { pipefail: false },
    fromSubst: false,
    depth: 0,
  };
  buildItems(lex.items, ctx);
  finalizePipes(parse.segments, parse.links);
  parse.pipefail = ctx.top.pipefail;
  parse.cwdAfter = ctx.state.dir;
  parse.resolved = ctx.state.resolved;
  const chain = parse.links.map((l, idx) => ({ l, idx })).filter((e) => !e.l.fromSubst);
  const last = chain[chain.length - 1];
  parse.background = last !== undefined && last.l.sep === '&';
  parse.chained = chain.slice(0, -1).some((e) => e.l.sep !== null && e.l.sep !== '|');
  if (parse.background) {
    for (const e of chain) {
      const seg = parse.segments[e.idx];
      if (seg !== undefined) seg.ran = 'background';
    }
  }
  return parse;
}

/** Output signatures that pin a failure onto a specific segment (§4.5.5). */
const SIGNATURES: readonly { re: RegExp; matches: (seg: ShellSegment) => boolean }[] = [
  { re: /error TS\d+/, matches: (s) => s.program === 'tsc' || s.family === 'type' || s.family === 'build' },
  { re: /✖ \d+ problems?/, matches: (s) => s.program === 'eslint' || s.family === 'lint' },
  { re: /Found \d+ error/, matches: (s) => s.program === 'mypy' || s.program === 'ruff' || s.family === 'type' || s.family === 'lint' },
  { re: /npm error/, matches: (s) => s.program === 'npm' || s.program.startsWith('npm-script:') },
];

const CHECK_FAMILIES = new Set(['test', 'lint', 'type', 'build', 'format']);

/** One pipeline: consecutive chain segments joined by `|`; `sep` follows the tail. */
interface Unit {
  segs: number[];
  sep: SegLink['sep'];
}

function chainUnits(parse: ShellParse): Unit[] {
  const units: Unit[] = [];
  let current: number[] = [];
  for (let i = 0; i < parse.segments.length; i += 1) {
    const link = parse.links[i] as SegLink;
    if (link.fromSubst) continue;
    current.push(i);
    if (link.sep === '|') continue;
    units.push({ segs: current, sep: link.sep });
    current = [];
  }
  if (current.length > 0) units.push({ segs: current, sep: null });
  return units;
}

/** Assigns one exit to a pipeline unit: the tail owns it; sink segs stay `null`/`'sink'`; pipefail spreads a zero. */
function assignUnit(parse: ShellParse, unit: Unit, exit: number | null, source: ExitSource): void {
  const tailIdx = unit.segs[unit.segs.length - 1] as number;
  for (const m of unit.segs) {
    const seg = parse.segments[m] as ShellSegment;
    const link = parse.links[m] as SegLink;
    if (m === tailIdx) {
      seg.exitCode = exit;
      seg.exitCodeSource = exit === null && source === 'harness' ? 'unknown' : source;
      continue;
    }
    if (link.sink) {
      seg.exitCode = null;
      seg.exitCodeSource = 'sink';
      continue;
    }
    if (link.pipefail && exit === 0) {
      seg.exitCode = 0;
      seg.exitCodeSource = source;
      continue;
    }
    seg.exitCode = null;
    seg.exitCodeSource = 'unknown';
  }
}

function markDidNotRun(parse: ShellParse, unit: Unit): void {
  for (const m of unit.segs) {
    const seg = parse.segments[m] as ShellSegment;
    const link = parse.links[m] as SegLink;
    seg.exitCode = null;
    seg.exitCodeSource = link.sink ? 'sink' : 'unknown';
    seg.ran = seg.family !== undefined && CHECK_FAMILIES.has(seg.family) ? 'short-circuited' : false;
  }
}

/** The last unit in `run` whose segs match a signature present in `output`, else `null`. */
function findFailingUnit(parse: ShellParse, run: Unit[], output: string | undefined): number | null {
  if (output === undefined || output === '') return null;
  const present = SIGNATURES.filter((s) => s.re.test(output));
  if (present.length === 0) return null;
  for (let u = run.length - 1; u >= 0; u -= 1) {
    const unit = run[u] as Unit;
    if (unit.segs.some((m) => present.some((s) => s.matches(parse.segments[m] as ShellSegment)))) return u;
  }
  return null;
}

/**
 * Attributes the harness exit code across the parse (§4.5.5), mutating the
 * segments. The exit belongs to the last segment; an `&&`-only chain with
 * exit 0 propagates 0 to every segment; with a non-zero exit the failure is
 * pinned by output signatures (`error TS\d+`, `✖ N problems`, `Found N
 * error`, `npm error`), later segments become `ran:false` (test/check
 * segments `ran:'short-circuited'`); the pipeline-sink rule takes precedence
 * (`exitCode:null`, `exitCodeSource:'sink'` unless pipefail); `;` chains give
 * the code to the last segment only; exit 0 after `||` leaves earlier
 * segments unknown with a "failed-somewhere" note; a trailing `&` makes
 * everything `ran:'background'` and unknown.
 */
export function attributeExit(parse: ShellParse, harnessExit: number | null, source: ExitSource, output?: string): void {
  const units = chainUnits(parse);
  if (units.length === 0) return;
  if (parse.background) {
    for (const unit of units) {
      for (const m of unit.segs) {
        const seg = parse.segments[m] as ShellSegment;
        seg.ran = 'background';
        seg.exitCode = null;
        seg.exitCodeSource = 'unknown';
      }
    }
    return;
  }
  // Split into `;` / newline runs: only the last run sees the harness exit.
  const runs: Unit[][] = [[]];
  for (const unit of units) {
    (runs[runs.length - 1] as Unit[]).push(unit);
    if ((unit.sep === ';' || unit.sep === '\n') && unit !== units[units.length - 1]) runs.push([]);
  }
  for (let r = 0; r < runs.length - 1; r += 1) {
    for (const unit of runs[r] as Unit[]) assignUnit(parse, unit, null, 'unknown');
  }
  const run = runs[runs.length - 1] as Unit[];
  if (run.length === 0) return;
  if (harnessExit === null) {
    for (const unit of run) assignUnit(parse, unit, null, 'unknown');
    return;
  }
  const anyOr = run.slice(0, -1).some((u) => u.sep === '||');
  const lastUnit = run[run.length - 1] as Unit;
  if (anyOr) {
    for (const unit of run.slice(0, -1)) assignUnit(parse, unit, null, 'unknown');
    assignUnit(parse, lastUnit, harnessExit, source);
    if (harnessExit === 0 && !parse.notes.includes('failed-somewhere')) parse.notes.push('failed-somewhere');
    return;
  }
  if (harnessExit === 0) {
    for (const unit of run) assignUnit(parse, unit, 0, source);
    return;
  }
  const failing = findFailingUnit(parse, run, output) ?? run.length - 1;
  for (let u = 0; u < run.length; u += 1) {
    const unit = run[u] as Unit;
    if (u < failing) assignUnit(parse, unit, 0, 'backfilled');
    else if (u === failing) assignUnit(parse, unit, harnessExit, u === run.length - 1 ? source : 'parsed');
    else markDidNotRun(parse, unit);
  }
}
