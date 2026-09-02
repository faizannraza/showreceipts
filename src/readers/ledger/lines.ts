/**
 * Tolerant guards and classification for the Appendix C hook-captured ledger
 * line union (`LedgerLine`, S02). `classifyLedgerLine` never throws: wrong or
 * missing field types are dropped or defaulted, unknown `e` values and unknown
 * keys are reported to the caller (the reader turns them into diagnostics),
 * and `v ≠ 1` lines are still read best-effort with `badVersion: true`.
 */
import type { LedgerEvent, LedgerLine, LedgerToolInput, LedgerToolOutput, ToolKind } from '../../model/types.js';
import { isRecord } from '../../util/json.js';

/** Every Appendix C event, in the order the appendix lists them. */
export const LEDGER_EVENTS: readonly LedgerEvent[] = [
  'session-start',
  'prompt',
  'tool-post',
  'tool-fail',
  'agent-response',
  'subagent-stop',
  'stop',
  'session-end',
  'gap',
];

const EVENT_SET: ReadonlySet<string> = new Set(LEDGER_EVENTS);
const TOOL_KINDS: ReadonlySet<string> = new Set(['shell', 'edit', 'write', 'read', 'search', 'fetch', 'agent', 'mcp', 'task', 'other']);
const EXIT_SOURCES: ReadonlySet<string> = new Set(['harness', 'parsed', 'unknown']);
const FAILURE_TYPES: ReadonlySet<string> = new Set(['timeout', 'error', 'permission_denied']);

/** Keys every ledger line may carry (Appendix C "Common"). */
const COMMON_KEYS: ReadonlySet<string> = new Set(['v', 't', 'h', 'e', 'sid', 'tid', 'cwd', 'hv', 'model', 'exitSource']);

/** Per-event keys on top of the common ones (Appendix C "Per event"). */
const EVENT_KEYS: Readonly<Record<LedgerEvent, ReadonlySet<string>>> = {
  'session-start': new Set(['transcript', 'source']),
  prompt: new Set(['text']),
  'tool-post': new Set(['id', 'tool', 'kind', 'in', 'out', 'ambiguousRoot']),
  'tool-fail': new Set(['id', 'tool', 'in', 'error', 'failureType', 'durationMs', 'out']),
  'agent-response': new Set(['text']),
  'subagent-stop': new Set(['agent']),
  stop: new Set(['status', 'text', 'transcript', 'loop']),
  'session-end': new Set(['reason']),
  gap: new Set(['reason', 'bytes']),
};

export type SessionStartLine = Extract<LedgerLine, { e: 'session-start' }>;
export type PromptLine = Extract<LedgerLine, { e: 'prompt' }>;
export type ToolPostLine = Extract<LedgerLine, { e: 'tool-post' }>;
export type ToolFailLine = Extract<LedgerLine, { e: 'tool-fail' }>;
export type AgentResponseLine = Extract<LedgerLine, { e: 'agent-response' }>;
export type SubagentStopLine = Extract<LedgerLine, { e: 'subagent-stop' }>;
export type StopLine = Extract<LedgerLine, { e: 'stop' }>;
export type SessionEndLine = Extract<LedgerLine, { e: 'session-end' }>;
export type GapLine = Extract<LedgerLine, { e: 'gap' }>;

/** Narrows a classified line to `session-start`. */
export function isSessionStart(l: LedgerLine): l is SessionStartLine {
  return l.e === 'session-start';
}
/** Narrows a classified line to `prompt`. */
export function isPrompt(l: LedgerLine): l is PromptLine {
  return l.e === 'prompt';
}
/** Narrows a classified line to `tool-post`. */
export function isToolPost(l: LedgerLine): l is ToolPostLine {
  return l.e === 'tool-post';
}
/** Narrows a classified line to `tool-fail`. */
export function isToolFail(l: LedgerLine): l is ToolFailLine {
  return l.e === 'tool-fail';
}
/** Narrows a classified line to `agent-response`. */
export function isAgentResponse(l: LedgerLine): l is AgentResponseLine {
  return l.e === 'agent-response';
}
/** Narrows a classified line to `subagent-stop`. */
export function isSubagentStop(l: LedgerLine): l is SubagentStopLine {
  return l.e === 'subagent-stop';
}
/** Narrows a classified line to `stop`. */
export function isStop(l: LedgerLine): l is StopLine {
  return l.e === 'stop';
}
/** Narrows a classified line to `session-end`. */
export function isSessionEnd(l: LedgerLine): l is SessionEndLine {
  return l.e === 'session-end';
}
/** Narrows a classified line to `gap`. */
export function isGap(l: LedgerLine): l is GapLine {
  return l.e === 'gap';
}

/** True when `e` is one of the nine Appendix C events. */
export function isLedgerEvent(e: string): e is LedgerEvent {
  return EVENT_SET.has(e);
}

/** A parsed JSON value that is not a usable ledger line at all (→ `badLines`). */
export interface ClassifiedBad {
  kind: 'bad';
}
/** A well-formed line whose `e` is not an Appendix C event (→ diagnostic, skipped). */
export interface ClassifiedUnknownEvent {
  kind: 'unknown-event';
  event: string;
}
/** A usable ledger line plus what the strict schema would have rejected. */
export interface ClassifiedLedgerLine {
  kind: 'line';
  line: LedgerLine;
  /** Keys outside the Appendix C schema for this event (→ diagnostic note). */
  unknownKeys: string[];
  /** `v` was present but not `1`; the line is still read best-effort. */
  badVersion: boolean;
}
export type ClassifiedLine = ClassifiedBad | ClassifiedUnknownEvent | ClassifiedLedgerLine;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `in` with every field validated; wrong-typed fields are dropped, never kept raw. */
function cleanInput(v: unknown): LedgerToolInput {
  if (!isRecord(v)) return {};
  const out: LedgerToolInput = {};
  const command = asString(v['command']);
  if (command !== undefined) out.command = command;
  const path = asString(v['path']);
  if (path !== undefined) out.path = path;
  if (Array.isArray(v['paths'])) {
    const paths = v['paths'].filter((p): p is string => typeof p === 'string');
    if (paths.length > 0) out.paths = paths;
  }
  if (Array.isArray(v['edits'])) {
    const edits: { old: string; new: string }[] = [];
    for (const e of v['edits']) {
      if (isRecord(e) && typeof e['old'] === 'string' && typeof e['new'] === 'string') edits.push({ old: e['old'], new: e['new'] });
    }
    if (edits.length > 0) out.edits = edits;
  }
  if (v['editsTruncated'] === true) out.editsTruncated = true;
  const url = asString(v['url']);
  if (url !== undefined) out.url = url;
  const raw = asString(v['raw']);
  if (raw !== undefined) out.raw = raw;
  return out;
}

/** `out` with defaults: a missing or wrong-typed object still yields `{text:'', bytes:0}`. */
function cleanOutput(v: unknown): LedgerToolOutput {
  if (!isRecord(v)) return { text: '', bytes: 0 };
  const text = asString(v['text']) ?? '';
  const out: LedgerToolOutput = { text, bytes: asFiniteNumber(v['bytes']) ?? Buffer.byteLength(text, 'utf8') };
  if (v['exit'] === null) out.exit = null;
  else {
    const exit = asFiniteNumber(v['exit']);
    if (exit !== undefined) out.exit = exit;
  }
  if (typeof v['error'] === 'boolean') out.error = v['error'];
  const durationMs = asFiniteNumber(v['durationMs']);
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (typeof v['truncated'] === 'boolean') out.truncated = v['truncated'];
  return out;
}

/** `subagent-stop.agent` with every field validated. */
function cleanAgent(v: unknown): SubagentStopLine['agent'] {
  if (!isRecord(v)) return {};
  const out: SubagentStopLine['agent'] = {};
  for (const key of ['type', 'status', 'summary', 'transcript', 'text'] as const) {
    const s = asString(v[key]);
    if (s !== undefined) out[key] = s;
  }
  if (Array.isArray(v['modifiedFiles'])) {
    const files = v['modifiedFiles'].filter((p): p is string => typeof p === 'string');
    if (files.length > 0) out.modifiedFiles = files;
  }
  return out;
}

/** Drops `undefined` values so optional keys are truly absent (`exactOptionalPropertyTypes`). */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Classifies one parsed JSON value as an Appendix C ledger line. Never throws:
 * - not an object, or `e`/`t`/`sid` missing or non-string → `{kind:'bad'}`
 *   (the reader counts it in `Diagnostics.badLines`);
 * - an `e` outside the nine events → `{kind:'unknown-event'}` (diagnostic);
 * - otherwise a `LedgerLine` with defaulted fields, the list of keys the
 *   schema does not know, and `badVersion` when `v ≠ 1` (read best-effort).
 *
 * `stop.status` and `gap.reason` keep their raw string spelling even outside
 * the S02 union (Hermes logs `interrupted`/`failed`, §4.4) — the reader
 * treats them as opaque strings.
 */
export function classifyLedgerLine(json: unknown): ClassifiedLine {
  if (!isRecord(json)) return { kind: 'bad' };
  const e = asString(json['e']);
  const t = asString(json['t']);
  const sid = asString(json['sid']);
  if (e === undefined || e === '' || t === undefined || sid === undefined) return { kind: 'bad' };
  if (!isLedgerEvent(e)) return { kind: 'unknown-event', event: e };

  const badVersion = json['v'] !== 1;
  const eventKeys = EVENT_KEYS[e];
  const unknownKeys = Object.keys(json).filter((k) => !COMMON_KEYS.has(k) && !eventKeys.has(k));

  const exitSourceRaw = asString(json['exitSource']);
  const common = {
    v: 1,
    t,
    h: asString(json['h']) ?? '',
    sid,
    tid: asString(json['tid']),
    cwd: asString(json['cwd']),
    hv: asString(json['hv']),
    model: asString(json['model']),
    exitSource: exitSourceRaw !== undefined && EXIT_SOURCES.has(exitSourceRaw) ? exitSourceRaw : undefined,
  };

  let fields: Record<string, unknown>;
  switch (e) {
    case 'session-start':
      fields = { transcript: asString(json['transcript']), source: asString(json['source']) };
      break;
    case 'prompt':
    case 'agent-response':
      fields = { text: asString(json['text']) ?? '' };
      break;
    case 'tool-post': {
      const kindHint = asString(json['kind']);
      fields = {
        id: asString(json['id']) ?? '',
        tool: asString(json['tool']) ?? '',
        kind: (kindHint !== undefined && TOOL_KINDS.has(kindHint) ? kindHint : 'other') as ToolKind,
        in: cleanInput(json['in']),
        out: cleanOutput(json['out']),
        ambiguousRoot: json['ambiguousRoot'] === true ? true : undefined,
      };
      break;
    }
    case 'tool-fail': {
      const failureType = asString(json['failureType']);
      const failOut = isRecord(json['out']) ? cleanOutput(json['out']) : undefined;
      fields = {
        id: asString(json['id']) ?? '',
        tool: asString(json['tool']) ?? '',
        in: cleanInput(json['in']),
        error: asString(json['error']) ?? '',
        failureType: failureType !== undefined && FAILURE_TYPES.has(failureType) ? failureType : undefined,
        durationMs: asFiniteNumber(json['durationMs']),
        out: failOut === undefined ? undefined : { exit: failOut.exit ?? null },
      };
      break;
    }
    case 'subagent-stop':
      fields = { agent: cleanAgent(json['agent']) };
      break;
    case 'stop':
      fields = {
        status: asString(json['status']),
        text: asString(json['text']),
        transcript: asString(json['transcript']),
        loop: typeof json['loop'] === 'boolean' ? json['loop'] : undefined,
      };
      break;
    case 'session-end':
      fields = { reason: asString(json['reason']) };
      break;
    case 'gap':
      fields = { reason: asString(json['reason']) ?? 'unparsable', bytes: asFiniteNumber(json['bytes']) ?? 0 };
      break;
  }

  // The per-event fields were validated above; `compact` only removes the
  // `undefined` optionals, so this single cast is the union constructor.
  const line = compact({ ...common, e, ...fields }) as unknown as LedgerLine;
  return { kind: 'line', line, unknownKeys, badVersion };
}
