/**
 * S09: tolerant classification of the Appendix C ledger-line union. Nothing
 * here may throw: wrong-typed fields are dropped or defaulted, unknown events
 * and keys are reported, `v ≠ 1` is read best-effort.
 */
import { describe, expect, it } from 'vitest';
import {
  LEDGER_EVENTS,
  classifyLedgerLine,
  isAgentResponse,
  isGap,
  isLedgerEvent,
  isPrompt,
  isSessionEnd,
  isSessionStart,
  isStop,
  isSubagentStop,
  isToolFail,
  isToolPost,
} from '../../../../src/readers/ledger/lines.js';

const T = '2026-03-01T00:00:00Z';
const base = { v: 1, t: T, h: 'cursor', sid: 's-1' };

function lineOf(json: unknown) {
  const c = classifyLedgerLine(json);
  if (c.kind !== 'line') throw new Error(`expected a line, got ${c.kind}`);
  return c;
}

describe('classifyLedgerLine', () => {
  it('classifies every Appendix C event and the guards narrow', () => {
    const samples: Record<string, object> = {
      'session-start': { ...base, e: 'session-start', transcript: '/home/u/t.jsonl', source: 'startup' },
      prompt: { ...base, e: 'prompt', text: 'hi' },
      'tool-post': { ...base, e: 'tool-post', id: 'i1', tool: 'Shell', kind: 'shell', in: { command: 'ls' }, out: { text: 'a', bytes: 1 } },
      'tool-fail': { ...base, e: 'tool-fail', id: 'i2', tool: 'Shell', in: {}, error: 'boom', failureType: 'timeout', durationMs: 9 },
      'agent-response': { ...base, e: 'agent-response', text: 'done' },
      'subagent-stop': { ...base, e: 'subagent-stop', agent: { type: 'x', modifiedFiles: ['a.ts'] } },
      stop: { ...base, e: 'stop', status: 'completed', text: 'fin', loop: false },
      'session-end': { ...base, e: 'session-end', reason: 'exit' },
      gap: { ...base, e: 'gap', reason: 'oversize', bytes: 12 },
    };
    expect(Object.keys(samples).sort()).toEqual([...LEDGER_EVENTS].sort());
    for (const [e, sample] of Object.entries(samples)) {
      const c = lineOf(sample);
      expect(c.line.e).toBe(e);
      expect(c.unknownKeys).toEqual([]);
      expect(c.badVersion).toBe(false);
    }
    expect(isSessionStart(lineOf(samples['session-start']).line)).toBe(true);
    expect(isPrompt(lineOf(samples['prompt']).line)).toBe(true);
    expect(isToolPost(lineOf(samples['tool-post']).line)).toBe(true);
    expect(isToolFail(lineOf(samples['tool-fail']).line)).toBe(true);
    expect(isAgentResponse(lineOf(samples['agent-response']).line)).toBe(true);
    expect(isSubagentStop(lineOf(samples['subagent-stop']).line)).toBe(true);
    expect(isStop(lineOf(samples['stop']).line)).toBe(true);
    expect(isSessionEnd(lineOf(samples['session-end']).line)).toBe(true);
    expect(isGap(lineOf(samples['gap']).line)).toBe(true);
    expect(isLedgerEvent('stop')).toBe(true);
    expect(isLedgerEvent('future-event')).toBe(false);
  });

  it('rejects non-objects and objects without string e/t/sid as bad', () => {
    for (const bad of [null, 42, 'x', [], {}, { e: 'stop' }, { ...base, e: 7 }, { v: 1, e: 'stop', sid: 's' }, { v: 1, e: 'stop', t: T }, { ...base, e: '' }]) {
      expect(classifyLedgerLine(bad)).toEqual({ kind: 'bad' });
    }
  });

  it('reports unknown events instead of throwing', () => {
    expect(classifyLedgerLine({ ...base, e: 'future-event', payload: 1 })).toEqual({ kind: 'unknown-event', event: 'future-event' });
  });

  it('flags v != 1 but still reads the line best-effort', () => {
    const c = lineOf({ ...base, v: 2, e: 'stop', status: 'completed' });
    expect(c.badVersion).toBe(true);
    expect(c.line.e).toBe('stop');
    expect(lineOf({ t: T, h: 'cursor', sid: 's-1', e: 'prompt', text: 'x' }).badVersion).toBe(true); // v missing
  });

  it('reports unknown keys per event', () => {
    const c = lineOf({ ...base, e: 'prompt', text: 'x', zap: 1, extra: true });
    expect(c.unknownKeys.sort()).toEqual(['extra', 'zap']);
    // `transcript` is a session-start/stop key, not a prompt key.
    expect(lineOf({ ...base, e: 'prompt', text: 'x', transcript: '/t' }).unknownKeys).toEqual(['transcript']);
  });

  it('defaults wrong-typed tool-post fields instead of failing', () => {
    const c = lineOf({ ...base, e: 'tool-post', id: 5, tool: null, kind: 'nonsense', in: 'nope', out: 7 });
    const l = c.line;
    if (!isToolPost(l)) throw new Error('not tool-post');
    expect(l.id).toBe('');
    expect(l.tool).toBe('');
    expect(l.kind).toBe('other');
    expect(l.in).toEqual({});
    expect(l.out).toEqual({ text: '', bytes: 0 });
  });

  it('keeps good edits entries, drops malformed ones, and fills bytes from text', () => {
    const c = lineOf({
      ...base,
      e: 'tool-post',
      id: 'i',
      tool: 'Edit',
      kind: 'edit',
      in: { path: 'a.ts', edits: [{ old: 'x', new: 'y' }, { old: 1, new: 'z' }, 'junk'], paths: ['b.ts', 9] },
      out: { text: 'héllo' },
    });
    const l = c.line;
    if (!isToolPost(l)) throw new Error('not tool-post');
    expect(l.in.edits).toEqual([{ old: 'x', new: 'y' }]);
    expect(l.in.paths).toEqual(['b.ts']);
    expect(l.out.bytes).toBe(Buffer.byteLength('héllo', 'utf8'));
  });

  it('preserves explicit null and numeric exit codes', () => {
    const withNull = lineOf({ ...base, e: 'tool-post', id: 'i', tool: 'Shell', kind: 'shell', in: {}, out: { text: '', bytes: 0, exit: null } });
    if (!isToolPost(withNull.line)) throw new Error('not tool-post');
    expect(withNull.line.out.exit).toBeNull();
    const withNum = lineOf({ ...base, e: 'tool-fail', id: 'i', tool: 'Shell', in: {}, error: 'e', out: { exit: -1 } });
    if (!isToolFail(withNum.line)) throw new Error('not tool-fail');
    expect(withNum.line.out?.exit).toBe(-1);
  });

  it('keeps raw Hermes stop statuses (interrupted/failed) as opaque strings', () => {
    const c = lineOf({ ...base, h: 'hermes', e: 'stop', status: 'interrupted' });
    if (!isStop(c.line)) throw new Error('not stop');
    expect(c.line.status as string).toBe('interrupted');
  });

  it('drops an invalid exitSource and an invalid failureType', () => {
    const c = lineOf({ ...base, e: 'tool-fail', id: 'i', tool: 'x', in: {}, error: 'e', failureType: 'weird', exitSource: 'psychic' });
    if (!isToolFail(c.line)) throw new Error('not tool-fail');
    expect(c.line.failureType).toBeUndefined();
    expect(c.line.exitSource).toBeUndefined();
  });
});
