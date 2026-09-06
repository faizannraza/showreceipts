/**
 * Help text: the §12.4 top-level screen verbatim, plus one block per command
 * (`showreceipts <cmd> --help`) assembled from the flag table in `args.ts`.
 * S23c later moves the shared option table into `commands/help.ts` and the
 * command steps add their own sections.
 */
import { flagsFor, type CommandName, type FlagSpec } from './args.js';

/** The `showreceipts --help` screen (ARCHITECTURE §12.4, verbatim). */
export const HELP_TEXT = `showreceipts — your coding agent said "done". Show receipts.

Usage: showreceipts [command] [options]

Commands
  audit (default)   Scan agent session logs on disk; print a summary, the latest receipt and your false-done rate
  session <id>      Full receipt for one session (id prefix, path, or "latest") with the evidence timeline
  report            Write a single-file HTML report to .showreceipts/report.html
  export <id>       Markdown (--md) or JSON (--json) receipt for PR descriptions and CI artifacts
  setup             Install Stop/post-tool hooks in the harnesses found on this machine (idempotent; --dry-run; --remove)
  demo              Render bundled synthetic receipts (no data needed)
  bench             False-done / unverified / test-run rates per model × harness × version; --publish writes aggregates only
  doctor            What was found on disk, unknown record shapes, hook status, price coverage
  hook              (internal) hook entrypoint invoked by harnesses

Options
  --since <d|date>  Only sessions ending after this (default 90d)      --harness <list>   claude-code,codex,cursor,gemini,copilot,hermes,dsh
  --project <p>     Match session cwd substring or path                --json             Machine-readable output
  --as-of <date>    Price everything at that date's rates (YYYY-MM-DD) --prices <file>    Override prices.json
  --no-color        Disable color (also NO_COLOR)                        --ascii            ASCII box and glyphs
  --width <n>       Terminal width to render for (40–200; < 74 switches to narrow mode; > 102 is treated as 102)
  --no-cache        Ignore the parse cache

Nothing leaves this machine. Read-only over agent logs. Writes only .showreceipts/ (in git repos) and ~/.showreceipts/.
`;

/** One-line summaries (the Commands column of §12.4). */
export const COMMAND_SUMMARY: Readonly<Record<CommandName, string>> = {
  audit: 'Scan agent session logs on disk; print a summary, the latest receipt and your false-done rate',
  session: 'Full receipt for one session (id prefix, path, or "latest") with the evidence timeline',
  report: 'Write a single-file HTML report to .showreceipts/report.html',
  export: 'Markdown (--md) or JSON (--json) receipt for PR descriptions and CI artifacts',
  setup: 'Install Stop/post-tool hooks in the harnesses found on this machine (idempotent; --dry-run; --remove)',
  demo: 'Render bundled synthetic receipts (no data needed)',
  bench: 'False-done / unverified / test-run rates per model × harness × version; --publish writes aggregates only',
  doctor: 'What was found on disk, unknown record shapes, hook status, price coverage',
  hook: '(internal) hook entrypoint invoked by harnesses',
};

/** Per-command synopsis lines (§12.1). */
export const COMMAND_SYNOPSIS: Readonly<Record<CommandName, string>> = {
  audit:
    'showreceipts [audit] [--since 90d|YYYY-MM-DD] [--until …] [--all] [--harness h[,h]] [--project <substr|path>] [--limit N] [--all-claims] [--json] [--no-cache] [--as-of DATE] [--prices FILE] [--width N] [--ascii|--unicode] [--no-color] [--tz local|utc] [--now ISO]',
  session: 'showreceipts session <id|prefix|path|latest> [--turn N] [--json] [--explain-claim] [--timeline] [--no-cache] [common options]',
  report:
    'showreceipts report [--out .showreceipts/report.html] [--open] [--hash-paths|--hash-paths=both] [--full N] [--since …] [--harness …] [--project …] [--limit N] [--ascii|--unicode] [--json]',
  export: 'showreceipts export <id|latest> (--md | --json) [--out FILE] [--hash-paths] [--timeline] [--turn N]',
  setup: 'showreceipts setup [--harness h[,h]] [--all] [--dry-run] [--remove] [--restore <backup>] [--strict] [--project] [--shared] [--json]',
  hook: 'showreceipts hook <harness> [<event>] [--strict] [--strict-max N] [--strict-reasons list] [--force-record] [--verbose] [--debug]',
  demo: 'showreceipts demo [--json] [--width N] [--ascii] [--tz …]',
  bench: 'showreceipts bench [--since 30d] [--month YYYY-MM] [--harness …] [--publish [FILE]] [--json]',
  doctor: 'showreceipts doctor [--json] [--clear-cache] [--prune-ledgers <days>] [--verbose]',
};

const COMMAND_DETAIL: Readonly<Record<CommandName, string>> = {
  audit:
    'Scans the agent session logs found on this machine (Claude Code and Codex transcripts, hook-captured ledgers), builds a receipt for the last "done" turn of every session in the window, then prints a summary table, the most recent receipt and your false-done rate. Read-only over the logs; never fails because of one bad file; exits 0 even when no session is found.',
  session:
    'Prints the full receipt for one session, every claim with its evidence, selected by id prefix, transcript path or "latest". --timeline adds the evidence timeline, --explain-claim shows how each claim was recognised and judged, --turn N picks a turn other than the last done one. Exits 5 when the id is not found or the prefix is ambiguous (the candidates are listed).',
  report:
    'Writes a single-file HTML report (session list, receipts, timelines) to .showreceipts/report.html under the current git root, or to --out. The file loads nothing from the network. --open launches it in your browser; --hash-paths replaces absolute paths with hashes so the file can be shared (=both keeps a toggle).',
  export:
    'Prints one session\'s receipt as Markdown (--md) or JSON (--json) for PR descriptions and CI artifacts; --out writes it to a file instead of stdout. Exits 5 when the id is not found or ambiguous.',
  setup:
    'Detects the harnesses installed on this machine and installs the showreceipts Stop/post-tool hooks in their config files. Idempotent: a backup of every touched file is kept under ~/.showreceipts/backups. --dry-run shows the diff without writing, --remove uninstalls, --restore <backup> rolls back (pass the same --project/--shared scope flags as the setup run that wrote the backup), --strict enables the contradiction nudge, --project and --shared select project-level config files. Exits 3 when a manual step is required (the snippet is printed).',
  hook:
    'Internal entrypoint invoked by harness hooks (showreceipts setup installs it). Reads the event from stdin, records it to the ledger or builds the receipt, and always exits 0 with a JSON object on stdout; unrecognised arguments are ignored.',
  demo: 'Renders bundled synthetic receipts so you can see the output without any session data. Ignores every root on disk, the parse cache and every price override.',
  bench:
    'Aggregates the false-done, unverified and test-run rates per model × harness × version over the window (--since, or a calendar month with --month YYYY-MM). --publish writes an aggregates-only JSON file (no paths, ids, prompts or day-precision dates) that is safe to share.',
  doctor:
    'Reports what was found on disk (roots, sessions, harness versions), unknown record shapes, installed hook status and price coverage. Exit 4 signals a core-shape problem; warnings alone exit 0. --clear-cache empties the parse cache; --prune-ledgers <days> removes hook ledgers older than that.',
};

interface FlagHelp {
  readonly arg?: string;
  readonly text: string;
  readonly textBy?: Readonly<Partial<Record<CommandName, string>>>;
  /** Per-command argument override; `''` drops the argument for that command. */
  readonly argBy?: Readonly<Partial<Record<CommandName, string>>>;
}

const FLAG_HELP: Readonly<Record<string, FlagHelp>> = {
  since: { arg: '<d|date>', text: 'Only sessions ending after this (default 90d)' },
  until: { arg: '<d|date>', text: 'Only sessions ending before this' },
  all: { text: 'No time window: every session on disk', textBy: { setup: 'Every harness found on this machine' } },
  harness: { arg: '<list>', text: 'claude-code,codex,cursor,gemini,copilot,hermes,dsh' },
  project: {
    arg: '<p>',
    text: 'Match session cwd substring or path',
    textBy: { setup: 'Write the project-level config instead of the user-level one' },
  },
  limit: { arg: '<n>', text: 'Rows in the session table (default 20)' },
  'all-claims': { text: 'Show every claim of the latest receipt (default: 12 rows)' },
  json: { text: 'Machine-readable output' },
  md: { text: 'Markdown output' },
  out: { arg: '<file>', text: 'Write to this file' },
  width: { arg: '<n>', text: 'Terminal width to render for (40–200; < 74 switches to narrow mode; > 102 is treated as 102)' },
  ascii: { text: 'ASCII box and glyphs' },
  unicode: { text: 'Unicode box and glyphs (default on a UTF-8 terminal)' },
  'no-color': { text: 'Disable color (also NO_COLOR)' },
  tz: { arg: 'local|utc', text: 'Time zone for printed times (default local)' },
  now: { arg: '<iso>', text: 'Pretend the current time is this ISO-8601 timestamp (also SHOWRECEIPTS_NOW)' },
  'no-cache': { text: 'Ignore the parse cache' },
  'as-of': { arg: '<date>', text: "Price everything at that date's rates (YYYY-MM-DD)" },
  prices: { arg: '<file>', text: 'Override prices.json' },
  'hash-paths': {
    arg: '[=both]',
    text: 'Replace absolute paths with hashes (=both keeps a toggle)',
    // §12.1: only `report` takes `=both` (the HTML toggle); `export` hashes unconditionally.
    argBy: { export: '' },
    textBy: { export: 'Replace absolute paths with hashes' },
  },
  turn: { arg: '<n>', text: 'Receipt for turn N instead of the last done turn' },
  'explain-claim': { text: 'Show how each claim was recognised and judged' },
  timeline: { text: 'Include the evidence timeline' },
  open: { text: 'Open the report in the default browser' },
  full: { arg: '<n>', text: 'Embed full timelines for the N most recent sessions' },
  bench: { text: 'Include the bench table in the report' },
  month: { arg: '<YYYY-MM>', text: 'Calendar-month window (instead of --since)' },
  publish: { arg: '[file]', text: 'Write the aggregates-only publish file (default under .showreceipts/)' },
  'dry-run': { text: 'Show what would change without writing' },
  remove: { text: 'Uninstall the showreceipts hooks' },
  restore: { arg: '<backup>', text: 'Restore a config backup written by setup (use the same scope flags as that run)' },
  strict: {
    text: 'Nudge the agent when its final message is contradicted (Stop hook)',
    textBy: { hook: 'Enable the contradiction nudge for this event' },
  },
  shared: { text: 'Write the shared project config (.claude/settings.json) instead of the local one' },
  'strict-max': { arg: '<n>', text: 'Maximum nudges per turn (default 1)' },
  'strict-reasons': { arg: '<list>', text: 'Reasons that may nudge: no-test-run,last-run-red,stale-run,check-red,git-op-failed' },
  'force-record': { text: 'Record tool events even for transcripts showreceipts reads from disk' },
  'clear-cache': { text: 'Empty ~/.showreceipts/cache' },
  'prune-ledgers': { arg: '<days>', text: 'Delete hook ledgers older than N days' },
  verbose: { text: 'Print unknown-shape counts and other diagnostics' },
  debug: { text: 'Debug logging on stderr (hook: ~/.showreceipts/hook.log)' },
};

const META_FLAGS: ReadonlySet<string> = new Set(['help', 'version']);

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

function formatFlag(spec: FlagSpec, command: CommandName): string {
  const help = FLAG_HELP[spec.name];
  const arg = help?.argBy?.[command] ?? help?.arg;
  const left = arg !== undefined && arg !== '' ? `--${spec.name} ${arg}` : `--${spec.name}`;
  const text = help?.textBy?.[command] ?? help?.text ?? '';
  return `  ${left.padEnd(24)} ${text}`.trimEnd();
}

/** The `showreceipts <command> --help` block: one paragraph plus the command's flags. */
export function commandHelp(command: CommandName): string {
  const lines = [
    `showreceipts ${command} — ${COMMAND_SUMMARY[command]}`,
    '',
    ...wrap(`Usage: ${COMMAND_SYNOPSIS[command]}`, 100, 7),
    '',
    ...wrap(COMMAND_DETAIL[command], 100),
    '',
    'Options',
  ];
  for (const spec of flagsFor(command)) {
    if (spec.hidden || META_FLAGS.has(spec.name)) continue;
    lines.push(formatFlag(spec, command));
  }
  lines.push('', 'Nothing leaves this machine. Read-only over agent logs. Writes only .showreceipts/ (in git repos) and ~/.showreceipts/.');
  return `${lines.join('\n')}\n`;
}

/** The one-line usage hint printed under a usage error. */
export function usageFooter(command?: CommandName): string {
  if (command === undefined || command === 'audit') {
    return "Usage: showreceipts [command] [options]; try 'showreceipts --help'";
  }
  return `Usage: ${COMMAND_SYNOPSIS[command]}; try 'showreceipts ${command} --help'`;
}
