/**
 * Claude Code dialect (§9 Claude Code + dsh rows, S28). Events: `Stop`
 * (transcript stop flow for `claude-code`, the dsh ledger stop for `dsh`),
 * `SessionStart` (strict only: `hookSpecificOutput.additionalContext`),
 * and `PostToolUse`/`PostToolUseFailure` — the dsh recording path, which
 * records only when `transcript_path` is not under
 * `$CLAUDE_CONFIG_DIR|~/.claude/projects/` by prefix (no I/O;
 * `--force-record` overrides). Failures become `tool-fail` with `out.exit`
 * parsed from `/^(?:Error: )?Exit code (-?\d+)/`.
 *
 * The dsh dialect (`dsh.ts`) reuses this implementation through
 * {@link makeClaudeCodeDialect} with `harness: 'dsh'` — same events, the
 * dsh ledger paths, and `Stop` storing `last_assistant_message` as
 * `stop.text` (§9 dsh row).
 */
import { join, sep } from 'node:path';
import type { LedgerLine, LedgerToolInput, ToolKind } from '../../model/types.js';
import { deriveKind } from '../../readers/ledger/kinds.js';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { runLedgerStop } from '../ledger-stop.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';
import { freshHookState, readHookState } from '../state.js';
import { buildStopReceipt, stopStdout } from '../stop.js';
import { decideNudge } from '../strict.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFailLine = Extract<LedgerLine, { e: 'tool-fail' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

/** The strict SessionStart context (§9 Claude Code row, verbatim). */
export const SESSION_START_CONTEXT = 'showreceipts is auditing this session: final messages are checked against the tool log.';

/** Exit-code parse for failure events (§9 dsh row). */
const EXIT_RE = /^(?:Error: )?Exit code (-?\d+)/;

const EVENTS: Readonly<Record<string, EventClass>> = {
  Stop: 'stop',
  SessionStart: 'session',
  PostToolUse: 'record',
  PostToolUseFailure: 'record',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** `transcript_path` lies under `$CLAUDE_CONFIG_DIR/projects/` or `~/.claude/projects/` (prefix only, no I/O). */
function underClaudeProjects(path: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const prefixes: string[] = [];
  const configDir = env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir !== '') prefixes.push(join(configDir, 'projects') + sep);
  const home = env['HOME'];
  if (home !== undefined && home !== '') prefixes.push(join(home, '.claude', 'projects') + sep);
  return prefixes.some((prefix) => path.startsWith(prefix));
}

/** The dsh recording rule (§9): path prefix decides; `--force-record` overrides. */
function shouldRecord(input: Record<string, unknown>, ctx: HookContext): boolean {
  if (ctx.flags.forceRecord) return true;
  const transcript = str(input['transcript_path']);
  if (transcript === undefined) return true;
  return !underClaudeProjects(transcript, ctx.env);
}

/** Structured `in` from a Claude Code `tool_input`. */
function toolInputOf(raw: unknown): LedgerToolInput {
  const out: LedgerToolInput = {};
  if (isRecord(raw)) {
    const command = str(raw['command']);
    if (command !== undefined) out.command = command;
    const path = str(raw['file_path']) ?? str(raw['path']) ?? str(raw['notebook_path']);
    if (path !== undefined) out.path = path;
    const url = str(raw['url']);
    if (url !== undefined) out.url = url;
  }
  return out;
}

/** Kind for a CC-shaped tool name (the dsh map of §4.2.5; `mcp__*` → mcp). */
function kindOf(tool: string): ToolKind {
  return deriveKind('dsh', tool);
}

/** Output text of a `tool_response` (string as-is, else its `stdout`). */
function responseText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) return str(raw['stdout']) ?? '';
  return '';
}

/** Error text of a failure event's `tool_response`/`error`. */
function failureText(input: Record<string, unknown>): string {
  const response = input['tool_response'];
  if (typeof response === 'string') return response;
  if (isRecord(response)) {
    const error = str(response['error']) ?? str(response['message']);
    if (error !== undefined) return error;
  }
  return str(input['error']) ?? '';
}

function baseLine(ev: HookEventModel, ctx: HookContext): { v: 1; t: string; h: HookContext['harness']; sid: string; cwd?: string } {
  const t = ctx.now.toISOString();
  const line: { v: 1; t: string; h: HookContext['harness']; sid: string; cwd?: string } = {
    v: 1,
    t,
    h: ctx.harness,
    sid: ev.sid ?? unknownSid(ctx.cwd, t),
  };
  if (ev.cwd !== undefined) line.cwd = ev.cwd;
  return line;
}

function toolPost(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const tool = str(input['tool_name']) ?? 'unknown';
  const toolIn = toolInputOf(input['tool_input']);
  const text = responseText(input['tool_response']);
  const base = baseLine(ev, ctx);
  return {
    ...base,
    e: 'tool-post',
    id: str(input['tool_use_id']) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    kind: kindOf(tool),
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
}

function toolFail(ev: HookEventModel, ctx: HookContext): ToolFailLine {
  const input = ev.input;
  const tool = str(input['tool_name']) ?? 'unknown';
  const toolIn = toolInputOf(input['tool_input']);
  const error = failureText(input);
  const base = baseLine(ev, ctx);
  const line: ToolFailLine = {
    ...base,
    e: 'tool-fail',
    id: str(input['tool_use_id']) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    in: toolIn,
    error,
    failureType: 'error',
  };
  const exit = EXIT_RE.exec(error);
  if (exit?.[1] !== undefined) {
    line.out = { exit: Number(exit[1]) };
    line.exitSource = 'parsed';
  }
  return line;
}

/** The strict-mode block answer, or `null` when any §9 guard declines. */
function nudgeAnswer(
  receipt: Parameters<typeof decideNudge>[0]['receipt'],
  effectsOnly: boolean,
  loopFlag: boolean,
  sid: string,
  ctx: HookContext,
  turnId?: string,
): { stdout: object; state: NonNullable<HookOutput['state']> } | null {
  if (!ctx.flags.strict || loopFlag) return null;
  const state = ctx.home === '' ? freshHookState() : readHookState(ctx.home, ctx.harness, sid);
  const decision = decideNudge({
    receipt,
    strict: true,
    reasons: ctx.flags.strictReasons,
    max: ctx.flags.strictMax,
    loopFlag,
    state,
    effectsOnly,
    ...(turnId !== undefined ? { turnId } : {}),
  });
  if (!decision.nudge) return null;
  return { stdout: { decision: 'block', reason: decision.message }, state: decision.newState };
}

/** The Claude Code transcript Stop (§9 stop-time flow). */
async function handleStopTranscript(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const input = ev.input;
  const loopFlag = input['stop_hook_active'] === true;
  const result = await buildStopReceipt({
    harness: 'claude-code',
    transcriptPath: str(input['transcript_path']) ?? null,
    sessionId: ev.sid,
    promptId: str(input['prompt_id']),
    lastAssistantMessage: typeof input['last_assistant_message'] === 'string' ? input['last_assistant_message'] : '',
    agentId: str(input['agent_id']),
    cwd: ctx.cwd,
    home: ctx.home,
    userHome: ctx.env['HOME'] ?? '',
    now: ctx.now,
    noCache: ctx.flags.noCache || ctx.env['SHOWRECEIPTS_NO_CACHE'] === '1',
  });
  if (result.subagent) return { stdout: {} };
  if (result.receipt === null) {
    ctx.debug(`claude-code Stop: no transcript located — answered {}`);
    return { stdout: {} };
  }
  const t = ctx.now.toISOString();
  const sid = ev.sid ?? unknownSid(ctx.cwd, t);
  const nudge = nudgeAnswer(result.receipt, result.effectsOnly, loopFlag, sid, ctx);
  if (nudge !== null) return { stdout: nudge.stdout, state: nudge.state };
  return { stdout: stopStdout(result.receipt, result.files, { verbose: ctx.flags.verbose, cwd: ctx.cwd }) };
}

/** The dsh Stop (§9 dsh row): a ledger stop whose `stop.text` is `last_assistant_message`. */
async function handleStopLedger(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const input = ev.input;
  const loopFlag = input['stop_hook_active'] === true;
  const base = baseLine(ev, ctx);
  const stopLine: StopLine = { ...base, e: 'stop', status: 'completed' };
  const text = str(input['last_assistant_message']);
  if (text !== undefined) stopLine.text = text;
  const transcript = str(input['transcript_path']);
  if (transcript !== undefined) stopLine.transcript = transcript;
  if (loopFlag) stopLine.loop = true;
  const result = await runLedgerStop({ ctx, sid: base.sid, pendingLines: [stopLine] });
  const out: HookOutput = {
    stdout: stopStdout(result.receipt, result.files, { verbose: ctx.flags.verbose, cwd: ctx.cwd }),
    ledgerLines: [stopLine],
  };
  const nudge = nudgeAnswer(result.receipt, result.effectsOnly, loopFlag, base.sid, ctx);
  if (nudge !== null) {
    out.stdout = nudge.stdout;
    out.state = nudge.state;
  }
  return out;
}

/**
 * Builds the Claude Code–shaped dialect for `claude-code` or `dsh` (§9).
 * The two differ only in their Stop flow (transcript receipt vs the dsh
 * ledger stop) and in the harness their ledger/state paths carry.
 */
export function makeClaudeCodeDialect(harness: 'claude-code' | 'dsh'): Dialect {
  return {
    harness,
    events: EVENTS,
    parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
      const rec = isRecord(input) ? input : {};
      const model: HookEventModel = {
        event,
        eventClass: EVENTS[event] ?? 'record',
        input: rec,
        sid: str(rec['session_id']) ?? null,
      };
      const cwd = str(rec['cwd']);
      if (cwd !== undefined) model.cwd = cwd;
      void ctx;
      return model;
    },
    async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
      switch (ev.event) {
        case 'SessionStart':
          if (!ctx.flags.strict) return { stdout: {} };
          return {
            stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_START_CONTEXT } },
          };
        case 'PostToolUse':
          if (!shouldRecord(ev.input, ctx)) return { stdout: {} };
          return { stdout: {}, ledgerLines: [toolPost(ev, ctx)] };
        case 'PostToolUseFailure':
          if (!shouldRecord(ev.input, ctx)) return { stdout: {} };
          return { stdout: {}, ledgerLines: [toolFail(ev, ctx)] };
        case 'Stop':
          return harness === 'claude-code' ? handleStopTranscript(ev, ctx) : handleStopLedger(ev, ctx);
        default:
          return { stdout: {} };
      }
    },
  };
}

/** The `hook claude-code` dialect (§9 Claude Code row). */
export const dialect: Dialect = makeClaudeCodeDialect('claude-code');
