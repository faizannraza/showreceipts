/**
 * Hand-rolled argv parser for the showreceipts CLI (ARCHITECTURE §12.1/§12.4).
 *
 * Pure: no process, environment or filesystem access. Every usage problem
 * becomes a `UsageError` (exit 2) naming the offending token — except for the
 * `hook` command, where parsing never throws and offending tokens are
 * collected in `ParsedArgs.unknown` (§9: `hook` must always exit 0).
 *
 * Flag keys in `ParsedArgs.flags` are the long names exactly as typed, without
 * the leading dashes (`flags['no-color']`, `flags['as-of']`).
 */

export const COMMANDS = [
  'audit',
  'session',
  'report',
  'export',
  'setup',
  'hook',
  'demo',
  'bench',
  'doctor',
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** The command used when argv names none. */
export const DEFAULT_COMMAND: CommandName = 'audit';

export type FlagKind = 'bool' | 'string' | 'number' | 'list' | 'enum' | 'optional-string';
export type FlagValue = string | number | boolean | string[];

export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  /** Commands that accept the flag. */
  readonly commands: readonly CommandName[];
  /** Per-command kind overrides (`--project` is a string for audit, a bool for setup). */
  readonly kindBy?: Readonly<Partial<Record<CommandName, FlagKind>>>;
  /** `enum`: the accepted values; `bool`: extra `=value` forms (`--hash-paths=both`). */
  readonly choices?: readonly string[];
  /** Returns the coerced value or throws an `Error` whose message is shown after `--name: `. */
  readonly validate?: (raw: string) => string | number;
  /** Documented default (informational; `flags` only holds what was passed). */
  readonly default?: FlagValue;
  /** Hidden flags are accepted but never listed in `--help`. */
  readonly hidden?: boolean;
}

export interface ParsedArgs {
  command: CommandName;
  /** Whether argv named the command explicitly (false when `audit` was defaulted). */
  commandGiven: boolean;
  positionals: string[];
  flags: Record<string, FlagValue>;
  /** `hook` only: every token the parser could not accept, in argv order. */
  unknown: string[];
}

/** A usage error: the CLI prints `showreceipts: <message>` plus a usage line and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  readonly exitCode = 2;
  readonly command: CommandName | undefined;

  constructor(message: string, command?: CommandName) {
    super(message);
    this.command = command;
  }
}

const ALL: readonly CommandName[] = COMMANDS;
const NOT_HOOK: readonly CommandName[] = COMMANDS.filter((c) => c !== 'hook');
const SCAN: readonly CommandName[] = ['audit', 'session', 'report', 'export', 'bench'];
const RENDER: readonly CommandName[] = ['audit', 'session', 'export', 'demo', 'bench', 'doctor'];
const PRICED: readonly CommandName[] = [...SCAN, 'hook'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i;

/** True for `YYYY-MM-DD` strings that name a real calendar date (no 2026-02-30). */
export function isCalendarDate(raw: string): boolean {
  if (!DATE_RE.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Parses an ISO-8601 date or timestamp; `undefined` when it is malformed or names an impossible date. */
export function parseIsoTimestamp(raw: string): Date | undefined {
  if (!ISO_RE.test(raw) || !isCalendarDate(raw.slice(0, 10))) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

function nonNegativeInt(raw: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`expected a non-negative integer (got '${raw}')`);
  }
  return Number(raw);
}

function width(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= 40 && n <= 200)) throw new Error(`expected an integer between 40 and 200 (got '${raw}')`);
  return n;
}

function dateOrDays(raw: string): string {
  if (!DATE_RE.test(raw) && !/^\d+d$/.test(raw)) throw new Error(`expected YYYY-MM-DD or <N>d (got '${raw}')`);
  return raw;
}

function asOfDate(raw: string): string {
  if (!isCalendarDate(raw)) throw new Error('expected YYYY-MM-DD');
  return raw;
}

function isoTimestamp(raw: string): string {
  if (parseIsoTimestamp(raw) === undefined) throw new Error(`expected an ISO-8601 timestamp (got '${raw}')`);
  return raw;
}

function yearMonth(raw: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(raw)) throw new Error(`expected YYYY-MM (got '${raw}')`);
  return raw;
}

/** The flag table (§12.1/§12.4); `help.ts` renders per-command option lists from it. */
export const FLAG_SPECS: readonly FlagSpec[] = [
  // selection window
  { name: 'since', kind: 'string', commands: SCAN, validate: dateOrDays, default: '90d' },
  { name: 'until', kind: 'string', commands: SCAN, validate: dateOrDays },
  { name: 'all', kind: 'bool', commands: [...SCAN, 'setup'] },
  { name: 'harness', kind: 'list', commands: [...SCAN, 'setup', 'doctor'] },
  { name: 'project', kind: 'string', commands: [...SCAN, 'setup'], kindBy: { setup: 'bool' } },
  { name: 'limit', kind: 'number', commands: ['audit', 'report', 'bench'], validate: nonNegativeInt, default: 20 },
  { name: 'all-claims', kind: 'bool', commands: ['audit'] },
  // output and rendering
  { name: 'json', kind: 'bool', commands: NOT_HOOK },
  { name: 'md', kind: 'bool', commands: ['export'] },
  { name: 'out', kind: 'string', commands: ['report', 'export'] },
  { name: 'width', kind: 'number', commands: RENDER, validate: width },
  // `report`'s status lines carry renderer glyphs, so --ascii/--unicode pin
  // them for byte-identical stdout across locales (Pass 2 determinism);
  // --width stays RENDER-only (report renders no width-fitted screen).
  { name: 'ascii', kind: 'bool', commands: [...RENDER, 'report'] },
  { name: 'unicode', kind: 'bool', commands: [...RENDER, 'report'] },
  { name: 'no-color', kind: 'bool', commands: ALL },
  { name: 'tz', kind: 'enum', commands: [...RENDER, 'report', 'hook'], choices: ['local', 'utc'], default: 'local' },
  { name: 'now', kind: 'string', commands: ALL, validate: isoTimestamp },
  { name: 'no-cache', kind: 'bool', commands: [...SCAN, 'doctor', 'hook'] },
  { name: 'as-of', kind: 'string', commands: PRICED, validate: asOfDate },
  { name: 'prices', kind: 'string', commands: PRICED },
  { name: 'hash-paths', kind: 'bool', commands: ['report', 'export'], choices: ['both'] },
  // session / export / report
  { name: 'turn', kind: 'number', commands: ['session', 'export'], validate: nonNegativeInt },
  { name: 'explain-claim', kind: 'bool', commands: ['session'] },
  { name: 'timeline', kind: 'bool', commands: ['session', 'export'] },
  { name: 'open', kind: 'bool', commands: ['report'] },
  { name: 'full', kind: 'number', commands: ['report'], validate: nonNegativeInt },
  { name: 'bench', kind: 'bool', commands: ['report'] },
  // bench
  { name: 'month', kind: 'string', commands: ['bench'], validate: yearMonth },
  { name: 'publish', kind: 'optional-string', commands: ['bench'] },
  // setup
  { name: 'dry-run', kind: 'bool', commands: ['setup'] },
  { name: 'remove', kind: 'bool', commands: ['setup'] },
  { name: 'restore', kind: 'string', commands: ['setup'] },
  { name: 'strict', kind: 'bool', commands: ['setup', 'hook'] },
  { name: 'shared', kind: 'bool', commands: ['setup'] },
  // hook
  { name: 'strict-max', kind: 'number', commands: ['hook'], validate: nonNegativeInt, default: 1 },
  { name: 'strict-reasons', kind: 'list', commands: ['hook'] },
  { name: 'force-record', kind: 'bool', commands: ['hook'] },
  // doctor
  { name: 'clear-cache', kind: 'bool', commands: ['doctor'] },
  { name: 'prune-ledgers', kind: 'number', commands: ['doctor'], validate: nonNegativeInt },
  // diagnostics, hidden, meta
  { name: 'verbose', kind: 'bool', commands: ALL },
  { name: 'debug', kind: 'bool', commands: ALL },
  { name: 'home-dir', kind: 'string', commands: ALL, hidden: true },
  { name: 'svg', kind: 'string', commands: ['demo'], hidden: true },
  { name: 'help', kind: 'bool', commands: NOT_HOOK },
  { name: 'version', kind: 'bool', commands: NOT_HOOK },
];

const SPEC_BY_NAME: ReadonlyMap<string, FlagSpec> = new Map(FLAG_SPECS.map((s) => [s.name, s]));

/** Maximum positional arguments per command (`session <id>`, `export <id>`, `hook <harness> [<event>]`). */
const MAX_POSITIONALS: Readonly<Record<CommandName, number>> = {
  audit: 0,
  session: 1,
  report: 0,
  export: 1,
  setup: 0,
  hook: 2,
  demo: 0,
  bench: 0,
  doctor: 0,
};

/** Every flag spec a command accepts, in table order. */
export function flagsFor(command: CommandName): FlagSpec[] {
  return FLAG_SPECS.filter((s) => s.commands.includes(command));
}

/** The documented default of a flag, if any. */
export function flagDefault(name: string): FlagValue | undefined {
  return SPEC_BY_NAME.get(name)?.default;
}

/** The effective kind of a flag for a command. */
export function flagKind(spec: FlagSpec, command: CommandName): FlagKind {
  return spec.kindBy?.[command] ?? spec.kind;
}

function isCommand(tok: string): tok is CommandName {
  return (COMMANDS as readonly string[]).includes(tok);
}

function isOption(tok: string): boolean {
  return tok.length > 1 && tok.startsWith('-');
}

function takesValue(kind: FlagKind): boolean {
  return kind === 'string' || kind === 'number' || kind === 'list' || kind === 'enum';
}

/**
 * Finds the command named in argv without validating anything (never throws).
 * The command is the first non-option token; values of known flags are skipped.
 */
export function peekCommand(argv: readonly string[]): { command: CommandName; given: boolean } {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '--') break;
    if (!isOption(tok)) {
      return isCommand(tok) ? { command: tok, given: true } : { command: DEFAULT_COMMAND, given: false };
    }
    if (!tok.startsWith('--') || tok.includes('=')) continue;
    const spec = SPEC_BY_NAME.get(tok.slice(2));
    const next = argv[i + 1];
    if (spec === undefined || next === undefined) continue;
    if (takesValue(spec.kind) ? !next.startsWith('--') : spec.kind === 'optional-string' && !next.startsWith('-')) {
      i++;
    }
  }
  return { command: DEFAULT_COMMAND, given: false };
}

function coerceBool(spec: FlagSpec, raw: string | undefined): boolean | string {
  if (raw === undefined || raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  if (spec.choices?.includes(raw)) return raw;
  const extra = spec.choices ? ` or ${spec.choices.join('/')}` : '';
  throw new Error(`expected true or false${extra} (got '${raw}')`);
}

function coerce(spec: FlagSpec, kind: FlagKind, raw: string | undefined, previous: FlagValue | undefined): FlagValue {
  switch (kind) {
    case 'bool':
      return coerceBool(spec, raw);
    case 'optional-string':
      return raw ?? true;
    case 'string':
      return spec.validate ? spec.validate(raw ?? '') : (raw ?? '');
    case 'number': {
      const n = spec.validate ? spec.validate(raw ?? '') : Number(raw);
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`expected a number (got '${raw ?? ''}')`);
      return n;
    }
    case 'list': {
      const items = Array.isArray(previous) ? [...previous] : [];
      for (const item of (raw ?? '').split(',')) {
        const v = item.trim();
        if (v !== '' && !items.includes(v)) items.push(v);
      }
      return items;
    }
    case 'enum': {
      const choices = spec.choices ?? [];
      if (raw === undefined || !choices.includes(raw)) {
        throw new Error(`expected one of ${choices.join(', ')} (got '${raw ?? ''}')`);
      }
      return raw;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Levenshtein distance over two short lowercase tokens (suggestion hint only). */
function editDistance(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min(tmp + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] as number;
}

/** The closest command name within edit distance 2 (`sessions` → `session`), or `null`. */
function suggestCommand(tok: string): CommandName | null {
  let best: CommandName | null = null;
  let bestDistance = 3;
  for (const command of COMMANDS) {
    const d = editDistance(tok.toLowerCase(), command);
    if (d < bestDistance) {
      bestDistance = d;
      best = command;
    }
  }
  return best;
}

/**
 * Parses argv into a command, positionals and validated flags.
 * Throws `UsageError` on any problem — never for the `hook` command.
 */
export function parse(argv: readonly string[]): ParsedArgs {
  const { command, given } = peekCommand(argv);
  const lenient = command === 'hook';
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];
  const fail = (message: string, ...tokens: string[]): void => {
    if (!lenient) throw new UsageError(message, command);
    unknown.push(...tokens);
  };
  let commandSeen = !given;
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (onlyPositionals || !isOption(tok)) {
      if (!commandSeen) {
        commandSeen = true;
        if (tok === command) continue;
      }
      if (!given) {
        // `showreceipts help` is git/npm muscle memory for `--help`.
        if (tok === 'help' && !onlyPositionals) {
          flags['help'] = true;
          continue;
        }
        const hint = suggestCommand(tok);
        fail(`unknown command '${tok}'${hint === null ? '' : ` — did you mean '${hint}'?`}`, tok);
      } else if (positionals.length >= MAX_POSITIONALS[command]) {
        fail(`${command}: unexpected argument '${tok}'`, tok);
      } else {
        positionals.push(tok);
      }
      continue;
    }
    if (tok === '--') {
      onlyPositionals = true;
      continue;
    }
    if (tok === '-h' && !lenient) {
      flags['help'] = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      fail(`unknown option '${tok}'`, tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let raw: string | undefined = eq === -1 ? undefined : tok.slice(eq + 1);
    const spec = SPEC_BY_NAME.get(name);
    if (spec === undefined) {
      fail(`unknown option '--${name}'`, tok);
      continue;
    }
    if (!spec.commands.includes(command)) {
      fail(`--${name} is not valid for ${command}`, tok);
      continue;
    }
    const kind = flagKind(spec, command);
    if (raw === undefined && takesValue(kind)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        fail(`--${name}: missing value`, tok);
        continue;
      }
      raw = next;
      i++;
    } else if (raw === undefined && kind === 'optional-string') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        raw = next;
        i++;
      }
    }
    try {
      flags[name] = coerce(spec, kind, raw, flags[name]);
    } catch (err) {
      fail(`--${name}: ${errorMessage(err)}`, raw === undefined ? tok : `--${name}=${raw}`);
    }
  }

  return { command, commandGiven: given, positionals, flags, unknown };
}
