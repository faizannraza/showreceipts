/**
 * S09: the hand-written Appendix C basic fixtures, one per hook dialect.
 * Every event of Appendix C appears in at least one of them; expectations pin
 * final text and source, re-derived kinds, exit sources, coverage and notes.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Harness, SessionRef } from '../../../../src/model/types.js';
import { readLedgerSession } from '../../../../src/readers/ledger/reader.js';
import { sha256 } from '../../../../src/util/hash.js';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/ledger/', import.meta.url));
const HOME = '/home/u/.showreceipts';

function refFor(harness: Harness, sessionId: string, file: string): SessionRef {
  return { harness, sessionId, path: join(FIXTURES, file), size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };
}

describe('cursor-basic.jsonl', () => {
  const s = readLedgerSession(refFor('cursor', 'c1a2b3c4-0000-4000-8000-00000000c001', 'cursor-basic.jsonl'), { home: HOME });

  it('builds the session skeleton', () => {
    expect(s.harness).toBe('cursor');
    expect(s.source).toBe('ledger');
    expect(s.sessionId).toBe('c1a2b3c4-0000-4000-8000-00000000c001');
    expect(s.shortId).toBe('c1a2b3c4'); // UUIDv4 → first 8 hex
    expect(s.harnessVersion).toBe('1.7.2');
    expect(s.models).toEqual(['gpt-5']);
    expect(s.primaryModel).toBe('gpt-5');
    expect(s.transcriptPath).toBe('/home/u/.cursor/chats/chat-1.json');
    expect(s.cwd).toBe('/home/u/proj');
    expect(s.kind).toBe('normal');
    expect(s.records).toBe(7);
    expect(s.startedAt).toBe('2026-03-05T10:00:00.000Z');
    expect(s.endedAt).toBe('2026-03-05T10:01:12.000Z');
    expect(s.spansDays).toBe(1);
    expect(s.repoRoot).toBeNull();
    expect(s.cost.usd).toBeNull();
    expect(s.diagnostics.badLines).toBe(0);
  });

  it('groups turns by generation_id and takes the final from the last agent-response (cursor stops carry no text)', () => {
    expect(s.turns).toHaveLength(2);
    const [t0, t1] = s.turns;
    expect(t0?.promptId).toBe('t1');
    expect(t0?.finalText).toBe('Done. Tests pass.');
    expect(t0?.finalTextSource).toBe('transcript');
    expect(t0?.finalSeq).toBe(4);
    expect(t0?.isDone).toBe(true);
    expect(t0?.interimFinals).toBe(0);
    expect(t0?.model).toBe('gpt-5');
    expect(t0?.echoHashes).toEqual([]);
    // stop.status 'aborted' ⇒ not done, not in the rate
    expect(t1?.isDone).toBe(false);
    expect(t1?.interrupted).toBe(true);
    expect(t1?.finalText).toBeNull();
  });

  it('re-derives kinds, takes exit codes from out.exit (source harness) and back-computes startedAt', () => {
    expect(s.toolCalls.map((c) => c.kind)).toEqual(['shell', 'edit', 'mcp']);
    const [shell, edit, mcp] = s.toolCalls;
    expect(shell?.exitCode).toBe(0);
    expect(shell?.exitCodeSource).toBe('harness');
    expect(shell?.durationMs).toBe(1200);
    expect(shell?.startedAt).toBe('2026-03-05T10:00:28.800Z'); // t − durationMs
    expect(shell?.endedAt).toBe('2026-03-05T10:00:30Z');
    expect(shell?.command).toBe('npm test');
    expect(edit?.patch).toEqual({ added: ['const a = 2'], removed: ['const a = 1'], hunks: 1 });
    expect(edit?.filesTouched).toEqual(['src/a.ts']);
    expect(mcp?.turnIndex).toBe(1);
  });

  it('is all-tools with no ledger note', () => {
    expect(s.ledgerCoverage).toBe('all-tools');
    expect(s.ledgerNote).toBeUndefined();
    expect(s.ledger.incomplete).toBe(false);
    expect(s.ledger.incompleteReasons).toEqual([]);
  });
});

describe('gemini-basic.jsonl', () => {
  const s = readLedgerSession(refFor('gemini', 'gem-session-0001', 'gemini-basic.jsonl'), { home: HOME });

  it('prefers the stop text over the interim agent-response and keeps the AfterAgent prompt', () => {
    expect(s.turns).toHaveLength(2);
    const t0 = s.turns[0];
    expect(t0?.userText).toBe('fix the bug');
    expect(t0?.finalText).toBe('Fixed the bug and tests pass.');
    expect(t0?.finalTextSource).toBe('transcript');
    expect(t0?.finalSeq).toBe(8);
    expect(t0?.interimFinals).toBe(1);
    expect(t0?.isDone).toBe(true);
  });

  it('lines after the last stop form an open turn that is never scored', () => {
    const t1 = s.turns[1];
    expect(t1?.seqStart).toBe(10);
    expect(t1?.isDone).toBe(false);
    expect(t1?.finalText).toBeNull();
    expect(t1?.finalTrigger).toBeNull();
  });

  it('re-derives Gemini kinds; unknown tools are other, never a write', () => {
    expect(s.toolCalls.map((c) => c.kind)).toEqual(['shell', 'write', 'other', 'fetch', 'read']);
    expect(s.toolCalls[0]?.exitCodeSource).toBe('parsed');
    expect(s.diagnostics.unknownToolShapes).toEqual({ smart_edit: 1 });
  });

  it('a gap line makes coverage partial and leaves a note', () => {
    expect(s.ledgerCoverage).toBe('partial');
    expect(s.ledger.incomplete).toBe(true);
    expect(s.ledger.incompleteReasons).toContain('gap lines in the ledger');
    expect(s.diagnostics.notes.some((n) => n.includes('gap') && n.includes('oversize'))).toBe(true);
    expect(s.ledgerNote).toBeUndefined(); // no shell-unknown, no integrity note for gemini
  });

  it('non-UUID session ids hash into the short id; gemini has no hv/model', () => {
    expect(s.shortId).toBe(sha256('gemini:gem-session-0001').slice(0, 8));
    expect(s.harnessVersion).toBeNull();
    expect(s.primaryModel).toBe('unknown');
  });
});

describe('copilot-basic.jsonl', () => {
  const ref = refFor('copilot', 'copilot-sess-01', 'copilot-basic.jsonl');
  const HEAD = [
    JSON.stringify({ role: 'user', content: 'add a login page' }),
    JSON.stringify({ role: 'assistant', content: 'Added the login page; build passes.' }),
  ].join('\n');

  it('reads the final from the stop transcript through the injected reader only', () => {
    const seen: { path: string; maxBytes: number }[] = [];
    const s = readLedgerSession(ref, {
      home: HOME,
      readTranscriptHead: (path, maxBytes) => {
        seen.push({ path, maxBytes });
        return HEAD;
      },
    });
    expect(seen).toEqual([{ path: '/home/u/.copilot/history/session-1.jsonl', maxBytes: 64 * 1024 }]);
    expect(s.turns).toHaveLength(1);
    const t0 = s.turns[0];
    expect(t0?.userText).toBe('add a login page');
    expect(t0?.finalText).toBe('Added the login page; build passes.');
    expect(t0?.finalTextSource).toBe('copilot-transcript');
    expect(t0?.isDone).toBe(true); // status absent ⇒ done
    expect(s.diagnostics.copilotTranscriptUnparsed).toBe(0);
    expect(s.ledgerNote).toBe('test-integrity not available (copilot)');
    expect(s.transcriptPath).toBe('/home/u/.copilot/history/session-1.jsonl');
  });

  it('is an effects-only turn without an injected reader', () => {
    const s = readLedgerSession(ref, { home: HOME });
    const t0 = s.turns[0];
    expect(t0?.finalText).toBeNull();
    expect(t0?.finalTextSource).toBeUndefined();
    expect(t0?.isDone).toBe(true);
    expect(s.diagnostics.copilotTranscriptUnparsed).toBe(1);
    expect(s.ledgerNote).toBe('final message not captured by Copilot; test-integrity not available (copilot)');
  });

  it('maps tool-fail to an error call with parsed exit and the failure type', () => {
    const s = readLedgerSession(ref, { home: HOME });
    expect(s.toolCalls.map((c) => c.kind)).toEqual(['shell', 'edit']);
    const fail = s.toolCalls[1];
    expect(fail?.isError).toBe(true);
    expect(fail?.exitCode).toBe(1);
    expect(fail?.exitCodeSource).toBe('parsed');
    expect(fail?.denied).toBe('permission-rule');
    expect(fail?.durationMs).toBe(50);
    expect(fail?.startedAt).toBe('2026-05-12T12:00:39.950Z');
    expect(fail?.resultText).toBe('permission denied');
    expect(s.ledgerCoverage).toBe('all-tools');
  });
});

describe('hermes-basic.jsonl', () => {
  const s = readLedgerSession(refFor('hermes', 'hermes-sess-9', 'hermes-basic.jsonl'), { home: HOME });

  it('dedupes the per-turn on_session_end stop against the same turn_id', () => {
    expect(s.turns).toHaveLength(2);
    const [t0, t1] = s.turns;
    expect(t0?.finalText).toBe('All tests pass.');
    expect(t0?.finalSeq).toBe(5); // the last stop with text, not the trailing on_session_end
    expect(t0?.userText).toBe('run the tests');
    expect(t0?.isDone).toBe(true);
    expect(t0?.model).toBe('hermes-4');
    expect(t1?.isDone).toBe(false);
    expect(t1?.interrupted).toBe(true); // hermes 'interrupted' status ⇒ not done
  });

  it('takes exits from the harness status and re-derives Hermes kinds', () => {
    expect(s.toolCalls.map((c) => c.kind)).toEqual(['shell', 'edit', 'write']);
    for (const c of s.toolCalls) expect(c.exitCodeSource).toBe('harness');
    expect(s.toolCalls[0]?.startedAt).toBe('2026-06-20T13:00:19.200Z');
  });

  it('notes that test integrity is not available and stays all-tools', () => {
    expect(s.ledgerNote).toBe('test-integrity not available (hermes)');
    expect(s.ledgerCoverage).toBe('all-tools');
    expect(s.models).toEqual(['hermes-4']);
  });
});

describe('dsh-basic.jsonl', () => {
  const s = readLedgerSession(refFor('dsh', '01900000-2222-7333-8444-555566667777', 'dsh-basic.jsonl'), { home: HOME });

  it('uses the UUIDv7 tail for the short id and closes one done turn', () => {
    expect(s.shortId).toBe('66667777');
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.isDone).toBe(true);
    expect(s.turns[0]?.finalText).toBe('Fixed the failing test in a.ts.');
    expect(s.harnessVersion).toBe('0.3.1');
  });

  it('harness-truncated output makes coverage partial', () => {
    expect(s.toolCalls[0]?.truncated).toBe('harness');
    expect(s.ledgerCoverage).toBe('partial');
    expect(s.ledger.incompleteReasons).toContain('harness-truncated tool output');
    expect(s.ledgerNote).toBeUndefined(); // shell exits are parsed, not unknown
  });

  it('falls back to the session cwd (with a diagnostic) when a write-kind line has none', () => {
    const write = s.toolCalls[2];
    expect(write?.kind).toBe('write');
    expect(write?.cwd).toBe('/home/u/proj');
    expect(s.diagnostics.notes.some((n) => n.includes('missing cwd on Write'))).toBe(true);
  });

  it('turns subagent-stop into a SubagentInfo plus a synthetic agent tool call for modifiedFiles', () => {
    expect(s.subagents).toHaveLength(1);
    const sub = s.subagents[0];
    expect(sub?.agentType).toBe('reviewer');
    expect(sub?.description).toBe('Reviewed the change');
    expect(sub?.finished).toBe(true);
    const synthetic = s.toolCalls[3];
    expect(synthetic?.tool).toBe('subagent-stop');
    expect(synthetic?.kind).toBe('agent');
    expect(synthetic?.id).toBe('subagent-stop-5');
    expect(synthetic?.agentId).toBe('ledger-agent-5');
    expect(synthetic?.filesTouched).toEqual(['src/c.ts', 'docs/d.md']);
    expect(synthetic?.exitCode).toBeNull();
  });

  it('maps the tool-fail exit and error text', () => {
    const fail = s.toolCalls[1];
    expect(fail?.isError).toBe(true);
    expect(fail?.exitCode).toBe(2);
    expect(fail?.exitCodeSource).toBe('parsed');
    expect(fail?.resultText).toBe('Error: Exit code 2');
  });
});
