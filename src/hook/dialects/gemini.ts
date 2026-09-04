/**
 * Gemini CLI dialect (§9 Gemini row, Appendix C, S29). Events:
 * `SessionStart, AfterTool, AfterAgent, SessionEnd`.
 *
 * Field sources: `sid = session_id`; `t` from the event `timestamp`
 * (normalised to ISO UTC) when parseable; `session-start.transcript =
 * transcript_path`; `AfterTool`
 * exit from `/^Exit Code:\s*(-?\d+)$/m` over a string `llmContent` or from
 * `exit_code`/`exitCode` keys inside a structured one (`exitSource:
 * 'parsed'`); tool ids do not exist, so every tool line carries the S27
 * fallback id; `AfterAgent` becomes `prompt` + `stop{text: prompt_response}`
 * with the `response|final_response|text|message` fallback sniff (logged as
 * a diagnostic). Stdout is **only JSON**: `{}` — or, strict mode
 * (experimental), `{"decision":"deny","reason":"…"}`, never when
 * `stop_hook_active` is set; nothing here ever exits non-zero.
 */
import type { LedgerLine, LedgerLineCommon, LedgerToolInput } from '../../model/types.js';
import { deriveKind } from '../../readers/ledger/kinds.js';
import { isRecord } from '../../util/json.js';
import { parseIso } from '../../util/time.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { runLedgerStop } from '../ledger-stop.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';
import { freshHookState, readHookState, type HookState } from '../state.js';
import { decideNudge } from '../strict.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  SessionStart: 'session',
  AfterTool: 'record',
  AfterAgent: 'stop',
  SessionEnd: 'session',
};

/** The `AfterAgent` fallback keys sniffed when `prompt_response` is missing (§9). */
const RESPONSE_FALLBACK_KEYS = ['response', 'final_response', 'text', 'message'] as const;

const EXIT_LINE = /^Exit Code:\s*(-?\d+)$/m;
const EXIT_KEY_DEPTH = 4;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Appendix C common fields; `t` prefers the event's own `timestamp`, normalised to ISO UTC. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const stamp = str(ev.input['timestamp']);
  const ms = stamp === undefined ? null : parseIso(stamp);
  // Appendix C declares `t` as ISO UTC: a stamp carrying a `±HH:MM` offset
  // must never be stored verbatim, so re-render the parsed epoch.
  const t = ms !== null ? new Date(ms).toISOString() : ctx.now.toISOString();
  const line: LedgerLineCommon = { v: 1, t, h: 'gemini', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
  if (ev.cwd !== undefined) line.cwd = ev.cwd;
  return line;
}

/** Recursive `exit_code`/`exitCode` search over a structured `llmContent` (depth-bounded). */
function findExitKey(value: unknown, depth = 0): number | undefined {
  if (depth > EXIT_KEY_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExitKey(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['exit_code', 'exitCode']) {
    const v = value[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const item of Object.values(value)) {
    const found = findExitKey(item, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Structured `in` from Gemini's `tool_input`; unknown shapes keep `raw`. */
function toolInputOf(raw: unknown): LedgerToolInput {
  const out: LedgerToolInput = {};
  if (isRecord(raw)) {
    const command = str(raw['command']);
    if (command !== undefined) out.command = command;
    const path = str(raw['file_path']) ?? str(raw['absolute_path']) ?? str(raw['path']);
    if (path !== undefined) out.path = path;
    const url = str(raw['url']);
    if (url !== undefined) out.url = url;
  }
  if (Object.keys(out).length === 0 && raw !== undefined && raw !== null) {
    out.raw = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

function afterTool(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const tool = str(input['tool_name']) ?? 'unknown';
  const toolIn = toolInputOf(input['tool_input']);
  const resp = isRecord(input['tool_response']) ? input['tool_response'] : {};
  const llm = resp['llmContent'];
  const text = typeof llm === 'string' ? llm : (str(resp['returnDisplay']) ?? (llm === undefined || llm === null ? '' : JSON.stringify(llm)));
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: fallbackToolId(base.t, tool, toolIn),
    tool,
    kind: deriveKind('gemini', tool),
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
  const exitMatch = typeof llm === 'string' ? EXIT_LINE.exec(llm) : null;
  const exit = exitMatch !== null ? Number(exitMatch[1]) : typeof llm === 'string' ? undefined : findExitKey(llm);
  if (exit !== undefined) {
    line.out.exit = exit;
    line.exitSource = 'parsed';
  }
  const error = resp['error'];
  if (error !== undefined && error !== null && error !== false) line.out.error = true;
  return line;
}

/** `AfterAgent` → `prompt` + `stop` lines, the receipt, and the strict deny decision (§9). */
async function afterAgent(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const input = ev.input;
  const base = common(ev, ctx);
  const lines: LedgerLine[] = [];
  const prompt = str(input['prompt']);
  if (prompt !== undefined) lines.push({ ...base, e: 'prompt', text: prompt });
  let text = str(input['prompt_response']);
  if (text === undefined) {
    for (const key of RESPONSE_FALLBACK_KEYS) {
      text = str(input[key]);
      if (text !== undefined) {
        ctx.debug(`gemini AfterAgent: prompt_response missing — used '${key}'`);
        break;
      }
    }
  }
  const stopLine: StopLine = { ...base, e: 'stop', status: 'completed' };
  if (text !== undefined) stopLine.text = text;
  lines.push(stopLine);
  const result = await runLedgerStop({ ctx, sid: base.sid, pendingLines: lines });
  const out: HookOutput = { stdout: {}, ledgerLines: lines };
  const loopFlag = input['stop_hook_active'] === true;
  if (ctx.flags.strict && !loopFlag) {
    const state: HookState = ctx.home === '' ? freshHookState() : readHookState(ctx.home, 'gemini', base.sid);
    const decision = decideNudge({
      receipt: result.receipt,
      strict: true,
      reasons: ctx.flags.strictReasons,
      max: ctx.flags.strictMax,
      loopFlag,
      state,
      effectsOnly: result.effectsOnly,
    });
    if (decision.nudge) {
      out.stdout = { decision: 'deny', reason: decision.message };
      out.state = decision.newState;
    }
  }
  return out;
}

export const dialect: Dialect = {
  harness: 'gemini',
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
      case 'SessionStart': {
        const line: LedgerLine = { ...common(ev, ctx), e: 'session-start' };
        const transcript = str(ev.input['transcript_path']);
        if (transcript !== undefined) line.transcript = transcript;
        return { stdout: {}, ledgerLines: [line] };
      }
      case 'AfterTool':
        return { stdout: {}, ledgerLines: [afterTool(ev, ctx)] };
      case 'AfterAgent':
        return afterAgent(ev, ctx);
      case 'SessionEnd': {
        const line: LedgerLine = { ...common(ev, ctx), e: 'session-end' };
        const reason = str(ev.input['reason']);
        if (reason !== undefined) line.reason = reason;
        return { stdout: {}, ledgerLines: [line] };
      }
      default:
        return { stdout: {} };
    }
  },
};
