/**
 * CLI entry point: parses argv, answers `--version`/`--help`, lazily loads the
 * command module and maps errors to exit codes (ARCHITECTURE §12.2).
 *
 * Startup cost matters (`--version` must finish in ≤ 80 ms), so the top level
 * imports only `node:*`, the tiny `cli/` modules and the shared help table
 * they pull in (`commands/help.ts`, dependency-free); every command is a
 * lazy thunk with a literal specifier, which `tsc` type-checks and
 * `scripts/check-no-network.mjs` accepts.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, peekCommand, UsageError, type CommandName } from './cli/args.js';
import { createContext, type CommandContext, type ContextInputs } from './cli/context.js';
import { commandHelp, topHelp, usageFooter } from './cli/help.js';
import { TOOL_VERSION } from './version.js';

/** The shape every `src/commands/<name>.ts` module exports. */
export interface CommandModule {
  run(ctx: CommandContext): Promise<number>;
}

export type CommandLoader = () => Promise<CommandModule>;

const LOADERS: Readonly<Record<CommandName, CommandLoader>> = {
  audit: () => import('./commands/audit.js'),
  session: () => import('./commands/session.js'),
  report: () => import('./commands/report.js'),
  export: () => import('./commands/export.js'),
  setup: () => import('./commands/setup.js'),
  hook: () => import('./commands/hook.js'),
  demo: () => import('./commands/demo.js'),
  bench: () => import('./commands/bench.js'),
  doctor: () => import('./commands/doctor.js'),
};

/** Test seams: injected streams/env/clock plus optional fake command modules. */
export interface MainOptions extends Partial<ContextInputs> {
  loaders?: Partial<Record<CommandName, CommandLoader>>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Terminal width for a help screen: `--width`, the tty, then `COLUMNS`,
 * else 80. `render/box.ts resolveCols` is imported lazily so the
 * `--version` startup path stays lean.
 */
async function helpColumns(
  flags: Record<string, unknown>,
  overrides: Partial<ContextInputs>,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const { resolveCols } = await import('./render/box.js');
  const env = overrides.env ?? process.env;
  const stdoutColumns =
    'columns' in overrides
      ? overrides.columns
      : typeof (stdout as { columns?: unknown }).columns === 'number'
        ? (stdout as { columns?: number }).columns
        : undefined;
  try {
    return resolveCols({
      width: typeof flags['width'] === 'number' ? (flags['width'] as number) : undefined,
      stdoutColumns,
      COLUMNS: env['COLUMNS'],
    });
  } catch {
    return 80;
  }
}

async function dispatch(
  argv: readonly string[],
  overrides: Partial<ContextInputs>,
  loaders: Partial<Record<CommandName, CommandLoader>>,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const args = parse(argv);
  if (args.command !== 'hook') {
    if (args.flags['version'] === true) {
      stdout.write(`${TOOL_VERSION}\n`);
      return 0;
    }
    if (args.flags['help'] === true) {
      const cols = await helpColumns(args.flags, overrides, stdout);
      stdout.write(args.commandGiven ? commandHelp(args.command, cols) : topHelp(cols));
      return 0;
    }
  } else if (argv.includes('--help')) {
    // §9 keeps hook stdout JSON-only for harnesses (they always pipe
    // stdin); an interactive human at a TTY gets the help block instead of
    // the never-fail `{}` answer. The meta-flag lands in `args.unknown`
    // (the hook parse is lenient), so argv is checked directly.
    const stdinIsTTY = overrides.stdinIsTTY ?? process.stdin.isTTY === true;
    if (stdinIsTTY) {
      stdout.write(commandHelp('hook', await helpColumns(args.flags, overrides, stdout)));
      return 0;
    }
  }
  const ctx = createContext(args, overrides);
  const load = loaders[args.command] ?? LOADERS[args.command];
  const module = await load();
  return module.run(ctx);
}

/**
 * Usage errors come from two places: this layer's `UsageError` (argv parsing)
 * and lower layers that must not import the cli layer at runtime (§0.5) —
 * `commands/common.ts` and `render/box.ts` raise their own classes carrying
 * `name: 'UsageError'` and `exitCode: 2`. Duck-typing keeps the §12.2 exit-2
 * contract without an upward import (S23c).
 */
function isUsageShaped(err: unknown): err is UsageError {
  if (err instanceof UsageError) return true;
  if (!(err instanceof Error)) return false;
  return err.name === 'UsageError' && (err as { exitCode?: unknown }).exitCode === 2;
}

function reportFailure(err: unknown, argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  if (peekCommand(argv).command === 'hook') {
    // §9: the hook never blocks a tool. Whatever failed, answer with an empty
    // object and exit 0; the real runtime (S27) logs to hook.log.
    try {
      stdout.write('{}\n');
    } catch {
      // stdout is gone; there is nobody left to answer.
    }
    return 0;
  }
  if (isUsageShaped(err)) {
    stderr.write(`showreceipts: ${err.message}\n${usageFooter(err.command)}\n`);
    return 2;
  }
  stderr.write(`showreceipts: ${errorMessage(err)}\n`);
  return 1;
}

/**
 * §9: the hook never fails the tool it answers. A write to a closed pipe
 * (EPIPE once the harness stops reading) is reported asynchronously as an
 * `'error'` event; unhandled, it would crash the process with exit 1 and a
 * stack trace after `main` had already returned 0.
 */
function swallowStreamErrors(stream: NodeJS.WritableStream): void {
  stream.on('error', () => undefined);
}

/**
 * §12.2 / S23c decision: for non-hook commands an interrupted pipe
 * (`showreceipts audit | head`) is not a failure. The EPIPE arrives as an
 * asynchronous `'error'` event once the reader closes; unhandled it would
 * crash the process with exit 1 and a stack trace after the command already
 * produced its exit code. Only EPIPE is swallowed — any other stream error
 * still surfaces. Injected test sinks without an `on` method are left alone.
 */
function swallowEpipe(stream: NodeJS.WritableStream): void {
  if (typeof (stream as { on?: unknown }).on !== 'function') return;
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

/**
 * Runs the CLI and returns its exit code. Called with no overrides (from
 * `bin/showreceipts.js` or `node dist/cli.js`) it uses the real process
 * streams and sets `process.exitCode`; with overrides it is a pure in-process
 * call for tests. Never rejects: every error becomes an exit code.
 */
export async function main(argv: readonly string[], overrides?: MainOptions): Promise<number> {
  const { loaders, ...ctxOverrides } = overrides ?? {};
  const stdout = ctxOverrides.stdout ?? process.stdout;
  const stderr = ctxOverrides.stderr ?? process.stderr;
  if (peekCommand(argv).command === 'hook') swallowStreamErrors(stdout);
  else swallowEpipe(stdout);
  let code: number;
  try {
    code = await dispatch(argv, ctxOverrides, loaders ?? {}, stdout);
  } catch (err) {
    code = reportFailure(err, argv, stdout, stderr);
  }
  if (overrides === undefined) process.exitCode = code;
  return code;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2));
}
