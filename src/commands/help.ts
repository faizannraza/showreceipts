/**
 * Shared `--help` machinery (S23c; §12.4): the global option table every
 * command section draws from, the text-flow helpers all help screens share,
 * and the renderer for `showreceipts <cmd> --help`. Each command step
 * supplies its own {@link HelpSection} and prints `usage(command, section)`
 * on `--help`, exiting 0 with nothing else on stdout.
 *
 * Pass 3: help adapts to the terminal width. The CLI shell resolves the
 * column count (`render/box.ts resolveCols`, capped at 102) and passes it
 * down; everything renders single-column with flag descriptions wrapped and
 * hanging under the 24-character flag column, so an 80-column terminal
 * never hard-wraps a help row mid-word. {@link HELP_COLS_DEFAULT} (80) is
 * the render used when the width is unknown — it is what the committed
 * snapshots pin. Synopses wrap without ever splitting a `[--flag N]` group.
 *
 * This module lives in the commands layer because §0.5 forbids a runtime
 * import of the cli layer from below; `test/unit/commands/help.test.ts` pins
 * it against the argv flag table (`cli/args.ts`) and the S01 help renderer
 * so the two can never drift apart.
 */

/** The width every help screen renders at when the terminal width is unknown. */
export const HELP_COLS_DEFAULT = 80;

/** Flag column of an options table; descriptions hang at `2 + column + 1`. */
const FLAG_COLUMN = 24;

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
  { flag: 'width', arg: '<n>', text: 'Terminal width to render for (40–200; < 74 narrow mode; > 102 capped)' },
  { flag: 'ascii', text: 'ASCII box and glyphs' },
  { flag: 'unicode', text: 'Unicode box and glyphs (default on a UTF-8 terminal)' },
  { flag: 'no-color', text: 'Disable color (also NO_COLOR)' },
  { flag: 'tz', arg: 'local|utc', text: 'Time zone for printed times (default local)' },
  { flag: 'since', arg: '<d|date>', text: 'Only sessions ending after this (default 90d)' },
  { flag: 'until', arg: '<d|date>', text: 'Only sessions ending before this' },
  { flag: 'all', text: 'No time window: every session on disk' },
  { flag: 'harness', arg: '<list>', text: 'claude-code, codex, cursor, gemini, copilot, hermes, dsh, opencode, openclaw' },
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

/** The §12.4 closing line, appended to every help screen (never wrapped — it is pinned verbatim). */
export const PRIVACY_FOOTER =
  'Nothing leaves this machine. Read-only over agent logs. Writes only .showreceipts/ (git root, or the current directory outside a repo) and ~/.showreceipts/.';

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

/** Greedy word-wrap at `width` columns; continuation lines get `indent` spaces. */
export function wrapText(text: string, width: number, indent = 0): string[] {
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

const NBSP = '\u00a0';
const NBSP_RE = /\u00a0/g;

/** Replaces spaces inside `[...]`/`(...)` groups with NBSP so a wrap treats each group as one token. */
function atomizeGroups(s: string): string {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    out += ch === ' ' && depth > 0 ? NBSP : ch;
  }
  return out;
}

/**
 * {@link wrapText} for usage synopses: `[--limit N]` and `(--md | --json)`
 * groups wrap atomically (a flag is never split from its metavar). The NBSP
 * placeholders are width-neutral and never reach the output.
 */
export function wrapSynopsis(text: string, width: number, indent = 0): string[] {
  return wrapText(atomizeGroups(text), width, indent).map((line) => line.replace(NBSP_RE, ' '));
}

/** Plain greedy wrap of a description body at `width` columns (no prefixes). */
function wrapBody(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * One table row: `  <left padded to column> <text>`, the text wrapped at
 * `cols` with continuations hanging under the description column. A `left`
 * wider than the column gets its own line with the description below.
 */
export function optionLines(left: string, text: string, cols: number, column: number = FLAG_COLUMN): string[] {
  if (text === '') return [`  ${left}`];
  const hang = 2 + column + 1;
  const pad = ' '.repeat(hang);
  const body = wrapBody(text, Math.max(20, cols - hang));
  if (left.length > column) return [`  ${left}`, ...body.map((line) => pad + line)];
  const head = `  ${left.padEnd(column)} `;
  return body.map((line, i) => (i === 0 ? `${head}${line}`.trimEnd() : pad + line));
}

/** Renders one option row in the §12.4 style (multi-line when the text wraps at `cols`). */
export function formatOption(row: OptionRow, cols: number = HELP_COLS_DEFAULT): string {
  const left = row.arg !== undefined ? `--${row.flag} ${row.arg}` : `--${row.flag}`;
  return optionLines(left, row.text, cols).join('\n');
}

/**
 * The `showreceipts <command> --help` screen in the §12.4 style: summary
 * line, wrapped synopsis, detail paragraph, the options table and the
 * privacy footer, all flowed at `cols` columns. Callers print it to stdout
 * and exit 0 without any other output.
 */
export function usage(command: string, section: HelpSection, cols: number = HELP_COLS_DEFAULT): string {
  const width = Math.min(Math.max(cols, 40), 102);
  const lines = [
    `showreceipts ${command} — ${section.summary}`,
    '',
    ...wrapSynopsis(`Usage: ${section.synopsis}`, width, 7),
    '',
    ...wrapText(section.detail, width),
    '',
    'Options',
  ];
  for (const row of section.options) {
    const left = row.arg !== undefined ? `--${row.flag} ${row.arg}` : `--${row.flag}`;
    lines.push(...optionLines(left, row.text, width));
  }
  lines.push('', PRIVACY_FOOTER);
  return `${lines.join('\n')}\n`;
}
