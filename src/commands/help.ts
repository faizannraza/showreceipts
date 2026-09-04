/**
 * Shared `--help` machinery (S23c; §12.4): the global option table every
 * command section draws from and the renderer for `showreceipts <cmd>
 * --help`. Each command step supplies its own {@link HelpSection} (S24:
 * audit, session, export, demo; S25: report, doctor, bench; S30: setup) and
 * prints `usage(command, section)` on `--help`, exiting 0 with nothing else
 * on stdout.
 *
 * This module lives in the commands layer because §0.5 forbids a runtime
 * import of the cli layer from below; `test/unit/commands/help.test.ts` pins
 * it against the argv flag table (`cli/args.ts`) and the S01 help renderer
 * so the two can never drift apart.
 */

/** One row of an options table: `--flag <arg>  text`. */
export interface OptionRow {
  readonly flag: string;
  readonly arg?: string;
  readonly text: string;
}

/**
 * The §12.4 global flags in their canonical order. Command sections pick the
 * subset they accept via {@link sharedOptions} and append their own rows.
 */
export const SHARED_OPTIONS: readonly OptionRow[] = [
  { flag: 'json', text: 'Machine-readable output' },
  { flag: 'width', arg: '<n>', text: 'Terminal width to render for (40–200; < 74 switches to narrow mode; > 102 is treated as 102)' },
  { flag: 'ascii', text: 'ASCII box and glyphs' },
  { flag: 'unicode', text: 'Unicode box and glyphs (default on a UTF-8 terminal)' },
  { flag: 'no-color', text: 'Disable color (also NO_COLOR)' },
  { flag: 'tz', arg: 'local|utc', text: 'Time zone for printed times (default local)' },
  { flag: 'since', arg: '<d|date>', text: 'Only sessions ending after this (default 90d)' },
  { flag: 'until', arg: '<d|date>', text: 'Only sessions ending before this' },
  { flag: 'all', text: 'No time window: every session on disk' },
  { flag: 'harness', arg: '<list>', text: 'claude-code,codex,cursor,gemini,copilot,hermes,dsh' },
  { flag: 'project', arg: '<p>', text: 'Match session cwd substring or path' },
  { flag: 'prices', arg: '<file>', text: 'Override prices.json' },
  { flag: 'as-of', arg: '<date>', text: "Price everything at that date's rates (YYYY-MM-DD)" },
  { flag: 'no-cache', text: 'Ignore the parse cache' },
  { flag: 'now', arg: '<iso>', text: 'Pretend the current time is this ISO-8601 timestamp (also SHOWRECEIPTS_NOW)' },
  { flag: 'debug', text: 'Debug logging on stderr (hook: ~/.showreceipts/hook.log)' },
  { flag: 'version', text: 'Print the version and exit' },
  { flag: 'help', text: 'Show help and exit' },
];

const SHARED_BY_FLAG: ReadonlyMap<string, OptionRow> = new Map(SHARED_OPTIONS.map((row) => [row.flag, row]));

/** The §12.4 closing line, appended to every help screen. */
export const PRIVACY_FOOTER =
  'Nothing leaves this machine. Read-only over agent logs. Writes only .showreceipts/ (in git repos) and ~/.showreceipts/.';

/**
 * The shared rows named by `names`, in the given order. An unknown name
 * throws — a command section can never silently document a flag that does
 * not exist.
 */
export function sharedOptions(names: readonly string[]): OptionRow[] {
  return names.map((name) => {
    const row = SHARED_BY_FLAG.get(name);
    if (row === undefined) throw new Error(`help: '--${name}' is not a shared option`);
    return row;
  });
}

/** One command's help section; the command steps own their instances. */
export interface HelpSection {
  /** The one-line summary (§12.4 Commands column). */
  summary: string;
  /** The §12.1 synopsis (`showreceipts <cmd> …`). */
  synopsis: string;
  /** The descriptive paragraph. */
  detail: string;
  /** The option rows, shared and command-specific, in display order. */
  options: readonly OptionRow[];
}

const WRAP_WIDTH = 100;
const FLAG_COLUMN = 24;

/** Greedy word-wrap at `width` columns; continuation lines get `indent` spaces. */
function wrap(text: string, width: number, indent = 0): string[] {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);
  let line = '';
  for (const word of text.split(' ')) {
    const prefix = lines.length === 0 ? '' : pad;
    if (line !== '' && prefix.length + line.length + 1 + word.length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push((lines.length === 0 ? '' : pad) + line);
  return lines;
}

/** Renders one option row in the §12.4 two-column style. */
export function formatOption(row: OptionRow): string {
  const left = row.arg !== undefined ? `--${row.flag} ${row.arg}` : `--${row.flag}`;
  return `  ${left.padEnd(FLAG_COLUMN)} ${row.text}`.trimEnd();
}

/**
 * The `showreceipts <command> --help` screen in the §12.4 style: summary
 * line, wrapped synopsis, detail paragraph, the options table and the
 * privacy footer. Callers print it to stdout and exit 0 without any other
 * output.
 */
export function usage(command: string, section: HelpSection): string {
  const lines = [
    `showreceipts ${command} — ${section.summary}`,
    '',
    ...wrap(`Usage: ${section.synopsis}`, WRAP_WIDTH, 7),
    '',
    ...wrap(section.detail, WRAP_WIDTH),
    '',
    'Options',
  ];
  for (const row of section.options) lines.push(formatOption(row));
  lines.push('', PRIVACY_FOOTER);
  return `${lines.join('\n')}\n`;
}
