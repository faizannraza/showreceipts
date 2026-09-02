/**
 * Check summaries (§4.6.5). Every S11 segment with `family ∈ {lint, type,
 * build, format}` becomes a `CheckRun`; summary parsers are keyed strictly by
 * program (ruff's `Found 2 errors.` is never read by tsc's parser, and vice
 * versa). Programs with no summary grammar (clippy, `go vet`, npm scripts)
 * are judged by exit alone. `green` follows the same tri-state as tests: a
 * parsed summary decides red/green (a non-zero exit still vetoes green), exit
 * 0 alone is green, a non-null non-zero exit is red, and an unknown exit
 * (sink pipe, background back-fill pending) is `'unknown'`. A formatter run
 * that writes (`ruff format`, `prettier --write` — `mayWrite`) is a write
 * fact (§4.6.1), not a check, and is skipped here.
 */
import type { CheckRun, CommandFact, ShellSegment, ToolCall } from '../model/types.js';
import { prepareOutput } from './runners.js';
import { segmentProducedNoRun } from './tests.js';

const CHECK_FAMILIES: ReadonlySet<string> = new Set(['lint', 'type', 'build', 'format']);

const num = (s: string | undefined): number => (s === undefined || s === '' ? 0 : Number(s));

/**
 * Extracts one `CheckRun` per lint/type/build/format segment (§4.6.5).
 * Background, timed-out, denied, interrupted and short-circuited segments
 * produce none (same rule as test runs).
 */
export function extractChecks(commands: readonly CommandFact[], calls: readonly ToolCall[]): CheckRun[] {
  const byId = new Map<string, ToolCall>();
  for (const call of calls) byId.set(call.id, call);
  const checks: CheckRun[] = [];
  for (const fact of commands) {
    const call = byId.get(fact.toolCallId);
    let text: string | null = null;
    for (const segment of fact.segments) {
      if (segment.family === undefined || !CHECK_FAMILIES.has(segment.family)) continue;
      if (segment.family === 'format' && segment.mayWrite === true) continue; // a formatter write, not a check
      if (segmentProducedNoRun(fact, call, segment)) continue;
      text ??= prepareOutput(call?.resultText ?? '');
      checks.push(buildCheck(fact, segment, text));
    }
  }
  return checks;
}

/** A program-keyed summary parse: `green` absent ⇒ the exit decides. */
interface SummaryParse {
  green?: boolean;
  summary?: string;
  autoFixed?: boolean;
}

// --- ruff check -------------------------------------------------------------

const RUFF_OK_RE = /^All checks passed!$/m;
const RUFF_FIXED_RE = /^Found (\d+) errors? \((\d+) fixed, (\d+) remaining\)\.$/m;
const RUFF_FOUND_RE = /^Found (\d+) errors?\.$/m;
const RUFF_PARSE_WARN_RE = /^warning: Failed to parse .*$/m;

function parseRuffCheck(text: string): SummaryParse | null {
  const ok = RUFF_OK_RE.exec(text);
  if (ok !== null) return { green: true, summary: ok[0] };
  const fixed = RUFF_FIXED_RE.exec(text);
  if (fixed !== null) return { green: num(fixed[3]) === 0, summary: fixed[0], autoFixed: num(fixed[2]) > 0 };
  const found = RUFF_FOUND_RE.exec(text);
  if (found !== null) return { green: num(found[1]) === 0, summary: found[0] };
  const warn = RUFF_PARSE_WARN_RE.exec(text);
  if (warn !== null) return { summary: warn[0] }; // informational; the exit decides
  return null;
}

// --- ruff format --check ----------------------------------------------------

const RUFF_FMT_OK_RE = /^(\d+) files? already formatted$/m;
const RUFF_FMT_COUNT_RE = /^(\d+) files? would be reformatted.*$/m;
const RUFF_FMT_LIST_RE = /^Would reformat: .*$/m;

function parseRuffFormat(text: string): SummaryParse | null {
  const ok = RUFF_FMT_OK_RE.exec(text);
  if (ok !== null) return { green: true, summary: ok[0] };
  const count = RUFF_FMT_COUNT_RE.exec(text);
  if (count !== null) return { green: false, summary: count[0] };
  const list = RUFF_FMT_LIST_RE.exec(text);
  if (list !== null) return { green: false, summary: list[0] };
  return null;
}

// --- mypy -------------------------------------------------------------------

const MYPY_OK_RE = /^Success: no issues found in \d+ source files?.*$/m;
const MYPY_FOUND_RE = /^Found (\d+) errors? in (\d+) files?.*$/m;

function parseMypy(text: string): SummaryParse | null {
  const ok = MYPY_OK_RE.exec(text);
  if (ok !== null) return { green: true, summary: ok[0] };
  const found = MYPY_FOUND_RE.exec(text);
  if (found !== null) return { green: false, summary: found[0] };
  return null;
}

// --- tsc (red iff any `error TS\d+` line; silent on success) ----------------

const TSC_ERROR_RE = /error TS\d+/;
const TSC_FOUND_RE = /^Found \d+ errors?.*$/m;

function parseTsc(text: string): SummaryParse | null {
  if (!TSC_ERROR_RE.test(text)) return null; // no summary on success — the exit decides
  const found = TSC_FOUND_RE.exec(text);
  if (found !== null) return { green: false, summary: found[0] };
  const count = text.match(/error TS\d+/g)?.length ?? 0;
  return { green: false, summary: `${count} type error${count === 1 ? '' : 's'}` };
}

// --- eslint (silent success; red iff errors > 0) ----------------------------

const ESLINT_RE = /^[^\S\n]*✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m;

function parseEslint(text: string): SummaryParse | null {
  const m = ESLINT_RE.exec(text);
  if (m === null) return null;
  return { green: num(m[2]) === 0, summary: m[0].trim() };
}

// --- prettier ---------------------------------------------------------------

const PRETTIER_OK_RE = /^All matched files use Prettier code style!$/m;
const PRETTIER_ISSUES_RE = /^\[warn\] Code style issues found.*$/m;
const PRETTIER_WARN_RE = /^\[warn\] .*$/m;

function parsePrettier(text: string): SummaryParse | null {
  const ok = PRETTIER_OK_RE.exec(text);
  if (ok !== null) return { green: true, summary: ok[0] };
  const issues = PRETTIER_ISSUES_RE.exec(text) ?? PRETTIER_WARN_RE.exec(text);
  if (issues !== null) return { green: false, summary: issues[0] };
  return null;
}

// --- mkdocs -----------------------------------------------------------------

const MKDOCS_ERR_RE = /^ERROR\s+-\s+.*$/m;
const MKDOCS_OK_RE = /^INFO\s+-\s+Documentation built.*$/m;

function parseMkdocs(text: string): SummaryParse | null {
  const err = MKDOCS_ERR_RE.exec(text);
  if (err !== null) return { green: false, summary: err[0] };
  const ok = MKDOCS_OK_RE.exec(text);
  if (ok !== null) return { green: true, summary: ok[0] };
  return null;
}

// --- biome ------------------------------------------------------------------

const BIOME_FOUND_RE = /^Found (\d+) errors?\.$/m;
const BIOME_CHECKED_RE = /^Checked (\d+) files? in .*$/m;

function parseBiome(text: string): SummaryParse | null {
  const found = BIOME_FOUND_RE.exec(text);
  if (found !== null) return { green: num(found[1]) === 0, summary: found[0] };
  const checked = BIOME_CHECKED_RE.exec(text);
  if (checked !== null) return { green: true, summary: checked[0] };
  return null;
}

// --- pyright (`N errors, M warnings, K informations`) -----------------------

const PYRIGHT_RE = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?\s*$/m;

function parsePyright(text: string): SummaryParse | null {
  const m = PYRIGHT_RE.exec(text);
  if (m === null) return null;
  return { green: num(m[1]) === 0, summary: m[0].trim() };
}

/** Program-keyed dispatch (§4.6.5) — parsers never cross programs. */
function parseSummary(segment: ShellSegment, text: string): SummaryParse | null {
  const program = segment.program;
  if (program === 'ruff') return segment.argv[0] === 'format' ? parseRuffFormat(text) : parseRuffCheck(text);
  if (program === 'mypy') return parseMypy(text);
  if (program === 'tsc') return parseTsc(text);
  if (program === 'eslint') return parseEslint(text);
  if (program === 'prettier') return parsePrettier(text);
  if (program === 'mkdocs') return parseMkdocs(text);
  if (program === 'biome') return parseBiome(text);
  if (program === 'pyright') return parsePyright(text);
  return null; // clippy, go vet, npm scripts, …: exit only (§4.6.5)
}

const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(['ruff', 'biome', 'go', 'cargo', 'deno', 'uv']);
const MODE_WORDS: ReadonlySet<string> = new Set(['check', 'format', 'lint', 'vet', 'clippy', 'fmt', 'build', 'run']);
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-p', '--project', '--config', '-c', '--rulesdir', '--max-warnings']);

function toolName(segment: ShellSegment): string {
  const first = segment.argv[0];
  if (first !== undefined && !first.startsWith('-') && SUBCOMMAND_TOOLS.has(segment.program)) return `${segment.program} ${first}`;
  return segment.program;
}

/** `full` unless a positional path/pattern argument narrows the check. */
function checkScope(segment: ShellSegment): CheckRun['scope'] {
  const argv = segment.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    if (i === 0 && MODE_WORDS.has(a)) continue;
    if (a === '.') continue;
    return 'subset';
  }
  return 'full';
}

function clip(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 79)}…`;
}

function buildCheck(fact: CommandFact, segment: ShellSegment, text: string): CheckRun {
  const parse = parseSummary(segment, text);
  let green: boolean | 'unknown';
  if (parse !== null && parse.green !== undefined) {
    green = parse.green && !(segment.exitCode !== null && segment.exitCode !== 0); // a non-zero exit is never green
  } else if (segment.exitCode === 0) {
    green = true;
  } else if (segment.exitCode !== null) {
    green = false;
  } else {
    green = 'unknown';
  }
  const check: CheckRun = {
    seq: fact.seq,
    toolCallId: fact.toolCallId,
    family: segment.family as CheckRun['family'],
    tool: toolName(segment),
    scope: checkScope(segment),
    exitCode: segment.exitCode,
    green,
  };
  if (parse?.summary !== undefined) check.summary = clip(parse.summary.trim());
  if (parse?.autoFixed === true) check.autoFixed = true;
  return check;
}
