/**
 * The harness dialect contract (§9, S27): one {@link Dialect} per harness
 * maps its hook events onto the Appendix C ledger model and produces the
 * single JSON stdout answer. S28 (Claude Code, Codex, dsh) and S29 (Cursor,
 * Gemini, Copilot, Hermes, OpenCode, OpenClaw) replace the S27 stub bodies
 * in their own dialect files; this contract and the registry
 * (`dialects/index.ts`) are complete from S27 on and are never edited again.
 *
 * Dialects return what should happen — stdout, ledger lines, state — and the
 * runtime performs every write, so `parse`/`handle` stay testable without a
 * filesystem.
 */
import type { Harness, HookCounters, LedgerLine } from '../model/types.js';
import type { HookState } from './state.js';
import type { StdinSalvage } from './stdin.js';

/** Budget class of a hook event (§9): stop 20 s, record 1.5 s, session 1 s. */
export type EventClass = 'stop' | 'record' | 'session';

/** The hook flags (§12.1) as the runtime coerces them from the lenient argv parse. */
export interface HookFlags {
  strict: boolean;
  /** `--strict-max` (default 1): nudges per turn. */
  strictMax: number;
  /** `--strict-reasons` filter; empty ⇒ all five nudge reasons. */
  strictReasons: string[];
  /** dsh `--force-record`: record even under `~/.claude/projects/`. */
  forceRecord: boolean;
  verbose: boolean;
  debug: boolean;
  noCache: boolean;
  tz: 'local' | 'utc';
  asOf?: string;
  prices?: string;
}

/** Everything a dialect may observe about the invocation. */
export interface HookContext {
  harness: Harness;
  event: string;
  eventClass: EventClass;
  /** The frozen invocation clock (`--now` → `SHOWRECEIPTS_NOW` → wall clock). */
  now: Date;
  /** The showreceipts home (`SHOWRECEIPTS_HOME`, else `$HOME/.showreceipts`); `''` when none is resolvable. */
  home: string;
  /** The hook process's working directory. */
  cwd: string;
  /** The environment as handed to the command (dialects read harness roots from here, never `process.env`). */
  env: Readonly<Record<string, string | undefined>>;
  flags: HookFlags;
  /** Regex-salvaged stdin fields (populated only for overflow/unparsable payloads). */
  salvage: StdinSalvage;
  /** Total stdin bytes drained. */
  stdinBytes: number;
  /** Stdin exceeded the 32 MiB cap. */
  overflow: boolean;
  /** Traces to `<home>/hook.log` when `--debug` is on; a no-op otherwise. */
  debug(message: string): void;
}

/** What {@link Dialect.parse} extracts from one event payload. */
export interface HookEventModel {
  event: string;
  eventClass: EventClass;
  /** The parsed stdin payload (`{}` when stdin was empty or not an object). */
  input: Record<string, unknown>;
  /** The raw session id, or `null` when the payload carries none (the runtime substitutes `unknownSid`). */
  sid: string | null;
  /** Turn id (Cursor `generation_id`, Hermes `extra.turn_id`, Codex `turn_id`). */
  tid?: string;
  /** Working directory claimed by the event, when present. */
  cwd?: string;
}

/** What {@link Dialect.handle} answers; the runtime performs every write. */
export interface HookOutput {
  /** The single JSON object printed to stdout (`{}` when the harness expects nothing). */
  stdout: object;
  /** Appendix C lines to append — one `appendFileSync` each — to the session's ledger. */
  ledgerLines?: LedgerLine[];
  /** State fields to merge into `<home>/state/<harness>/<safeSid>.json`. */
  state?: Partial<HookState>;
  /** Counter bumps folded into `<home>/state/counters.json` (S29 Copilot uses `copilotTranscriptUnparsed`). */
  counters?: Partial<Omit<HookCounters, 'invocations'>>;
}

/** One harness's hook dialect. */
export interface Dialect {
  harness: Harness;
  /** Event name → budget class; an event not listed here answers `{}` untouched. */
  events: Record<string, EventClass>;
  /** Extracts the event model from the parsed stdin payload. Must not touch the filesystem. */
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel;
  /** Handles the event; may read (transcripts, ledgers) but leaves all home writes to the runtime. */
  handle(model: HookEventModel, ctx: HookContext): Promise<HookOutput>;
}
