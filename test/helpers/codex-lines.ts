/**
 * Tiny DSL for building Codex rollout lines in tests (PLAN S08). Every
 * builder returns one JSONL line; `rollout()` wraps a list of lines as a
 * `LineSource` and `codexRef()` fabricates the `SessionRef` the reader
 * expects. Timestamps are deterministic: pass one explicitly or use
 * `tsAt(offsetMs)` from the fixed base.
 */
import type { LineSource, SessionRef } from '../../src/model/types.js';

/** The fixed base timestamp every offset counts from. */
export const T0 = '2026-03-02T10:00:00.000Z';
const T0_MS = Date.parse(T0);

/** A UUIDv7 whose last 8 hex are `9e0f1a2b` (shortId of a v7 takes the tail). */
export const TEST_SESSION_ID = '019d1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b';

/** ISO timestamp `offsetMs` after {@link T0}. */
export function tsAt(offsetMs: number): string {
  return new Date(T0_MS + offsetMs).toISOString();
}

/** One raw rollout line: `{timestamp, type, payload}`. */
export function line(type: string, payload: unknown, ts: string = T0): string {
  return JSON.stringify({ timestamp: ts, type, payload });
}

/** A `session_meta` line; `overrides` merge into the default payload. */
export function sessionMeta(overrides: Record<string, unknown> = {}, ts: string = T0): string {
  return line(
    'session_meta',
    {
      id: TEST_SESSION_ID,
      timestamp: ts,
      cwd: '/home/u/proj',
      originator: 'codex_cli_rs',
      cli_version: '0.98.0',
      source: 'cli',
      model_provider: 'openai',
      base_instructions: { text: 'NEVER-RETAINED-BASE-INSTRUCTIONS' },
      ...overrides,
    },
    ts,
  );
}

/** A `turn_context` line; `overrides` merge into the default payload. */
export function turnContext(overrides: Record<string, unknown> = {}, ts: string = T0): string {
  return line(
    'turn_context',
    {
      cwd: '/home/u/proj',
      approval_policy: 'on-request',
      sandbox_policy: {
        type: 'workspace-write',
        writable_roots: ['/home/u/proj'],
        network_access: false,
      },
      model: 'gpt-5.2-codex',
      effort: 'medium',
      summary: 'auto',
      user_instructions: 'NEVER-RETAINED-USER-INSTRUCTIONS',
      collaboration_mode: { mode: 'default', settings: { model: 'gpt-5.2-codex', developer_instructions: 'NEVER-RETAINED-DEV' } },
      ...overrides,
    },
    ts,
  );
}

/** An `event_msg.user_message` line. */
export function userMessage(message: string, ts: string = T0): string {
  return line('event_msg', { type: 'user_message', message, images: [], local_images: [], text_elements: [] }, ts);
}

/** An `event_msg.agent_message` line. */
export function agentMessage(message: string, ts: string = T0): string {
  return line('event_msg', { type: 'agent_message', message }, ts);
}

/** An `event_msg.agent_reasoning` line (must never be stored). */
export function agentReasoning(text = 'NEVER-RETAINED-REASONING', ts: string = T0): string {
  return line('event_msg', { type: 'agent_reasoning', text }, ts);
}

/** An assistant `response_item.message`; pass `phase` for the final-answer fallback shape. */
export function assistantItem(text: string, opts: { phase?: string } = {}, ts: string = T0): string {
  const payload: Record<string, unknown> = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  if (opts.phase !== undefined) payload['phase'] = opts.phase;
  return line('response_item', payload, ts);
}

/** A developer `response_item.message` (must never be stored). */
export function developerItem(text = 'NEVER-RETAINED-DEVELOPER', ts: string = T0): string {
  return line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }, ts);
}

/** A user `response_item.message` (ignored; the `event_msg` carries the prompt). */
export function userItem(text = 'user-item-text', ts: string = T0): string {
  return line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ts);
}

/** A `response_item.reasoning` line with encrypted content (never retained). */
export function reasoningItem(ts: string = T0): string {
  return line('response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: 'NEVER-RETAINED-ENC' }, ts);
}

/** Totals for {@link tokenCount}. */
export interface TotalsSpec {
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
}

/**
 * An `event_msg.token_count` line. `totals: null` ⇒ `info: null`.
 * `ratePct` set ⇒ `rate_limits.primary.used_percent`; omitted ⇒
 * `rate_limits: null`.
 */
export function tokenCount(totals: TotalsSpec | null, opts: { lastInput?: number; ratePct?: number } = {}, ts: string = T0): string {
  let info: unknown = null;
  if (totals !== null) {
    const t = {
      input_tokens: totals.input,
      cached_input_tokens: totals.cached,
      output_tokens: totals.output,
      reasoning_output_tokens: totals.reasoning ?? 0,
      total_tokens: totals.input + totals.output,
    };
    info = {
      total_token_usage: t,
      last_token_usage: { ...t, input_tokens: opts.lastInput ?? totals.input },
      model_context_window: 258400,
    };
  }
  const rate_limits =
    opts.ratePct === undefined
      ? null
      : { primary: { used_percent: opts.ratePct, window_minutes: 300, resets_at: 1772366400 }, secondary: null };
  return line('event_msg', { type: 'token_count', info, rate_limits }, ts);
}

/** A `response_item.function_call` line (arguments serialised to JSON). */
export function fnCall(name: string, args: Record<string, unknown>, callId: string, ts: string = T0): string {
  return line('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId }, ts);
}

/** A `response_item.function_call_output` line. */
export function fnOut(callId: string, output: string, ts: string = T0): string {
  return line('response_item', { type: 'function_call_output', call_id: callId, output }, ts);
}

/** A `response_item.custom_tool_call` line (an `apply_patch` unless overridden). */
export function customPatchCall(callId: string, patch: string, name = 'apply_patch', ts: string = T0): string {
  return line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input: patch }, ts);
}

/** A `response_item.custom_tool_call_output` line. */
export function customPatchOut(callId: string, output: string, ts: string = T0): string {
  return line('response_item', { type: 'custom_tool_call_output', call_id: callId, output }, ts);
}

/** Spec for {@link unifiedOutput}. */
export interface UnifiedSpec {
  chunk?: string;
  /** Seconds, formatted as printed (`0.0520`). */
  wall?: string;
  /** `Process exited with code N` (mutually exclusive with `session`). */
  exit?: number;
  /** `Process running with session ID N`. */
  session?: number;
  originalTokens?: number;
  body?: string;
}

/** A unified-exec output string (§4.3.3 parser 1). */
export function unifiedOutput(spec: UnifiedSpec): string {
  const parts = [`Chunk ID: ${spec.chunk ?? 'abc123'}`, `Wall time: ${spec.wall ?? '0.0500'} seconds`];
  parts.push(spec.session !== undefined ? `Process running with session ID ${spec.session}` : `Process exited with code ${spec.exit ?? 0}`);
  if (spec.originalTokens !== undefined) parts.push(`Original token count: ${spec.originalTokens}`);
  parts.push('Output:');
  return `${parts.join('\n')}\n${spec.body ?? ''}`;
}

/** A JSON-string output (`shell_command` dialects, §4.3.3 parser 2). */
export function jsonOutput(body: string, exit: number, durationSeconds = 0.2): string {
  return JSON.stringify({ output: body, metadata: { exit_code: exit, duration_seconds: durationSeconds } });
}

/** Wraps rollout lines as an in-memory `LineSource`. */
export function rollout(lines: readonly string[], name = 'rollout-test.jsonl'): LineSource {
  return { kind: 'text', text: lines.join('\n') + '\n', name };
}

/** A `SessionRef` for an in-memory rollout. */
export function codexRef(sessionId: string = TEST_SESSION_ID, over: Partial<SessionRef> = {}): SessionRef {
  return {
    harness: 'codex',
    sessionId,
    path: `/home/u/.codex/sessions/2026/03/02/rollout-2026-03-02T10-00-00-${sessionId}.jsonl`,
    size: 0,
    mtimeMs: 0,
    subagentManifest: [],
    ...over,
  };
}

/** The home directory tests hand to the reader. */
export const TEST_HOME = '/home/u';
