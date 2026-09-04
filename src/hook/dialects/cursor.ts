/**
 * Cursor dialect (§9 Cursor row, Appendix C, S29). Events:
 * `sessionStart, postToolUse, postToolUseFailure, afterFileEdit,
 * afterMCPExecution, afterAgentResponse, subagentStop, stop, sessionEnd`.
 *
 * Field sources: `sid = conversation_id`, `tid = generation_id`,
 * `model = model_id ?? model`, `hv = cursor_version`; `cwd` = event `cwd`
 * else `workspace_roots[0]` (`ambiguousRoot: true` when several roots and a
 * relative path); `tool_output` is a JSON string parsed for `exitCode`
 * (`exitSource: 'harness'`) and `stdout`; `id = tool_use_id`. Stop answers
 * `{}`, or — strict mode, `loop_count === 0` only — the
 * `{"followup_message": "showreceipts: …"}` nudge.
 */
import { isAbsolute } from 'node:path';
import type { LedgerLine, LedgerLineCommon, LedgerToolInput, ToolKind } from '../../model/types.js';
import { deriveKind } from '../../readers/ledger/kinds.js';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { runLedgerStop } from '../ledger-stop.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';
import { freshHookState, readHookState, type HookState } from '../state.js';
import { decideNudge } from '../strict.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFailLine = Extract<LedgerLine, { e: 'tool-fail' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  sessionStart: 'session',
  postToolUse: 'record',
  postToolUseFailure: 'record',
  afterFileEdit: 'record',
  afterMCPExecution: 'record',
  afterAgentResponse: 'record',
  subagentStop: 'record',
  stop: 'stop',
  sessionEnd: 'session',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Cursor hands `tool_input`/`tool_output` as JSON strings; objects are accepted too. */
function jsonRecord(v: unknown): Record<string, unknown> | undefined {
  if (isRecord(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Appendix C common fields for one Cursor event. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const t = ctx.now.toISOString();
  const line: LedgerLineCommon = { v: 1, t, h: 'cursor', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
  if (ev.tid !== undefined) line.tid = ev.tid;
  const hv = str(ev.input['cursor_version']);
  if (hv !== undefined) line.hv = hv;
  const model = str(ev.input['model_id']) ?? str(ev.input['model']);
  if (model !== undefined) line.model = model;
  return line;
}

/** Event `cwd`, else `workspace_roots[0]`; ambiguity needs several roots (§9). */
function resolveRoot(input: Record<string, unknown>): { cwd?: string; several: boolean } {
  const evCwd = str(input['cwd']);
  if (evCwd !== undefined) return { cwd: evCwd, several: false };
  const raw = input['workspace_roots'];
  const roots = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string' && r !== '') : [];
  const first = roots[0];
  if (first === undefined) return { several: false };
  return { cwd: first, several: roots.length > 1 };
}

/** Structured `in` from a Cursor `tool_input` (JSON string or object); unknown shapes keep `raw`. */
function toolInputOf(raw: unknown): LedgerToolInput {
  const rec = jsonRecord(raw);
  const out: LedgerToolInput = {};
  if (rec !== undefined) {
    const command = str(rec['command']);
    if (command !== undefined) out.command = command;
    const path = str(rec['file_path']) ?? str(rec['path']) ?? str(rec['absolute_path']);
    if (path !== undefined) out.path = path;
    const url = str(rec['url']);
    if (url !== undefined) out.url = url;
  }
  if (Object.keys(out).length === 0 && raw !== undefined && raw !== null) {
    out.raw = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

/** `ambiguousRoot` applies only when several roots exist and the tool's path is relative (§9). */
function isAmbiguous(several: boolean, toolIn: LedgerToolInput): boolean {
  return several && toolIn.path !== undefined && !isAbsolute(toolIn.path);
}

/** Cursor `stop.status` → the Appendix C stop enum. */
function stopStatus(v: string | undefined): StopLine['status'] {
  if (v === undefined) return undefined;
  if (v === 'completed') return 'completed';
  if (v === 'aborted' || v === 'cancelled' || v === 'interrupted') return 'aborted';
  if (v === 'error' || v === 'failed') return 'error';
  return undefined;
}

/** Cursor `failure_type` → Appendix C `failureType`. */
function failureTypeOf(v: string | undefined): NonNullable<ToolFailLine['failureType']> {
  if (v !== undefined && /timeout/i.test(v)) return 'timeout';
  if (v !== undefined && /permission/i.test(v)) return 'permission_denied';
  return 'error';
}

function toolPost(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const mcp = ev.event === 'afterMCPExecution';
  const tool = str(input['tool_name']) ?? (mcp ? 'MCP' : 'unknown');
  const kind: ToolKind = mcp ? 'mcp' : deriveKind('cursor', tool);
  const toolIn = toolInputOf(input['tool_input']);
  const outRec = jsonRecord(mcp ? input['result_json'] : input['tool_output']);
  const rawOut = mcp ? input['result_json'] : input['tool_output'];
  const text = str(outRec?.['stdout']) ?? (typeof rawOut === 'string' ? rawOut : '');
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: str(input['tool_use_id']) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    kind,
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
  const exit = num(outRec?.['exitCode']);
  if (exit !== undefined) {
    line.out.exit = exit;
    line.exitSource = 'harness';
  }
  const duration = num(input['duration']);
  if (duration !== undefined) line.out.durationMs = duration;
  const root = resolveRoot(input);
  if (root.cwd !== undefined) line.cwd = root.cwd;
  if (isAmbiguous(root.several, toolIn)) line.ambiguousRoot = true;
  return line;
}

function toolFail(ev: HookEventModel, ctx: HookContext): ToolFailLine {
  const input = ev.input;
  const tool = str(input['tool_name']) ?? 'unknown';
  const toolIn = toolInputOf(input['tool_input']);
  const error = str(input['error_message']) ?? '';
  const base = common(ev, ctx);
  const line: ToolFailLine = {
    ...base,
    e: 'tool-fail',
    id: str(input['tool_use_id']) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    in: toolIn,
    error,
    failureType: failureTypeOf(str(input['failure_type'])),
  };
  const duration = num(input['duration']);
  if (duration !== undefined) line.durationMs = duration;
  const harnessExit = num(jsonRecord(input['tool_output'])?.['exitCode']);
  const errorExit = /exit code (-?\d+)/i.exec(error);
  const parsedExit = harnessExit ?? (errorExit === null ? undefined : Number(errorExit[1]));
  if (parsedExit !== undefined) {
    line.out = { exit: parsedExit };
    line.exitSource = harnessExit !== undefined ? 'harness' : 'parsed';
  }
  const root = resolveRoot(input);
  if (root.cwd !== undefined) line.cwd = root.cwd;
  return line;
}

function afterFileEdit(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const toolIn: LedgerToolInput = {};
  const path = str(input['file_path']);
  if (path !== undefined) toolIn.path = path;
  const rawEdits = input['edits'];
  if (Array.isArray(rawEdits)) {
    const edits: { old: string; new: string }[] = [];
    for (const entry of rawEdits) {
      if (!isRecord(entry)) continue;
      const oldText = str(entry['old']) ?? str(entry['old_string']) ?? str(entry['oldString']) ?? '';
      const newText = str(entry['new']) ?? str(entry['new_string']) ?? str(entry['newString']) ?? '';
      edits.push({ old: oldText, new: newText });
    }
    if (edits.length > 0) toolIn.edits = edits;
  }
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: fallbackToolId(base.t, 'afterFileEdit', toolIn),
    tool: 'afterFileEdit',
    kind: 'edit',
    in: toolIn,
    out: { text: '', bytes: 0 },
  };
  const root = resolveRoot(input);
  if (root.cwd !== undefined) line.cwd = root.cwd;
  if (isAmbiguous(root.several, toolIn)) line.ambiguousRoot = true;
  return line;
}

/** The stop answer: `{}`, or the strict `followup_message` nudge when `loop_count === 0` (§9). */
async function handleStop(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const base = common(ev, ctx);
  const loopCount = num(ev.input['loop_count']) ?? 0;
  const stopLine: StopLine = { ...base, e: 'stop' };
  const status = stopStatus(str(ev.input['status']));
  if (status !== undefined) stopLine.status = status;
  if (loopCount > 0) stopLine.loop = true;
  const result = await runLedgerStop({ ctx, sid: base.sid, tid: ev.tid, pendingLines: [stopLine] });
  const out: HookOutput = { stdout: {}, ledgerLines: [stopLine] };
  if (ctx.flags.strict && loopCount === 0) {
    const state: HookState = ctx.home === '' ? freshHookState() : readHookState(ctx.home, 'cursor', base.sid);
    const decision = decideNudge({
      receipt: result.receipt,
      strict: true,
      reasons: ctx.flags.strictReasons,
      max: ctx.flags.strictMax,
      loopFlag: loopCount > 0,
      state,
      effectsOnly: result.effectsOnly,
      ...(ev.tid !== undefined ? { turnId: ev.tid } : {}),
    });
    if (decision.nudge) {
      out.stdout = { followup_message: decision.message };
      out.state = decision.newState;
    }
  }
  return out;
}

export const dialect: Dialect = {
  harness: 'cursor',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    const model: HookEventModel = {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(rec['conversation_id']) ?? str(rec['session_id']) ?? null,
    };
    const tid = str(rec['generation_id']);
    if (tid !== undefined) model.tid = tid;
    const cwd = str(rec['cwd']);
    if (cwd !== undefined) model.cwd = cwd;
    void ctx;
    return model;
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    switch (ev.event) {
      case 'sessionStart': {
        const line: LedgerLine = { ...common(ev, ctx), e: 'session-start' };
        const transcript = str(ev.input['transcript_path']);
        if (transcript !== undefined) line.transcript = transcript;
        const source = str(ev.input['composer_mode']);
        if (source !== undefined) line.source = source;
        return { stdout: {}, ledgerLines: [line] };
      }
      case 'postToolUse':
      case 'afterMCPExecution':
        return { stdout: {}, ledgerLines: [toolPost(ev, ctx)] };
      case 'postToolUseFailure':
        return { stdout: {}, ledgerLines: [toolFail(ev, ctx)] };
      case 'afterFileEdit':
        return { stdout: {}, ledgerLines: [afterFileEdit(ev, ctx)] };
      case 'afterAgentResponse': {
        const line: LedgerLine = { ...common(ev, ctx), e: 'agent-response', text: str(ev.input['text']) ?? '' };
        return { stdout: {}, ledgerLines: [line] };
      }
      case 'subagentStop': {
        const input = ev.input;
        const agent: Extract<LedgerLine, { e: 'subagent-stop' }>['agent'] = {};
        const type = str(input['subagent_type']);
        if (type !== undefined) agent.type = type;
        const status = str(input['status']);
        if (status !== undefined) agent.status = status;
        const summary = str(input['summary']);
        if (summary !== undefined) agent.summary = summary;
        const modified = input['modified_files'];
        if (Array.isArray(modified)) {
          const files = modified.filter((f): f is string => typeof f === 'string' && f !== '');
          if (files.length > 0) agent.modifiedFiles = files;
        }
        const transcript = str(input['agent_transcript_path']);
        if (transcript !== undefined) agent.transcript = transcript;
        const line: LedgerLine = { ...common(ev, ctx), e: 'subagent-stop', agent };
        return { stdout: {}, ledgerLines: [line] };
      }
      case 'stop':
        return handleStop(ev, ctx);
      case 'sessionEnd': {
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
