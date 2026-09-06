/**
 * The harness-agnostic hook runtime (§9, S27). Contract, in order:
 *
 * 1. Drain stdin to EOF before any early return (a TTY is `{}`).
 * 2. `<harness>` must be a known dialect, else answer `{}` (+ counter).
 * 3. Event from argv, else `hook_event_name`; an unsubscribed event is `{}`.
 * 4. Budget per event class (stop 20 s, record 1.5 s, session 1 s) with a
 *    watchdog that writes `{}` via `fs.writeSync(1, …)`, logs to `hook.log`,
 *    bumps `stopBudgetExceeded` and exits 0.
 * 5. Overflowed/unparsable stdin appends a salvage line (`tool-post` or
 *    `gap`) and bumps `stdinOverflow`.
 * 6. The dialect's `parse`/`handle` run inside a catch-all; any throw —
 *    including the test-only `SHOWRECEIPTS_DEBUG_THROW`, honoured only with
 *    `--debug` — still answers `{}`. `uncaughtException`/`unhandledRejection`
 *    are last-resort handlers that emit `{}` and exit 0.
 * 7. Output is always one `JSON.stringify(out) + '\n'` write before exit;
 *    the exit code is always 0. Per-invocation counters persist to
 *    `<home>/state/counters.json` (`HookCounters`; S25 `doctor` reads it).
 *
 * `process.env` is never read here: the environment arrives through
 * {@link HookProcessInputs} (`SHOWRECEIPTS_HOME`, `HOME`, and — with
 * `--debug` only — `SHOWRECEIPTS_DEBUG_THROW`).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { Harness, HookCounters } from '../model/types.js';
import { atomicWriteFile, ensureDir, readJsonFile } from '../util/fs.js';
import { isRecord, stableStringify } from '../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookFlags, HookOutput } from './dialect.js';
import { hookLog } from './log.js';
import { ledgerPath, unknownSid } from './paths.js';
import { appendLedgerLine, salvageLedgerLine } from './record.js';
import { readHookState, writeHookState } from './state.js';
import { readStdin, type StdinRead } from './stdin.js';

/** Wall-time budget per event class (§9). */
export const EVENT_BUDGET_MS: Readonly<Record<EventClass, number>> = { stop: 20_000, record: 1_500, session: 1_000 };

/** The lenient argv parse of `hook <harness> [<event>] [flags…]`. */
export interface HookArgs {
  positionals: readonly string[];
  flags: Readonly<Record<string, unknown>>;
}

/** What the runtime may observe about the process (the command layer adapts its context to this). */
export interface HookProcessInputs {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** The frozen clock (`--now` → `SHOWRECEIPTS_NOW` → wall clock, resolved by the CLI context). */
  now: Date;
}

/** Test/in-process seams; production uses the defaults (real fd 0/1, `process.exit`). */
export interface HookSeams {
  /** Pre-drained stdin (in-process callers must not read the real fd 0). */
  stdin?: StdinRead;
  /** Output writer; the default is the §9 `fs.writeSync(1, …)`. */
  write?: (text: string) => void;
  /** Process terminator for the watchdog and last-resort handlers. */
  exit?: (code: number) => void;
}

const COUNTER_KEYS = ['invocations', 'stdinOverflow', 'stopBudgetExceeded', 'copilotTranscriptUnparsed', 'unknownDialect'] as const;
const OUTPUT_COUNTER_KEYS = ['stdinOverflow', 'stopBudgetExceeded', 'copilotTranscriptUnparsed', 'unknownDialect'] as const;

/** Tolerant read of `<home>/state/counters.json` (missing file or key ⇒ 0). */
function readCounters(home: string): HookCounters {
  const raw = readJsonFile(join(home, 'state', 'counters.json'));
  const out: HookCounters = { invocations: 0, stdinOverflow: 0, stopBudgetExceeded: 0, copilotTranscriptUnparsed: 0, unknownDialect: 0 };
  if (isRecord(raw)) {
    for (const key of COUNTER_KEYS) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
    }
  }
  return out;
}

/** Folds `delta` into the persisted counters (atomic, `0600`); best-effort, never throws. */
function persistCounters(home: string | null, delta: Partial<HookCounters>): void {
  if (home === null) return;
  try {
    const counters = readCounters(home);
    for (const key of COUNTER_KEYS) counters[key] += delta[key] ?? 0;
    const dir = join(home, 'state');
    ensureDir(dir, 0o700);
    atomicWriteFile(join(dir, 'counters.json'), `${stableStringify(counters)}\n`, { mode: 0o600 });
  } catch {
    // counters are diagnostics; losing one increment must never break a hook
  }
}

function flagBool(flags: Readonly<Record<string, unknown>>, name: string): boolean {
  return flags[name] === true;
}

function flagNumber(flags: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const value = flags[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flagString(flags: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function flagList(flags: Readonly<Record<string, unknown>>, name: string): string[] {
  const value = flags[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Coerces the lenient hook argv flags into the typed {@link HookFlags}. */
function coerceFlags(flags: Readonly<Record<string, unknown>>): HookFlags {
  const out: HookFlags = {
    strict: flagBool(flags, 'strict'),
    strictMax: flagNumber(flags, 'strict-max', 1),
    strictReasons: flagList(flags, 'strict-reasons'),
    forceRecord: flagBool(flags, 'force-record'),
    verbose: flagBool(flags, 'verbose'),
    debug: flagBool(flags, 'debug'),
    noCache: flagBool(flags, 'no-cache'),
    tz: flags['tz'] === 'utc' ? 'utc' : 'local',
  };
  const asOf = flagString(flags, 'as-of');
  if (asOf !== undefined) out.asOf = asOf;
  const prices = flagString(flags, 'prices');
  if (prices !== undefined) out.prices = prices;
  return out;
}

/** `SHOWRECEIPTS_HOME`, else `$HOME/.showreceipts`; `null` when neither is set (then nothing is written at all). */
function resolveHome(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env['SHOWRECEIPTS_HOME'];
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const home = env['HOME'];
  if (typeof home === 'string' && home !== '') return join(home, '.showreceipts');
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface WriteIo {
  t: string;
  cwd: string;
  delta: Partial<HookCounters>;
  log: (message: string) => void;
}

/** Appends the §9 salvage line for an over-cap/unparsable payload (best-effort). */
function recordSalvage(home: string | null, harness: Harness, stdin: StdinRead, io: WriteIo): void {
  if (home === null) return;
  try {
    const sid = stdin.salvage.sid ?? unknownSid(io.cwd, io.t);
    const line = salvageLedgerLine({
      t: io.t,
      harness,
      sid,
      salvage: stdin.salvage,
      bytes: stdin.bytes,
      reason: stdin.overflow ? 'oversize' : 'unparsable',
    });
    appendLedgerLine(ledgerPath(home, harness, sid), line);
  } catch (err) {
    io.log(`${harness}: salvage append failed (${errorText(err)})`);
  }
}

/** Performs the writes a dialect asked for: ledger appends, state merge, counter bumps. */
function applyOutput(home: string | null, dialect: Dialect, model: HookEventModel, out: HookOutput, io: WriteIo): void {
  if (out.counters !== undefined) {
    for (const key of OUTPUT_COUNTER_KEYS) {
      const bump = out.counters[key];
      if (typeof bump === 'number' && Number.isFinite(bump) && bump > 0) {
        io.delta[key] = (io.delta[key] ?? 0) + Math.floor(bump);
      }
    }
  }
  if (home === null) return;
  const sid = model.sid ?? unknownSid(io.cwd, io.t);
  if (out.ledgerLines !== undefined && out.ledgerLines.length > 0) {
    try {
      const path = ledgerPath(home, dialect.harness, sid);
      for (const line of out.ledgerLines) appendLedgerLine(path, line);
    } catch (err) {
      io.log(`${dialect.harness} ${model.event}: ledger append failed (${errorText(err)})`);
    }
  }
  if (out.state !== undefined) {
    try {
      writeHookState(home, dialect.harness, sid, { ...readHookState(home, dialect.harness, sid), ...out.state });
    } catch (err) {
      io.log(`${dialect.harness} ${model.event}: state write failed (${errorText(err)})`);
    }
  }
}

/**
 * Runs one hook invocation end to end (§9). Always resolves 0 and always
 * writes exactly one JSON object (plus `\n`) — through the seam when one is
 * injected, else `fs.writeSync(1, …)`. No code path throws out of this
 * function; the watchdog and the last-resort process handlers write `{}`
 * first and exit 0.
 */
export async function runHook(
  args: HookArgs,
  inputs: HookProcessInputs,
  registry: Readonly<Record<string, Dialect>>,
  seams: HookSeams = {},
): Promise<number> {
  const write =
    seams.write ??
    ((text: string): void => {
      fs.writeSync(1, text);
    });
  const exit =
    seams.exit ??
    ((code: number): void => {
      process.exit(code);
    });
  const flags = coerceFlags(args.flags);
  const home = resolveHome(inputs.env);
  const now = inputs.now;
  const t = now.toISOString();
  const delta: Partial<HookCounters> = { invocations: 1 };
  /**
   * Folds the pending delta into `counters.json` exactly once: the watchdog
   * and last-resort paths flush before their `exit` call (which an injected
   * in-process seam may make non-terminating), and the `finally` flush then
   * finds an empty delta instead of folding it a second time.
   */
  const flushCounters = (): void => {
    persistCounters(home, delta);
    for (const key of COUNTER_KEYS) delete delta[key];
  };
  let emitted = false;
  const emit = (out: object): void => {
    if (emitted) return;
    emitted = true;
    try {
      write(`${JSON.stringify(out)}\n`);
    } catch {
      // stdout is gone; there is nobody left to answer
    }
  };
  const log = (message: string): void => {
    if (home !== null) hookLog(home, now, message);
  };
  const debug = flags.debug ? log : (): void => undefined;
  const lastResort = (err: unknown): void => {
    log(`hook ${args.positionals.join(' ')}: uncaught (${errorText(err)}) — answered {}`);
    emit({});
    flushCounters();
    exit(0);
  };
  process.on('uncaughtException', lastResort);
  process.on('unhandledRejection', lastResort);
  let watchdog: NodeJS.Timeout | undefined;
  try {
    // §9: stdin is always drained before any early return.
    const stdin = seams.stdin ?? readStdin();
    if (stdin.error !== undefined) {
      // A drain that ended on a read error is how events get silently
      // dropped (S31 concurrency review) — leave a trace either way.
      log(`stdin drain ended on ${stdin.error.code} after ${stdin.error.bytes} byte(s)`);
    }
    const harness = args.positionals[0] ?? '';
    const dialect = registry[harness];
    if (dialect === undefined) {
      delta.unknownDialect = 1;
      log(`unknown dialect '${harness}' — answered {}`);
      emit({});
      return 0;
    }
    const io: WriteIo = { t, cwd: inputs.cwd, delta, log };
    let out: HookOutput = { stdout: {} };
    try {
      if (flags.debug && (inputs.env['SHOWRECEIPTS_DEBUG_THROW'] ?? '') !== '') {
        throw new Error('SHOWRECEIPTS_DEBUG_THROW: deliberate test failure');
      }
      if (stdin.overflow || stdin.json === null) {
        delta.stdinOverflow = 1;
        recordSalvage(home, dialect.harness, stdin, io);
      } else {
        const input = isRecord(stdin.json) ? stdin.json : {};
        const fromPayload = typeof input['hook_event_name'] === 'string' ? (input['hook_event_name'] as string) : '';
        const event = args.positionals[1] ?? fromPayload;
        const eventClass = dialect.events[event];
        if (eventClass === undefined) {
          debug(`${dialect.harness} ${event === '' ? '(no event)' : event}: not a subscribed event — answered {}`);
        } else {
          const budget = EVENT_BUDGET_MS[eventClass];
          watchdog = setTimeout(() => {
            delta.stopBudgetExceeded = (delta.stopBudgetExceeded ?? 0) + 1;
            log(`${dialect.harness} ${event}: ${eventClass} budget of ${budget} ms exceeded — answered {}`);
            emit({});
            flushCounters();
            exit(0);
          }, budget);
          const ctx: HookContext = {
            harness: dialect.harness,
            event,
            eventClass,
            now,
            home: home ?? '',
            cwd: inputs.cwd,
            env: inputs.env,
            flags,
            salvage: stdin.salvage,
            stdinBytes: stdin.bytes,
            overflow: stdin.overflow,
            debug,
          };
          const model = dialect.parse(event, input, ctx);
          out = await dialect.handle(model, ctx);
          applyOutput(home, dialect, model, out, io);
        }
      }
    } catch (err) {
      log(`${dialect.harness}: handler failed (${errorText(err)}) — answered {}`);
      out = { stdout: {} };
    }
    emit(out.stdout);
    return 0;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    process.removeListener('uncaughtException', lastResort);
    process.removeListener('unhandledRejection', lastResort);
    flushCounters();
  }
}
