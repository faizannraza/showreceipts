/**
 * Copilot CLI dialect (§9 Copilot row, Appendix C, S29). Events:
 * `sessionStart, postToolUse, postToolUseFailure, agentStop, sessionEnd` —
 * camel (`toolName`, `toolResult.textResultForLlm`) and Pascal/snake
 * (`tool_name`, `tool_result.text_result_for_llm`) key forms both accepted.
 *
 * Field sources: `sid = sessionId`; `t` from the ms `timestamp` → ISO; kind
 * map `bash|powershell→shell, create→write, edit→edit, view→read,
 * glob|grep→search, web_fetch→fetch, task→agent`, else `other`; exit from
 * `/exit code (\d+)/i` in `textResultForLlm` (`exitSource: 'parsed'`); no
 * tool ids, so every tool line carries the S27 fallback id; `prompt` from
 * `sessionStart.initialPrompt`; `agentStop.transcriptPath` →
 * `stop.transcript` (the final text is recovered best-effort by the S09
 * reader inside the stop flow; an unrecognisable transcript bumps
 * `copilotTranscriptUnparsed`). Stdout is always `{}` — Copilot is never
 * strict in v1.
 */
import type { LedgerLine, LedgerLineCommon, LedgerToolInput } from '../../model/types.js';
import { deriveKind } from '../../readers/ledger/kinds.js';
import { isRecord } from '../../util/json.js';
import type { Dialect, EventClass, HookContext, HookEventModel, HookOutput } from '../dialect.js';
import { runLedgerStop } from '../ledger-stop.js';
import { unknownSid } from '../paths.js';
import { fallbackToolId } from '../record.js';

type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFailLine = Extract<LedgerLine, { e: 'tool-fail' }>;
type StopLine = Extract<LedgerLine, { e: 'stop' }>;

const EVENTS: Readonly<Record<string, EventClass>> = {
  sessionStart: 'session',
  postToolUse: 'record',
  postToolUseFailure: 'record',
  agentStop: 'stop',
  sessionEnd: 'session',
};

const EXIT_RE = /exit code (\d+)/i;
/** Sanity bounds for the ms `timestamp` (1971 … ≈ 2100). */
const MIN_TS_MS = 31_536_000_000;
const MAX_TS_MS = 4_102_444_800_000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The first defined value among the camel and snake spellings of one field. */
function pick(rec: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    const v = rec[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Appendix C common fields; `t` from the ms `timestamp` when sane. */
function common(ev: HookEventModel, ctx: HookContext): LedgerLineCommon {
  const raw = pick(ev.input, 'timestamp');
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  const t = ms !== undefined && ms > MIN_TS_MS && ms < MAX_TS_MS ? new Date(ms).toISOString() : ctx.now.toISOString();
  const line: LedgerLineCommon = { v: 1, t, h: 'copilot', sid: ev.sid ?? unknownSid(ctx.cwd, t) };
  if (ev.cwd !== undefined) line.cwd = ev.cwd;
  return line;
}

/** Structured `in` from `toolArgs`/`tool_args`; unknown shapes keep `raw`. */
function toolInputOf(raw: unknown): LedgerToolInput {
  const out: LedgerToolInput = {};
  if (isRecord(raw)) {
    const command = str(raw['command']);
    if (command !== undefined) out.command = command;
    const path = str(raw['path']) ?? str(raw['file_path']) ?? str(raw['filePath']);
    if (path !== undefined) out.path = path;
    const url = str(raw['url']);
    if (url !== undefined) out.url = url;
  }
  if (Object.keys(out).length === 0 && raw !== undefined && raw !== null) {
    out.raw = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

/** `cwd` for lines whose kind requires one: event `cwd`, else the hook process cwd. */
function requiredCwd(line: ToolPostLine | ToolFailLine, kind: string, ctx: HookContext): void {
  if (line.cwd === undefined && (kind === 'shell' || kind === 'edit' || kind === 'write')) line.cwd = ctx.cwd;
}

function toolPost(ev: HookEventModel, ctx: HookContext): ToolPostLine {
  const input = ev.input;
  const tool = str(pick(input, 'toolName', 'tool_name')) ?? 'unknown';
  const kind = deriveKind('copilot', tool);
  const toolIn = toolInputOf(pick(input, 'toolArgs', 'tool_args'));
  const result = pick(input, 'toolResult', 'tool_result');
  const resultRec = isRecord(result) ? result : {};
  const text = str(pick(resultRec, 'textResultForLlm', 'text_result_for_llm')) ?? '';
  const base = common(ev, ctx);
  const line: ToolPostLine = {
    ...base,
    e: 'tool-post',
    id: fallbackToolId(base.t, tool, toolIn),
    tool,
    kind,
    in: toolIn,
    out: { text, bytes: Buffer.byteLength(text, 'utf8') },
  };
  const exitMatch = EXIT_RE.exec(text)?.[1];
  if (exitMatch !== undefined) {
    line.out.exit = Number(exitMatch);
    line.exitSource = 'parsed';
  }
  const resultType = str(pick(resultRec, 'resultType', 'result_type'));
  if (resultType !== undefined && /fail|error|denied/i.test(resultType)) line.out.error = true;
  requiredCwd(line, kind, ctx);
  return line;
}

function toolFail(ev: HookEventModel, ctx: HookContext): ToolFailLine {
  const input = ev.input;
  const tool = str(pick(input, 'toolName', 'tool_name')) ?? 'unknown';
  const toolIn = toolInputOf(pick(input, 'toolArgs', 'tool_args'));
  const rawError = pick(input, 'error');
  const error = str(rawError) ?? (isRecord(rawError) ? (str(rawError['message']) ?? JSON.stringify(rawError)) : '');
  const base = common(ev, ctx);
  const line: ToolFailLine = {
    ...base,
    e: 'tool-fail',
    id: fallbackToolId(base.t, tool, toolIn),
    tool,
    in: toolIn,
    error,
    failureType: 'error',
  };
  const exitMatch = EXIT_RE.exec(error)?.[1];
  if (exitMatch !== undefined) {
    line.out = { exit: Number(exitMatch) };
    line.exitSource = 'parsed';
  }
  requiredCwd(line, deriveKind('copilot', tool), ctx);
  return line;
}

/** `agentStop.stopReason` → the Appendix C stop enum (absent means done). */
function stopStatus(reason: string | undefined): StopLine['status'] {
  if (reason === undefined) return undefined;
  if (/abort|cancel|interrupt/i.test(reason)) return 'aborted';
  if (/error|fail/i.test(reason)) return 'error';
  return undefined;
}

/** `agentStop`: the stop line (transcript, no text) and the receipt; never strict. */
async function agentStop(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
  const base = common(ev, ctx);
  const stopLine: StopLine = { ...base, e: 'stop' };
  const transcript = str(pick(ev.input, 'transcriptPath', 'transcript_path'));
  if (transcript !== undefined) stopLine.transcript = transcript;
  const status = stopStatus(str(pick(ev.input, 'stopReason', 'stop_reason')));
  if (status !== undefined) stopLine.status = status;
  const result = await runLedgerStop({ ctx, sid: base.sid, pendingLines: [stopLine] });
  const out: HookOutput = { stdout: {}, ledgerLines: [stopLine] };
  // The counter reflects only this stop: a transcript was named but no final text came back.
  if (transcript !== undefined && result.receipt.finalText === '') {
    out.counters = { copilotTranscriptUnparsed: 1 };
  }
  return out;
}

export const dialect: Dialect = {
  harness: 'copilot',
  events: EVENTS,
  parse(event: string, input: unknown, ctx: HookContext): HookEventModel {
    const rec = isRecord(input) ? input : {};
    const model: HookEventModel = {
      event,
      eventClass: EVENTS[event] ?? 'record',
      input: rec,
      sid: str(pick(rec, 'sessionId', 'session_id')) ?? null,
    };
    const cwd = str(pick(rec, 'cwd'));
    if (cwd !== undefined) model.cwd = cwd;
    void ctx;
    return model;
  },
  async handle(ev: HookEventModel, ctx: HookContext): Promise<HookOutput> {
    switch (ev.event) {
      case 'sessionStart': {
        const lines: LedgerLine[] = [];
        const start: LedgerLine = { ...common(ev, ctx), e: 'session-start' };
        const source = str(pick(ev.input, 'source'));
        if (source !== undefined) start.source = source;
        lines.push(start);
        const prompt = str(pick(ev.input, 'initialPrompt', 'initial_prompt'));
        if (prompt !== undefined) lines.push({ ...common(ev, ctx), e: 'prompt', text: prompt });
        return { stdout: {}, ledgerLines: lines };
      }
      case 'postToolUse':
        return { stdout: {}, ledgerLines: [toolPost(ev, ctx)] };
      case 'postToolUseFailure':
        return { stdout: {}, ledgerLines: [toolFail(ev, ctx)] };
      case 'agentStop':
        return agentStop(ev, ctx);
      case 'sessionEnd': {
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
