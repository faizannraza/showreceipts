/**
 * S09 edge cases over inline text sources: torn/garbage lines, turn boundary
 * rules (file order, tid dedupe, session-end), version tolerance, coverage
 * derivation and the per-harness ledger notes.
 */
import { describe, expect, it } from 'vitest';
import type { Harness, Session, SessionRef } from '../../../../src/model/types.js';
import type { ReadLedgerOptions } from '../../../../src/readers/ledger/reader.js';
import { readLedgerSession } from '../../../../src/readers/ledger/reader.js';

const HOME = '/home/u/.showreceipts';

function refFor(harness: Harness): SessionRef {
  return { harness, sessionId: 'sess-x', path: '/nonexistent/ledger.jsonl', size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };
}

/** Reads inline lines (objects are JSON-encoded; strings are kept raw) with a trailing newline. */
function read(harness: Harness, lines: (object | string)[], opts: Partial<ReadLedgerOptions> = {}, trailingNewline = true): Session {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (trailingNewline ? '\n' : '');
  return readLedgerSession(refFor(harness), { home: HOME, lines: { kind: 'text', text, name: 'inline' }, ...opts });
}

let clock = 0;
function at(offsetSec: number): string {
  return new Date(Date.UTC(2026, 2, 1, 9, 0, offsetSec)).toISOString();
}
function line(h: Harness, e: string, rest: object = {}): object {
  clock += 1;
  return { v: 1, t: at(clock), h, e, sid: 'sess-x', ...rest };
}

describe('bad lines', () => {
  it('a garbage mid-file line and a torn trailing line yield badLines 2 and every other record', () => {
    const s = read(
      'gemini',
      [
        line('gemini', 'session-start'),
        'this is not json',
        line('gemini', 'tool-post', { id: 'a', tool: 'run_shell_command', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'parsed' }),
        line('gemini', 'stop', { status: 'completed', text: 'Listed.' }),
        '{"v":1,"t":"2026-03-01T09:',
      ],
      {},
      false,
    );
    expect(s.diagnostics.badLines).toBe(2);
    expect(s.records).toBe(3);
    expect(s.turns).toHaveLength(1);
    expect(s.toolCalls).toHaveLength(1);
    expect(s.turns[0]?.finalText).toBe('Listed.');
  });

  it('a parseable JSON value that is not a ledger object is a bad line too', () => {
    const s = read('gemini', ['[1,2,3]', '{"foo":1}', line('gemini', 'prompt', { text: 'x' })]);
    expect(s.diagnostics.badLines).toBe(2);
    expect(s.records).toBe(1);
  });

  it('an empty source is an empty session', () => {
    const s = read('gemini', []);
    expect(s.kind).toBe('empty');
    expect(s.records).toBe(0);
    expect(s.turns).toHaveLength(0);
  });
});

describe('version and schema tolerance', () => {
  it('unknown events are counted, never thrown', () => {
    const s = read('gemini', [line('gemini', 'future-event', { payload: { deep: [1] } }), line('gemini', 'prompt', { text: 'hi' })]);
    expect(s.diagnostics.unknownRecordTypes).toEqual({ 'future-event': 1 });
    expect(s.records).toBe(2);
    expect(s.turns).toHaveLength(1);
  });

  it('v != 1 lines are read best-effort with a note', () => {
    const s = read('gemini', [{ ...line('gemini', 'stop', { status: 'completed', text: 'Done.' }), v: 2 }]);
    expect(s.turns[0]?.finalText).toBe('Done.');
    expect(s.diagnostics.notes.some((n) => n.includes('v != 1'))).toBe(true);
  });

  it('unknown keys become deduplicated notes', () => {
    const s = read('gemini', [line('gemini', 'prompt', { text: 'a', zap: 1 }), line('gemini', 'prompt', { text: 'b', zap: 2 })]);
    expect(s.diagnostics.notes.filter((n) => n.includes('"zap"'))).toEqual(['ledger: unknown key "zap" on prompt']);
  });
});

describe('turn boundaries (file order, never t)', () => {
  it('session-end closes a still-open turn as not-done', () => {
    const s = read('copilot', [
      line('copilot', 'prompt', { text: 'go' }),
      line('copilot', 'tool-post', { id: 'a', tool: 'bash', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'parsed' }),
      line('copilot', 'session-end', { reason: 'exit' }),
    ]);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.isDone).toBe(false);
  });

  it('session-end after a completed stop does not un-done the turn', () => {
    const s = read('hermes', [
      line('hermes', 'prompt', { tid: 'a', text: 'go' }),
      line('hermes', 'stop', { tid: 'a', status: 'completed', text: 'Done.' }),
      line('hermes', 'session-end'),
    ]);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.isDone).toBe(true);
  });

  it('two Hermes on_session_end stops with one tid yield one turn boundary', () => {
    const s = read('hermes', [
      line('hermes', 'tool-post', { tid: 'a', id: 'c1', tool: 'terminal', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'harness' }),
      line('hermes', 'stop', { tid: 'a', status: 'completed', text: 'Done.' }),
      line('hermes', 'stop', { tid: 'a', status: 'completed' }),
    ]);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.finalText).toBe('Done.');
  });

  it('a tid change while un-stopped closes the previous run (maximal runs, not stops)', () => {
    const s = read('cursor', [
      line('cursor', 'tool-post', { tid: 'g1', id: 'a', tool: 'Shell', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'harness' }),
      line('cursor', 'tool-post', { tid: 'g2', id: 'b', tool: 'Shell', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'harness' }),
      line('cursor', 'stop', { tid: 'g2', status: 'completed' }),
    ]);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]?.isDone).toBe(false); // no stop line in the g1 run
    expect(s.turns[1]?.isDone).toBe(true);
    expect(s.toolCalls[0]?.turnIndex).toBe(0);
    expect(s.toolCalls[1]?.turnIndex).toBe(1);
  });

  it('the last prompt before the stop wins as userText', () => {
    const s = read('gemini', [line('gemini', 'prompt', { text: 'first' }), line('gemini', 'prompt', { text: 'second' }), line('gemini', 'stop', { status: 'completed', text: 'ok' })]);
    expect(s.turns[0]?.userText).toBe('second');
  });

  it('stop text is preferred over an earlier agent-response (which stays interim)', () => {
    const s = read('gemini', [line('gemini', 'agent-response', { text: 'interim' }), line('gemini', 'stop', { status: 'completed', text: 'final' })]);
    expect(s.turns[0]?.finalText).toBe('final');
    expect(s.turns[0]?.interimFinals).toBe(1);
    expect(s.diagnostics.interimFinals).toBe(1);
  });
});

describe('tool call mapping', () => {
  it('multi-line and pure-insert edits map to patch added/removed lines', () => {
    const s = read('cursor', [
      line('cursor', 'tool-post', {
        tid: 'g1',
        id: 'a',
        tool: 'Edit',
        kind: 'edit',
        cwd: '/home/u/proj',
        in: { path: 'a.ts', edits: [{ old: 'x\ny', new: 'z' }, { old: '', new: 'added line' }], editsTruncated: true },
        out: { text: 'ok', bytes: 2 },
      }),
    ]);
    expect(s.toolCalls[0]?.patch).toEqual({ added: ['z', 'added line'], removed: ['x', 'y'], hunks: 2, truncated: true });
  });

  it('a shell line without cwd inherits the session cwd seen elsewhere in the file', () => {
    const s = read('gemini', [
      line('gemini', 'tool-post', { id: 'a', tool: 'run_shell_command', kind: 'shell', in: { command: 'ls' }, out: { text: '', bytes: 0 } }),
      line('gemini', 'tool-post', { id: 'b', tool: 'read_file', kind: 'read', cwd: '/home/u/elsewhere', in: { path: 'x' }, out: { text: '', bytes: 0 } }),
    ]);
    expect(s.toolCalls[0]?.cwd).toBe('/home/u/elsewhere');
    expect(s.diagnostics.notes.some((n) => n.includes('missing cwd on run_shell_command'))).toBe(true);
  });

  it('a timeout tool-fail marks the call terminated', () => {
    const s = read('hermes', [line('hermes', 'tool-fail', { tid: 'a', id: 'c', tool: 'terminal', cwd: '/home/u/proj', in: { command: 'sleep 99' }, error: 'timed out', failureType: 'timeout', durationMs: 10000 })]);
    expect(s.toolCalls[0]?.terminated).toBe(true);
    expect(s.toolCalls[0]?.isError).toBe(true);
    expect(s.toolCalls[0]?.exitCode).toBeNull();
  });
});

describe('coverage and notes', () => {
  const sessionStartThenTool = (h: Harness, tool: object, startOffsetSec: number): (object | string)[] => {
    const start = { v: 1, t: at(clock + 1), h, e: 'session-start', sid: 'sess-x' };
    const toolLine = { v: 1, t: new Date(Date.parse(at(clock + 1)) + startOffsetSec * 1000).toISOString(), h, e: 'tool-post', sid: 'sess-x', ...tool };
    clock += 2;
    return [start, toolLine];
  };

  it('cursor with only afterFileEdit lines has no generic post-tool evidence', () => {
    const s = read('cursor', [
      ...sessionStartThenTool('cursor', { tid: 'g1', id: 'a', tool: 'afterFileEdit', kind: 'edit', cwd: '/home/u/proj', in: { path: 'a.ts' }, out: { text: '', bytes: 0 } }, 5),
    ]);
    expect(s.ledgerCoverage).toBe('partial');
    expect(s.ledger.incompleteReasons).toContain('no generic post-tool subscription observed');
  });

  it('a session-start more than 60s before the first tool event is partial', () => {
    const s = read('gemini', [
      ...sessionStartThenTool('gemini', { id: 'a', tool: 'run_shell_command', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0, exit: 0 }, exitSource: 'parsed' }, 120),
    ]);
    expect(s.ledgerCoverage).toBe('partial');
    expect(s.ledger.incompleteReasons).toContain('no session-start within 60s of the first tool event');
  });

  it('a session with no tool events cannot attest coverage', () => {
    const s = read('gemini', [line('gemini', 'session-start'), line('gemini', 'stop', { status: 'completed', text: 'chat only' })]);
    expect(s.ledgerCoverage).toBe('partial');
    expect(s.ledger.incompleteReasons).toContain('no tool events recorded');
  });

  it('says "exit codes unknown" only when every shell call is unknown', () => {
    const shell = (id: string, extra: object = {}): object =>
      line('gemini', 'tool-post', { id, tool: 'run_shell_command', kind: 'shell', cwd: '/home/u/proj', in: { command: 'ls' }, out: { text: '', bytes: 0 }, ...extra });
    const allUnknown = read('gemini', [shell('a'), shell('b')]);
    expect(allUnknown.ledgerNote).toBe('exit codes unknown');
    const mixed = read('gemini', [shell('a'), shell('b', { exitSource: 'parsed', out: { text: '', bytes: 0, exit: 0 } })]);
    expect(mixed.ledgerNote).toBeUndefined();
  });

  it('an unparseable copilot transcript head is effects-only with a diagnostic', () => {
    const s = read(
      'copilot',
      [line('copilot', 'prompt', { text: 'go' }), line('copilot', 'stop', { transcript: '/home/u/.copilot/history/x.bin' })],
      { readTranscriptHead: () => 'BINARY GARBAGE  ' },
    );
    expect(s.turns[0]?.finalText).toBeNull();
    expect(s.diagnostics.copilotTranscriptUnparsed).toBe(1);
  });

  it('a whole-document JSON copilot transcript also yields the last assistant text', () => {
    const doc = JSON.stringify({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: 'First answer.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Shipped it.' }] },
      ],
    });
    const s = read('copilot', [line('copilot', 'stop', { transcript: '/home/u/.copilot/history/x.json' })], { readTranscriptHead: () => doc });
    expect(s.turns[0]?.finalText).toBe('Shipped it.');
    expect(s.turns[0]?.finalTextSource).toBe('copilot-transcript');
  });
});

describe('interim finals', () => {
  it('a blank agent-response never counts as an interim final (S09 review)', () => {
    const s = read('gemini', [
      line('gemini', 'session-start'),
      line('gemini', 'prompt', { text: 'go' }),
      line('gemini', 'agent-response', { text: '' }),
      line('gemini', 'agent-response', { text: 'Working on it.' }),
      line('gemini', 'stop', { status: 'completed', text: 'Done.' }),
    ]);
    expect(s.turns[0]?.finalText).toBe('Done.');
    expect(s.turns[0]?.interimFinals).toBe(1); // only the non-empty interim counts
    expect(s.diagnostics.interimFinals).toBe(1);
  });
});
