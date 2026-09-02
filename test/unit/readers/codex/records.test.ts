/**
 * S08: guards for the Codex rollout frame and payload shapes (§4.3.1).
 * Guards never throw on `null`, wrong types or missing keys.
 */
import { describe, expect, it } from 'vitest';
import {
  assistantMessageFields,
  callOutputFields,
  classifyCodexLine,
  customToolCallFields,
  eventMessageText,
  functionCallFields,
  localShellCallFields,
  messageRole,
  outputText,
  payloadType,
  sessionMetaFields,
  tokenCountFields,
  turnContextFields,
} from '../../../../src/readers/codex/records.js';

describe('classifyCodexLine', () => {
  it('accepts the four frame types', () => {
    for (const type of ['session_meta', 'turn_context', 'event_msg', 'response_item']) {
      const c = classifyCodexLine({ timestamp: '2026-03-02T10:00:00Z', type, payload: { a: 1 } });
      expect(c.kind).toBe('record');
      if (c.kind === 'record') {
        expect(c.record.type).toBe(type);
        expect(c.record.ts).toBe('2026-03-02T10:00:00Z');
        expect(c.record.payload).toEqual({ a: 1 });
      }
    }
  });

  it('reports unknown frame types with their name', () => {
    const c = classifyCodexLine({ timestamp: 't', type: 'compacted', payload: {} });
    expect(c).toEqual({ kind: 'unknown-type', type: 'compacted', ts: 't' });
  });

  it('reports non-record shapes as not-a-record', () => {
    expect(classifyCodexLine(null).kind).toBe('not-a-record');
    expect(classifyCodexLine('x').kind).toBe('not-a-record');
    expect(classifyCodexLine([1]).kind).toBe('not-a-record');
    expect(classifyCodexLine({ type: 'event_msg' }).kind).toBe('not-a-record'); // no payload
    expect(classifyCodexLine({ type: 42, payload: {} }).kind).toBe('not-a-record');
    expect(classifyCodexLine({ type: 'event_msg', payload: 'str' }).kind).toBe('not-a-record');
  });

  it('tolerates a missing or non-string timestamp', () => {
    const c = classifyCodexLine({ type: 'event_msg', payload: {} });
    expect(c.kind).toBe('record');
    if (c.kind === 'record') expect(c.record.ts).toBeNull();
  });
});

describe('sessionMetaFields', () => {
  it('extracts the retained fields', () => {
    const f = sessionMetaFields({
      id: 'abc',
      timestamp: '2026-02-10T04:56:42.354Z',
      cwd: '/home/u/proj',
      originator: 'codex_vscode',
      cli_version: '0.98.0',
      source: 'vscode',
      base_instructions: { text: 'never' },
    });
    expect(f).toEqual({
      id: 'abc',
      timestamp: '2026-02-10T04:56:42.354Z',
      cwd: '/home/u/proj',
      originator: 'codex_vscode',
      cliVersion: '0.98.0',
      sourceIsObject: false,
      gitBranch: null,
    });
  });

  it('flags an object source (subagent rollout) and reads git_branch', () => {
    const f = sessionMetaFields({ source: { type: 'subagent', parent_id: 'p' }, git_branch: 'main' });
    expect(f.sourceIsObject).toBe(true);
    expect(f.gitBranch).toBe('main');
  });

  it('returns nulls for missing or mistyped keys', () => {
    const f = sessionMetaFields({ cli_version: 98, cwd: null });
    expect(f.cliVersion).toBeNull();
    expect(f.cwd).toBeNull();
    expect(f.id).toBeNull();
  });
});

describe('turnContextFields', () => {
  it('extracts cwd, model and the sandbox policy', () => {
    const f = turnContextFields({
      cwd: '/home/u/proj',
      model: 'gpt-5.2-codex',
      sandbox_policy: { type: 'workspace-write', writable_roots: ['/home/u/proj', 42], network_access: false },
    });
    expect(f.cwd).toBe('/home/u/proj');
    expect(f.model).toBe('gpt-5.2-codex');
    expect(f.sandbox).toEqual({ type: 'workspace-write', writableRoots: ['/home/u/proj'], networkAccess: false });
  });

  it('handles a missing sandbox policy and non-array roots', () => {
    expect(turnContextFields({}).sandbox).toBeNull();
    const f = turnContextFields({ sandbox_policy: { writable_roots: 'nope', network_access: true } });
    expect(f.sandbox).toEqual({ type: 'unknown', writableRoots: [], networkAccess: true });
  });
});

describe('tokenCountFields', () => {
  it('reads totals, last input and the plan-usage percent', () => {
    const f = tokenCountFields({
      info: {
        total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9, reasoning_output_tokens: 2 },
        last_token_usage: { input_tokens: 100 },
      },
      rate_limits: { primary: { used_percent: 1.5 } },
    });
    expect(f.totals).toEqual({ input: 100, cached: 40, output: 9, reasoning: 2 });
    expect(f.lastInput).toBe(100);
    expect(f.ratePct).toBe(1.5);
  });

  it('skips null info but still reads rate limits (0 % accepted)', () => {
    const f = tokenCountFields({ info: null, rate_limits: { primary: { used_percent: 0 } } });
    expect(f.totals).toBeNull();
    expect(f.ratePct).toBe(0);
  });

  it('returns null rate percent when rate_limits is null and defaults missing totals to 0', () => {
    const f = tokenCountFields({ info: { total_token_usage: { input_tokens: 5 } }, rate_limits: null });
    expect(f.ratePct).toBeNull();
    expect(f.totals).toEqual({ input: 5, cached: 0, output: 0, reasoning: 0 });
    expect(f.lastInput).toBeNull();
  });

  it('treats a malformed total_token_usage as absent', () => {
    expect(tokenCountFields({ info: { total_token_usage: 'x' } }).totals).toBeNull();
  });
});

describe('functionCallFields / outputs', () => {
  it('parses string arguments', () => {
    const f = functionCallFields({ name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' });
    expect(f).toEqual({ name: 'exec_command', callId: 'c1', args: { cmd: 'ls' } });
  });

  it('accepts object arguments and defaults malformed ones to {}', () => {
    expect(functionCallFields({ name: 'x', arguments: { a: 1 } })?.args).toEqual({ a: 1 });
    expect(functionCallFields({ name: 'x', arguments: '{oops' })?.args).toEqual({});
    expect(functionCallFields({ arguments: '{}' })).toBeNull(); // no name
  });

  it('joins output text parts and tolerates junk', () => {
    expect(outputText('plain')).toBe('plain');
    expect(outputText([{ type: 'text', text: 'a' }, { text: 'b' }, 42, null])).toBe('ab');
    expect(outputText({ nope: 1 })).toBe('');
    expect(outputText(undefined)).toBe('');
  });

  it('extracts call outputs', () => {
    expect(callOutputFields({ call_id: 'c1', output: 'ok' })).toEqual({ callId: 'c1', output: 'ok' });
    expect(callOutputFields({})).toEqual({ callId: null, output: '' });
  });

  it('extracts custom tool calls', () => {
    const f = customToolCallFields({ name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch', status: 'completed' });
    expect(f).toEqual({ name: 'apply_patch', callId: 'c2', input: '*** Begin Patch', status: 'completed' });
    expect(customToolCallFields({ input: 'x' })).toBeNull();
  });
});

describe('message items', () => {
  it('reads assistant text and phase, and rejects other roles', () => {
    const a = assistantMessageFields({ role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] });
    expect(a).toEqual({ text: 'done', phase: 'final_answer' });
    expect(assistantMessageFields({ role: 'developer', content: [{ text: 'x' }] })).toBeNull();
    expect(assistantMessageFields({ role: 'user' })).toBeNull();
  });

  it('joins multiple output_text blocks and defaults phase to null', () => {
    const a = assistantMessageFields({ role: 'assistant', content: [{ text: 'a' }, { text: 'b' }] });
    expect(a).toEqual({ text: 'ab', phase: null });
  });

  it('exposes payload/event helpers', () => {
    expect(payloadType({ type: 'user_message' })).toBe('user_message');
    expect(payloadType({})).toBeNull();
    expect(eventMessageText({ message: 'hi' })).toBe('hi');
    expect(eventMessageText({ message: 42 })).toBe('');
    expect(messageRole({ role: 'assistant' })).toBe('assistant');
  });

  it('reads the tolerated local_shell_call shape', () => {
    expect(localShellCallFields({ call_id: 'c9', action: { command: ['bash', '-lc', 'ls', 5] } })).toEqual({
      callId: 'c9',
      command: ['bash', '-lc', 'ls'],
    });
    expect(localShellCallFields({ id: 'i1' })).toEqual({ callId: 'i1', command: [] });
  });
});
