/**
 * Hermes dialect (§9 Hermes row, Appendix C, S29). Events:
 * `post_tool_call, post_llm_call, on_session_start, on_session_end,
 * on_session_finalize`.
 *
 * Field sources: `sid = session_id`, `tid = extra.turn_id`,
 * `id = extra.tool_call_id`, `model = extra.model`; kind map
 * `terminal→shell, write_file→write, edit_file→edit`, else `other`.
 * `post_tool_call` → `tool-post` (`out.text = extra.result`, exit 0 when
 * `status === 'success'`) or `tool-fail` (`extra.status !== 'success'`,
 * `failureType` from `extra.error_type`, exit parsed from the result text).
 * `post_llm_call` → `prompt{user_message}` + `stop{status: 'completed',
 * text: assistant_response, model}` and the stop-time receipt.
 * `on_session_end` is a **turn boundary** (§9): it writes a `stop{status}`
 * deduped against an existing stop for the same `turn_id`.
 * `on_session_finalize` → `session-end`. Stdout is always `{}`.
 */
import { readFileSync } from 'node:fs';
import type { LedgerLine, LedgerLineCommon, LedgerToolInput } from '../../model/types.js';
import { deriveKind } from '../../readers/ledger/kinds.js';
import { isRecord, parseJsonSafe } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { runLedgerStop } from '../ledger-stop.js';
import { ledgerPath, unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFailLine = Extract<LedgerLine, { e: 'tool-fail' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  post_tool_call: 'record',
  post_llm_call: 'stop',
  on_session_start: 'session',
  on_session_end: 'stop',
  on_session_finalize: 'session',
};

const EXIT_RE = /(?:exit code|returncode)[:\s]+(-?\d+)/i;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function extraOf(input: Record<string, unknown>): Record<string, unknown> {
  const extra = input['extra'];
  return isRecord(extra) ? extra : {};
}

/** Appendix C common fields for one Hermes event. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const t = ctx.now.toISOString();
  const line: LedgerLineCommon = { v: 1, t, h: 'hermes', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
  if (ev.tid !== undefined) line.tid = ev.tid;
  if (ev.cwd !== undefined) line.cwd = ev.cwd;
  const model = str(extraOf(ev.input)['model']);
  if (model !== undefined) line.model = model;
  return line;
}

/** Structured `in` from Hermes' `tool_input`; unknown shapes keep `raw`. */
function toolInputOf(raw: unknown): LedgerToolInput {
  const out: LedgerToolInput = {};
  if (isRecord(raw)) {
    const command = str(raw['command']);
    if (command !== undefined) out.command = command;
    const path = str(raw['path']) ?? str(raw['file_path']);
    if (path !== undefined) out.path = path;
    const url = str(raw['url']);
    if (url !== undefined) out.url = url;
  }
  if (Object.keys(out).length === 0 && raw !== undefined && raw !== null) {
    out.raw = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

/** `extra.error_type` → Appendix C `failureType`. */
function failureTypeOf(v: string | undefined): NonNullable<ToolFailLine['failureType']> {
  if (v !== undefined && /timeout/i.test(v)) return 'timeout';
  if (v !== undefined && /permission/i.test(v)) return 'permission_denied';
  return 'error';
}

/** `post_tool_call` → `tool-post` (success / unknown status) or `tool-fail` (§9). */
function postToolCall(ev: HookEventModel, ctx: HookContext): LedgerLine {
  const extra = extraOf(ev.input);
  const tool = str(ev.input['tool_name']) ?? 'unknown';
  const toolIn = toolInputOf(ev.input['tool_input']);
  const base = common(ev, ctx);
  const id = str(extra['tool_call_id']) ?? fallbackToolId(base.t, tool, toolIn);
  const status = str(extra['status']);
  const result = str(extra['result']) ?? '';
  const duration = num(extra['duration_ms']);
  if (status !== undefined && status !== 'success') {
    const line: ToolFailLine = {
      ...base,
      e: 'tool-fail',
      id,
      tool,
      in: toolIn,
      error: str(extra['error_message']) ?? result,
      failureType: failureTypeOf(str(extra['error_type'])),
    };
    if (duration !== undefined) line.durationMs = duration;
    const exitMatch = EXIT_RE.exec(result)?.[1];
    if (exitMatch !== undefined) {
      line.out = { exit: Number(exitMatch) };
      line.exitSource = 'parsed';
    }
    return line;
  }
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id,
    tool,
    kind: deriveKind('hermes', tool),
    in: toolIn,
    out: { text: result, bytes: Buffer.byteLength(result, 'utf8') },
  };
  if (status === 'success') {
    line.out.exit = 0;
    line.exitSource = 'parsed';
  }
  if (duration !== undefined) line.out.durationMs = duration;
  return line;
}

/** `post_llm_call` → `prompt` + `stop{completed}` and the stop-time receipt. */
async function postLlmCall(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const extra = extraOf(ev.input);
  const base = common(ev, ctx);
  const lines: LedgerLine[] = [];
  const userMessage = str(extra['user_message']);
  if (userMessage !== undefined) lines.push({ ...base, e: 'prompt', text: userMessage });
  const stopLine: StopLine = { ...base, e: 'stop', status: 'completed' };
  const text = str(extra['assistant_response']);
  if (text !== undefined) stopLine.text = text;
  lines.push(stopLine);
  await runLedgerStop({ ctx, sid: base.sid, pendingLines: lines });
  return { stdout: {}, ledgerLines: lines };
}

/** An existing `stop` for `turnId` in the session's ledger file ⇒ the boundary is deduped. */
function hasStopForTurn(ctx: HookContext, sid: string, turnId: string): boolean {
  if (ctx.home === '') return false;
  let text: string;
  try {
    text = readFileSync(ledgerPath(ctx.home, 'hermes', sid), 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (s === '') continue;
    const json = parseJsonSafe(s);
    if (isRecord(json) && json['e'] === 'stop' && json['tid'] === turnId) return true;
  }
  return false;
}

/** `on_session_end` (per-turn boundary): a `stop{status}`, deduped by `turn_id` (§9). */
async function onSessionEnd(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const extra = extraOf(ev.input);
  const base = common(ev, ctx);
  const turnId = str(extra['turn_id']);
  if (turnId !== undefined && hasStopForTurn(ctx, base.sid, turnId)) {
    return { stdout: {} }; // the same turn's post_llm_call already recorded its stop
  }
  const truthy = (v: unknown): boolean => v === true || (typeof v === 'number' && v > 0);
  const status: StopLine['status'] = truthy(extra['interrupted']) ? 'aborted' : truthy(extra['failed']) ? 'error' : 'completed';
  const stopLine: StopLine = { ...base, e: 'stop', status };
  await runLedgerStop({ ctx, sid: base.sid, pendingLines: [stopLine] });
  return { stdout: {}, ledgerLines: [stopLine] };
}

export const dialect: Dialect = {
  harness: 'hermes',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    const model: HookEventModel = {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(rec['session_id']) ?? null,
    };
    const tid = str(extraOf(rec)['turn_id']);
    if (tid !== undefined) model.tid = tid;
    const cwd = str(rec['cwd']);
    if (cwd !== undefined) model.cwd = cwd;
    void ctx;
    return model;
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    switch (ev.event) {
      case 'post_tool_call':
        return { stdout: {}, ledgerLines: [postToolCall(ev, ctx)] };
      case 'post_llm_call':
        return postLlmCall(ev, ctx);
      case 'on_session_start':
        return { stdout: {}, ledgerLines: [{ ...common(ev, ctx), e: 'session-start' }] };
      case 'on_session_end':
        return onSessionEnd(ev, ctx);
      case 'on_session_finalize':
        return { stdout: {}, ledgerLines: [{ ...common(ev, ctx), e: 'session-end' }] };
      default:
        return { stdout: {} };
    }
  },
};
