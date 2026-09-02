/**
 * Tolerant guards for Codex rollout records (ARCHITECTURE §4.3.1, Appendix B).
 *
 * Every rollout line is `{timestamp, type, payload}` with
 * `type ∈ {session_meta, turn_context, event_msg, response_item}`. The guards
 * here never throw on `null`, wrong types or missing keys: a malformed frame
 * is reported as such, an unknown frame type is handed back for the
 * `unknownRecordTypes` diagnostic, and unknown payload types/names are the
 * reader's `unknownCodexPayloads` diagnostic. Nothing in this module ever
 * returns `base_instructions`, `user_instructions`,
 * `developer_instructions` or `encrypted_content` — those fields are
 * deliberately unreadable through these accessors (§4.3.1 "Never retained").
 */
import { isRecord, parseJsonSafe } from '../../util/json.js';

/** The four rollout frame types, in Appendix B order. */
export const CODEX_RECORD_TYPES = ['session_meta', 'turn_context', 'event_msg', 'response_item'] as const;

/** One of the known rollout frame types. */
export type CodexRecordType = (typeof CODEX_RECORD_TYPES)[number];

/** A structurally valid rollout line. */
export interface CodexRecord {
  /** The line's own UTC timestamp; `null` when absent or not a string. */
  ts: string | null;
  type: CodexRecordType;
  payload: Record<string, unknown>;
}

/** What {@link classifyCodexLine} decided about one parsed JSON line. */
export type ClassifiedCodexLine =
  | { kind: 'record'; record: CodexRecord }
  /** A `{timestamp, type, payload}` frame whose `type` is not a known rollout type. */
  | { kind: 'unknown-type'; type: string; ts: string | null }
  /** Not a `{type, payload}`-shaped object at all. */
  | { kind: 'not-a-record' };

/**
 * Classifies one parsed JSONL value as a Codex rollout record, an unknown
 * frame type, or not a rollout record. Never throws.
 */
export function classifyCodexLine(json: unknown): ClassifiedCodexLine {
  if (!isRecord(json)) return { kind: 'not-a-record' };
  const type = json['type'];
  const ts = typeof json['timestamp'] === 'string' ? json['timestamp'] : null;
  const payload = json['payload'];
  if (typeof type !== 'string' || !isRecord(payload)) return { kind: 'not-a-record' };
  if (!(CODEX_RECORD_TYPES as readonly string[]).includes(type)) return { kind: 'unknown-type', type, ts };
  return { kind: 'record', record: { ts, type: type as CodexRecordType, payload } };
}

/** A string value, or `null` for anything else (missing keys included). */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A finite number value, or `null`. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A finite number value, or `0`. */
function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// session_meta
// ---------------------------------------------------------------------------

/** The `session_meta.payload` fields the reader keeps (§4.3.1). */
export interface SessionMetaFields {
  id: string | null;
  /** The session's own start timestamp (preferred over the line timestamp). */
  timestamp: string | null;
  cwd: string | null;
  originator: string | null;
  cliVersion: string | null;
  /** `source` as an object names a subagent rollout (§4.3.1). */
  sourceIsObject: boolean;
  gitBranch: string | null;
}

/**
 * Extracts the retained `session_meta` fields. `base_instructions` is never
 * read.
 */
export function sessionMetaFields(payload: Record<string, unknown>): SessionMetaFields {
  return {
    id: str(payload['id']),
    timestamp: str(payload['timestamp']),
    cwd: str(payload['cwd']),
    originator: str(payload['originator']),
    cliVersion: str(payload['cli_version']),
    sourceIsObject: isRecord(payload['source']),
    gitBranch: str(payload['git_branch']),
  };
}

// ---------------------------------------------------------------------------
// turn_context
// ---------------------------------------------------------------------------

/** The `turn_context.payload` fields the reader keeps (§4.3.1). */
export interface TurnContextFields {
  cwd: string | null;
  model: string | null;
  gitBranch: string | null;
  sandbox: { type: string; writableRoots: string[]; networkAccess: boolean } | null;
}

/**
 * Extracts `cwd`, `model`, `git_branch` and the sandbox policy from a
 * `turn_context` payload. `user_instructions` and
 * `collaboration_mode.settings.developer_instructions` are never read.
 */
export function turnContextFields(payload: Record<string, unknown>): TurnContextFields {
  let sandbox: TurnContextFields['sandbox'] = null;
  const policy = payload['sandbox_policy'];
  if (isRecord(policy)) {
    const roots = policy['writable_roots'];
    sandbox = {
      type: str(policy['type']) ?? 'unknown',
      writableRoots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [],
      networkAccess: policy['network_access'] === true,
    };
  }
  return {
    cwd: str(payload['cwd']),
    model: str(payload['model']),
    gitBranch: str(payload['git_branch']),
    sandbox,
  };
}

// ---------------------------------------------------------------------------
// event_msg
// ---------------------------------------------------------------------------

/** The inner `type` of an `event_msg` or `response_item` payload; `null` when absent. */
export function payloadType(payload: Record<string, unknown>): string | null {
  return str(payload['type']);
}

/**
 * The text of a `user_message`/`agent_message` event (`''` when missing).
 * `text_elements`, `images` and `local_images` are ignored (§4.3.2).
 */
export function eventMessageText(payload: Record<string, unknown>): string {
  return str(payload['message']) ?? '';
}

/** One `token_count` totals snapshot (all fields default to 0). */
export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

/** The parsed fields of a `token_count` event (§4.3.5). */
export interface TokenCountFields {
  /** `info.total_token_usage`; `null` when `info` is null or unusable. */
  totals: TokenTotals | null;
  /** `info.last_token_usage.input_tokens` — for tier decisions, never summed. */
  lastInput: number | null;
  /** `rate_limits.primary.used_percent` when `rate_limits` is non-null (0 accepted). */
  ratePct: number | null;
}

/** Extracts the totals, `last_token_usage.input_tokens` and the plan-usage percent. */
export function tokenCountFields(payload: Record<string, unknown>): TokenCountFields {
  let totals: TokenTotals | null = null;
  let lastInput: number | null = null;
  const info = payload['info'];
  if (isRecord(info)) {
    const t = info['total_token_usage'];
    if (isRecord(t)) {
      totals = {
        input: numOrZero(t['input_tokens']),
        cached: numOrZero(t['cached_input_tokens']),
        output: numOrZero(t['output_tokens']),
        reasoning: numOrZero(t['reasoning_output_tokens']),
      };
    }
    const last = info['last_token_usage'];
    if (isRecord(last)) lastInput = num(last['input_tokens']);
  }
  let ratePct: number | null = null;
  const limits = payload['rate_limits'];
  if (isRecord(limits)) {
    const primary = limits['primary'];
    if (isRecord(primary)) ratePct = num(primary['used_percent']);
  }
  return { totals, lastInput, ratePct };
}

// ---------------------------------------------------------------------------
// response_item
// ---------------------------------------------------------------------------

/** A `function_call` response item, with its arguments parsed. */
export interface FunctionCallFields {
  name: string;
  callId: string | null;
  /** Parsed `arguments` (JSON string or object); `{}` when unparseable. */
  args: Record<string, unknown>;
}

/** Extracts a `function_call` payload; `null` when it has no string `name`. */
export function functionCallFields(payload: Record<string, unknown>): FunctionCallFields | null {
  const name = str(payload['name']);
  if (name === null) return null;
  let args: Record<string, unknown> = {};
  const raw = payload['arguments'];
  if (typeof raw === 'string') {
    const parsed = parseJsonSafe(raw);
    if (isRecord(parsed)) args = parsed;
  } else if (isRecord(raw)) {
    args = raw;
  }
  return { name, callId: str(payload['call_id']), args };
}

/**
 * Joins a tool output that is either a plain string or a `{type, text}[]`
 * list (§4.3.3, text parts joined); `''` for anything else.
 */
export function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (isRecord(item) && typeof item['text'] === 'string') parts.push(item['text']);
    }
    return parts.join('');
  }
  return '';
}

/** A `function_call_output` / `custom_tool_call_output` payload. */
export interface CallOutputFields {
  callId: string | null;
  output: string;
}

/** Extracts the call id and joined output text of an output item. */
export function callOutputFields(payload: Record<string, unknown>): CallOutputFields {
  return { callId: str(payload['call_id']), output: outputText(payload['output']) };
}

/** A `custom_tool_call` response item (`apply_patch` in the wild). */
export interface CustomToolCallFields {
  name: string;
  callId: string | null;
  /** The freeform tool input (the patch text for `apply_patch`). */
  input: string;
  status: string | null;
}

/** Extracts a `custom_tool_call` payload; `null` when it has no string `name`. */
export function customToolCallFields(payload: Record<string, unknown>): CustomToolCallFields | null {
  const name = str(payload['name']);
  if (name === null) return null;
  return { name, callId: str(payload['call_id']), input: str(payload['input']) ?? '', status: str(payload['status']) };
}

/** The `role` of a `response_item.message`; `null` when absent. */
export function messageRole(payload: Record<string, unknown>): string | null {
  return str(payload['role']);
}

/** An assistant `response_item.message`, with its `phase` when the field exists. */
export interface AssistantMessageFields {
  /** `output_text` parts joined. */
  text: string;
  /** The `phase` field (`'final_answer'` marks the usable fallback final, §4.3.2); `null` when absent. */
  phase: string | null;
}

/**
 * Extracts an assistant message item's text and `phase`. Returns `null` for
 * non-assistant roles (developer/user items are never retained, §4.3.1).
 */
export function assistantMessageFields(payload: Record<string, unknown>): AssistantMessageFields | null {
  if (messageRole(payload) !== 'assistant') return null;
  const content = payload['content'];
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && typeof block['text'] === 'string') parts.push(block['text']);
    }
  }
  return { text: parts.join(''), phase: str(payload['phase']) };
}

/** A tolerated legacy `local_shell_call` item (§4.3.3): `action.command` is the argv. */
export interface LocalShellCallFields {
  callId: string | null;
  /** `action.command` entries that are strings, in order. */
  command: string[];
}

/** Extracts a `local_shell_call` payload (unobserved locally; tolerated). */
export function localShellCallFields(payload: Record<string, unknown>): LocalShellCallFields {
  const action = payload['action'];
  let command: string[] = [];
  if (isRecord(action) && Array.isArray(action['command'])) {
    command = action['command'].filter((c): c is string => typeof c === 'string');
  }
  return { callId: str(payload['call_id']) ?? str(payload['id']), command };
}
