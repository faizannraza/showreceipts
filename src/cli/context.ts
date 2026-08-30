/**
 * The command context: the only place where `process.env`, `process.stdout`,
 * `process.stderr`, `process.cwd()` and the wall clock are read on behalf of
 * commands. Tests inject streams, env and a clock through `createContext`.
 */
import { parseIsoTimestamp, UsageError, type ParsedArgs } from './args.js';

/** Everything a command may observe about its environment. */
export interface ContextInputs {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Whether stdout is an interactive terminal (colour, progress line). */
  isTTY: boolean;
  /** Terminal width reported by the tty, if any (`COLUMNS` lives in `env`). */
  columns: number | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** The clock: `--now` → `SHOWRECEIPTS_NOW` → the injected `now` → `Date.now()`. */
  now: Date;
}

export interface CommandContext extends ContextInputs {
  readonly args: ParsedArgs;
}

function ttyColumns(): number | undefined {
  const columns = (process.stdout as { columns?: unknown }).columns;
  return typeof columns === 'number' && columns > 0 ? columns : undefined;
}

/**
 * Resolves the clock for a command. `--now` wins, then `SHOWRECEIPTS_NOW`,
 * then the injected fallback, then the wall clock. A malformed value is a
 * usage error (exit 2) so a typo can never silently change the output.
 */
export function resolveNow(
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
  fallback?: Date,
): Date {
  const flag = args.flags['now'];
  if (typeof flag === 'string') {
    const parsed = parseIsoTimestamp(flag);
    if (parsed === undefined) throw new UsageError(`--now: expected an ISO-8601 timestamp (got '${flag}')`, args.command);
    return parsed;
  }
  const fromEnv = env['SHOWRECEIPTS_NOW'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = parseIsoTimestamp(fromEnv);
    if (parsed === undefined) {
      throw new UsageError(`SHOWRECEIPTS_NOW: expected an ISO-8601 timestamp (got '${fromEnv}')`, args.command);
    }
    return parsed;
  }
  return fallback ?? new Date();
}

/**
 * Builds the context for a command. Without overrides it reads the real
 * process streams, env and cwd; with an injected `stdout` the tty facts
 * default to "not a terminal" unless overridden too.
 */
export function createContext(args: ParsedArgs, overrides: Partial<ContextInputs> = {}): CommandContext {
  const stdoutInjected = overrides.stdout !== undefined;
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const isTTY = overrides.isTTY ?? (!stdoutInjected && process.stdout.isTTY === true);
  const columns = 'columns' in overrides ? overrides.columns : stdoutInjected ? undefined : ttyColumns();
  const now = resolveNow(args, env, overrides.now);
  return { args, now, stdout, stderr, isTTY, columns, env, cwd };
}
