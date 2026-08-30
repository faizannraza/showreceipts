/**
 * CLI entry point: parses argv, answers `--version`/`--help`, lazily loads the
 * command module and maps errors to exit codes (ARCHITECTURE §12.2).
 *
 * Startup cost matters (`--version` must finish in ≤ 80 ms), so the top level
 * imports only `node:*` and the four tiny `cli/` modules; every command is a
 * lazy thunk with a literal specifier, which `tsc` type-checks and
 * `scripts/check-no-network.mjs` accepts.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, peekCommand, UsageError, type CommandName } from './cli/args.js';
import { createContext, type CommandContext, type ContextInputs } from './cli/context.js';
import { commandHelp, HELP_TEXT, usageFooter } from './cli/help.js';
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
      stdout.write(args.commandGiven ? commandHelp(args.command) : HELP_TEXT);
      return 0;
    }
  }
  const ctx = createContext(args, overrides);
  const load = loaders[args.command] ?? LOADERS[args.command];
  const module = await load();
  return module.run(ctx);
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
  if (err instanceof UsageError) {
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
