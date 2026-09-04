/**
 * OpenClaw dialect (§9 OpenClaw row — roadmap, S29): a ledger dialect only.
 * It accepts the payloads the S30 plugin entry forwards — `after_tool_call`,
 * `agent_end`, `session_start`, `session_end` — and maps them onto
 * Appendix C lines. Stdout is always `{}`; no receipt files are written for
 * roadmap harnesses. The plugin entry template is a setup artifact owned by
 * S30 (`setup/writers/openclaw.ts`); nothing here spawns anything.
 */
import type { LedgerLine, LedgerLineCommon, LedgerToolInput, ToolKind } from '../../model/types.js';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  after_tool_call: 'record',
  agent_end: 'stop',
  session_start: 'session',
  session_end: 'session',
};

/** Kind hints for common OpenClaw tool names; unknown names map to `other` — never a write. */
const KINDS: Readonly<Record<string, ToolKind>> = {
  bash: 'shell',
  shell: 'shell',
  exec: 'shell',
  write: 'write',
  write_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  read: 'read',
  read_file: 'read',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The first defined value among the spellings OpenClaw plugins use. */
function pick(rec: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    const v = rec[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Appendix C common fields for one OpenClaw event. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const t = ctx.now.toISOString();
  const line: LedgerLineCommon = { v: 1, t, h: 'openclaw', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
  const model = str(pick(ev.input, 'model'));
  if (model !== undefined) line.model = model;
  return line;
}

/** `after_tool_call` → `tool-post` (§9 OpenClaw row). */
function afterToolCall(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const tool = str(pick(input, 'tool_name', 'tool', 'toolName')) ?? 'unknown';
  const kind = KINDS[tool] ?? 'other';
  const rawIn = pick(input, 'tool_input', 'input', 'args');
  const toolIn: LedgerToolInput = {};
  if (isRecord(rawIn)) {
    const command = str(rawIn['command']);
    if (command !== undefined) toolIn.command = command;
    const path = str(rawIn['path']) ?? str(rawIn['file_path']);
    if (path !== undefined) toolIn.path = path;
    const url = str(rawIn['url']);
    if (url !== undefined) toolIn.url = url;
  }
  if (Object.keys(toolIn).length === 0 && rawIn !== undefined && rawIn !== null) {
    toolIn.raw = typeof rawIn === 'string' ? rawIn : JSON.stringify(rawIn);
  }
  const rawOut = pick(input, 'result', 'output');
  const text = str(rawOut) ?? (rawOut === undefined || rawOut === null ? '' : JSON.stringify(rawOut));
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: str(pick(input, 'tool_call_id', 'call_id', 'id')) ?? fallbackToolId(base.t, tool, toolIn),
    tool,
    kind,
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
  const err = pick(input, 'error');
  if (err !== undefined && err !== null && err !== false) line.out.error = true;
  line.cwd = str(pick(input, 'cwd')) ?? ctx.cwd;
  return line;
}

export const dialect: Dialect = {
  harness: 'openclaw',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    void ctx;
    return {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(pick(rec, 'session_id', 'sessionID', 'sessionId')) ?? null,
    };
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    switch (ev.event) {
      case 'after_tool_call':
        return { stdout: {}, ledgerLines: [afterToolCall(ev, ctx)] };
      case 'agent_end': {
        const line: StopLine = { ...common(ev, ctx), e: 'stop', status: 'completed' };
        const text = str(pick(ev.input, 'message', 'output', 'text', 'final_text'));
        if (text !== undefined) line.text = text;
        return { stdout: {}, ledgerLines: [line] };
      }
      case 'session_start':
        return { stdout: {}, ledgerLines: [{ ...common(ev, ctx), e: 'session-start' }] };
      case 'session_end': {
        const line: LedgerLine = { ...common(ev, ctx), e: 'session-end' };
        const reason = str(pick(ev.input, 'reason'));
        if (reason !== undefined) line.reason = reason;
        return { stdout: {}, ledgerLines: [line] };
      }
      default:
        return { stdout: {} };
    }
  },
};
