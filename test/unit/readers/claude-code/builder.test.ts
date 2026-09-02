/**
 * S06 — the resumable `SessionBuilder` and the `reader.ts` front door.
 * `serialize()`/`resume()` round-trip on the 2.1.215 fixture at three split
 * points; subagent-mode invariants (no finals, agentId on every call and
 * usage row); the 2.1.214 acceptance pins (turns, orphans, duplicate uuids,
 * compactions, prRefs); zero unresolved assistant lines on the synthetic
 * suite; no file bodies in builder state.
 */
import { describe, expect, it } from 'vitest';
import type { LineSource, Session, SessionRef } from '../../../../src/model/types.js';
import { SessionBuilder } from '../../../../src/readers/claude-code/builder.js';
import { readClaudeCodeSession } from '../../../../src/readers/claude-code/reader.js';
import { readFixtureLines } from '../../../helpers/fixtures.js';
import { buildSession, cc, parseCC, readCC, usage } from '../../../helpers/cc-lines.js';

/** Feeds one already-parsed record straight into a builder (bypassing the sniff/count-only skip). */
function feedRecord(b: SessionBuilder, json: Record<string, unknown>, sniffedType: string | null = null): void {
  b.feed({ seq: 0, bytes: 0, byteOffset: 0, sniffedType, json });
}

function textSource(lines: string[]): LineSource {
  return { kind: 'text', text: lines.join('\n') + (lines.length > 0 ? '\n' : ''), name: 'main.jsonl' };
}

const REF: SessionRef = { harness: 'claude-code', sessionId: 'f150468e-ae67-4d6b-a36d-688ae5025a53', path: '', size: 0, mtimeMs: 0, subagentManifest: [] };

async function readSource(src: LineSource, startState?: Parameters<typeof readClaudeCodeSession>[1]['startState']): Promise<Awaited<ReturnType<typeof readClaudeCodeSession>>> {
  return readClaudeCodeSession(REF, { lines: src, home: '/home/u', ...(startState !== undefined ? { startState } : {}) });
}

describe('serialize()/resume() round-trip (2.1.215)', () => {
  const lines = readFixtureLines('claude-code/2.1.215');

  it('parses the whole fixture into at least one turn', async () => {
    const full = await readSource(textSource(lines));
    expect(full.session.turns.length).toBeGreaterThanOrEqual(1);
    expect(full.session.kind).toBe('normal');
  });

  for (const k of [50, 500, 1500]) {
    it(`splitting at line ${k} yields a session deep-equal to the single-pass parse`, async () => {
      const single = (await readSource(textSource(lines))).session;
      // Feed lines 1..k, then resume from the on-disk tail and feed k+1..n.
      const first = await readSource(textSource(lines.slice(0, k)));
      const resumed = await readSource(textSource(lines), {
        state: first.builderState,
        bytesParsed: first.bytesParsed,
        tailHash: first.tailHash,
      });
      expect(resumed.session).toEqual(single);
    });
  }

  it('a mismatched tailHash forces a clean full parse (no resume)', async () => {
    const single = (await readSource(textSource(lines))).session;
    const first = await readSource(textSource(lines.slice(0, 500)));
    const resumed = await readSource(textSource(lines), {
      state: first.builderState,
      bytesParsed: first.bytesParsed,
      tailHash: 'deadbeef'.repeat(8), // wrong hash
    });
    expect(resumed.session).toEqual(single);
  });
});

describe('subagent mode', () => {
  it('never computes finals and carries agentId on every tool call and usage row', async () => {
    const t = cc();
    // A subagent-style transcript: isSidechain:true, agentId on every line,
    // a placeholder-then-complete assistant pair.
    t.raw({
      type: 'user',
      uuid: 'sa-u1',
      parentUuid: null,
      isSidechain: true,
      agentId: 'agentX',
      promptId: 'parent-p1',
      message: { role: 'user', content: 'do the subtask' },
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.235',
    });
    t.raw({
      type: 'assistant',
      uuid: 'sa-a1',
      parentUuid: 'sa-u1',
      isSidechain: true,
      agentId: 'agentX',
      message: { id: 'msg-sa', model: 'claude-fable-5', role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', id: 'sa-tu1', name: 'Bash', input: { command: 'pytest' } }], usage: usage({ output_tokens: 5 }) },
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.235',
    });
    t.raw({
      type: 'assistant',
      uuid: 'sa-a2',
      parentUuid: 'sa-a1',
      isSidechain: true,
      agentId: 'agentX',
      message: { id: 'msg-sa', model: 'claude-fable-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'subtask done' }], usage: usage({ output_tokens: 40 }) },
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.235',
    });
    t.raw({
      type: 'user',
      uuid: 'sa-u2',
      parentUuid: 'sa-a2',
      isSidechain: true,
      agentId: 'agentX',
      promptId: 'parent-p1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sa-tu1', content: 'ok' }] },
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: false, isImage: false },
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.235',
    });
    const session = await buildSession(t.src(), t.ref(), { mode: 'subagent', home: '/home/u' });
    // Finals are never computed.
    for (const turn of session.turns) expect(turn.finalText).toBeNull();
    // agentId on the tool call and the (deduped) usage row.
    const call = session.toolCalls.find((c) => c.id === 'sa-tu1');
    expect(call?.agentId).toBe('agentX');
    const row = session.usageRows.find((r) => r.messageId === 'msg-sa');
    expect(row?.agentId).toBe('agentX');
    // Placeholder-then-complete: the completed line supplies output.
    expect(row?.attempts[0]?.out).toBe(40);
  });
});

describe('the 2.1.214 fixture (acceptance pins)', () => {
  it('reads with turns ≥ 1, 0 orphans, duplicate uuids, 3 compactions, ≥ 5 prRefs, ledger untouched', async () => {
    const lines = readFixtureLines('claude-code/2.1.214');
    const src = textSource(lines);
    const ref: SessionRef = { harness: 'claude-code', sessionId: '21cf6a82-ebf2-4214-8dce-1869efe9e406', path: '', size: 0, mtimeMs: 0, subagentManifest: [] };
    const { session } = await readClaudeCodeSession(ref, { lines: src, home: '/home/u' });
    expect(session.turns.length).toBeGreaterThanOrEqual(1);
    expect(session.diagnostics.orphanAssistantLines).toBe(0);
    expect(session.diagnostics.duplicateUuids).toBeGreaterThan(0);
    expect(session.compactions).toHaveLength(3);
    expect(session.prRefs.length).toBeGreaterThanOrEqual(5);
    // pr-links never touch the git ledger.
    expect(session.ledger.git).toHaveLength(0);
    expect(session.shortId).toBe('21cf6a82');
  });
});

describe('builder state hygiene', () => {
  it('keeps patch lines but never full file bodies (originalFile / content / base64)', async () => {
    const t = cc();
    t.human('write and read', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-w', name: 'Write', input: { file_path: '/home/u/proj/a.py' } }], stop: 'tool_use', usage: null });
    // The unchanged lines carry a marker that must NOT survive (only the changed
    // line becomes a patch line); the file body itself is discarded.
    t.toolResult('tu-w', 'ok', {
      promptId: 'p1',
      result: { type: 'update', filePath: '/home/u/proj/a.py', originalFile: 'UNCHANGED_BODY\nold value\nUNCHANGED_TAIL\n', content: 'UNCHANGED_BODY\nnew value\nUNCHANGED_TAIL\n', structuredPatch: [] },
    });
    t.assistant({ tools: [{ id: 'tu-r', name: 'Read', input: { file_path: '/home/u/proj/a.py' } }], stop: 'tool_use', usage: usage() });
    t.toolResult('tu-r', 'ok', { promptId: 'p1', result: { type: 'text', file: { filePath: '/home/u/proj/a.py', content: 'SECRET_FILE_CONTENT' } } });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const { session, builderState } = await readCC(t);
    // The full body (unchanged lines) and the Read content are never retained.
    expect(builderState).not.toContain('UNCHANGED_BODY');
    expect(builderState).not.toContain('SECRET_FILE_CONTENT');
    expect(JSON.stringify(session)).not.toContain('UNCHANGED_BODY');
    expect(JSON.stringify(session)).not.toContain('SECRET_FILE_CONTENT');
    // …but the changed lines (the diff) are captured as the patch.
    const write = session.toolCalls.find((c) => c.id === 'tu-w');
    expect(write?.patch).toEqual({ added: ['new value'], removed: ['old value'], hunks: 1 });
    // echoHashes stays empty here (the pipeline fills it, S18).
    for (const turn of session.turns) expect(turn.echoHashes).toEqual([]);
  });

  it('resultText stays ≤ 1 MiB + marker', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-big', name: 'Bash', input: { command: 'yes' } }], stop: 'tool_use', usage: usage() });
    const big = 'x'.repeat((1 << 20) + 5000);
    t.toolResult('tu-big', big, { promptId: 'p1', result: { stdout: big, stderr: '', interrupted: false, isImage: false } });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const s = await parseCC(t);
    const call = s.toolCalls.find((c) => c.id === 'tu-big');
    expect(call?.resultText.length).toBeLessThanOrEqual((1 << 20) + 1);
    expect(call?.truncated).toBe('showreceipts');
    expect(call?.resultBytes).toBe(Buffer.byteLength(big, 'utf8'));
  });
});

describe('zero unresolved assistant lines on the synthetic suite', () => {
  it('every hand-built transcript resolves all assistant lines', async () => {
    // A representative synthetic transcript exercising system/skill/notification
    // continuations must still leave no orphan assistant lines.
    const t = cc();
    const h = t.human('start', { promptId: 'p1' });
    t.turnDuration(10, { parent: h });
    t.assistant({ parent: t.last(), tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use', usage: usage() });
    t.toolResult('tu1', 'listing', { promptId: 'p1', parent: t.last() });
    t.assistant({ parent: t.last(), stop: 'end_turn', text: 'done', usage: usage() });
    const s = await parseCC(t);
    expect(s.diagnostics.orphanAssistantLines).toBe(0);
  });
});

describe('other records (§4.2.8)', () => {
  it('edited_text_file attachment → editedFiles (the reader parses only that attachment type)', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.raw({ type: 'attachment', attachment: { type: 'edited_text_file', filename: '/home/u/proj/x.py', snippet: 'x' }, uuid: 'att-1', sessionId: t.sid, timestamp: t.nextTs() });
    t.assistant({ stop: 'end_turn', text: 'ok', usage: usage() });
    const s = await parseCC(t);
    expect(s.editedFiles).toEqual([{ seq: expect.any(Number), path: '/home/u/proj/x.py' }]);
  });

  it('an unknown attachment type fed directly to the builder is counted', () => {
    // The reader sniff never parses an unknown attachment type (§4.2.1), but a
    // builder fed one (e.g. a subagent file) must count it, never throw.
    const b = new SessionBuilder({ harness: 'claude-code', sessionId: 's', path: '', size: 0, mtimeMs: 0, subagentManifest: [] }, { mode: 'main', home: '/home/u' });
    feedRecord(b, { type: 'attachment', attachment: { type: 'brand_new_attachment' }, uuid: 'att-2', timestamp: '2026-02-10T10:00:00Z' });
    expect(b.finish().diagnostics.unknownAttachmentTypes['brand_new_attachment']).toBe(1);
  });

  it('an unknown top-level record type is counted, never fatal', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.raw({ type: 'brand-new-record', sessionId: t.sid, timestamp: t.nextTs(), uuid: 'x1' });
    t.assistant({ stop: 'end_turn', text: 'ok', usage: usage() });
    const s = await parseCC(t);
    expect(s.diagnostics.unknownRecordTypes['brand-new-record']).toBe(1);
    expect(s.turns).toHaveLength(1);
  });

  it('title comes from the first ai-title', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.raw({ type: 'ai-title', aiTitle: 'My Session', sessionId: t.sid });
    t.raw({ type: 'ai-title', aiTitle: 'Later Title', sessionId: t.sid });
    t.assistant({ stop: 'end_turn', text: 'ok', usage: usage() });
    const s = await parseCC(t);
    expect(s.title).toBe('My Session');
  });
});
