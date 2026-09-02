/**
 * S07 — subagent merge (§4.2.6/§4.2.7): recursive enumeration (depth cap, no
 * symlinks, journals counted, strays counted), linkage order, parent-turn
 * attribution by stamped promptId, envelope placement + seq renumbering,
 * postFinal, fork-inherited usage rows, and the 2.1.235 / 2.1.241 fixtures.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineSource, Session } from '../../../../src/model/types.js';
import { readClaudeCodeSession } from '../../../../src/readers/claude-code/reader.js';
import { mergeSubagents } from '../../../../src/readers/claude-code/subagents.js';
import { cc, readCC, usage, type CC } from '../../../helpers/cc-lines.js';
import { materialize } from '../../../helpers/fixtures.js';
import { withTempDir } from '../../../helpers/tmp.js';

const T = (s: number): string => new Date(Date.UTC(2026, 5, 1, 10, 0, s)).toISOString();

/** Builds one subagent transcript's lines (every line stamped with the agent id). */
class Sub {
  private readonly lines: string[] = [];
  private n = 0;
  private lastUuid: string | null = null;
  constructor(
    readonly agentId: string,
    readonly sid: string,
  ) {}

  private push(rec: Record<string, unknown>): void {
    const uuid = `${this.agentId}-u${++this.n}`;
    this.lines.push(
      JSON.stringify({
        uuid,
        parentUuid: this.lastUuid,
        isSidechain: true,
        agentId: this.agentId,
        cwd: '/home/u/proj',
        sessionId: this.sid,
        version: '2.1.235',
        ...rec,
      }),
    );
    this.lastUuid = uuid;
  }

  raw(rec: Record<string, unknown>): void {
    this.lines.push(JSON.stringify(rec));
  }

  user(content: unknown, ts: string, over: { promptId?: string; toolUseResult?: unknown } = {}): void {
    const rec: Record<string, unknown> = { type: 'user', message: { role: 'user', content }, timestamp: ts };
    if (over.promptId !== undefined) rec['promptId'] = over.promptId;
    if (over.toolUseResult !== undefined) rec['toolUseResult'] = over.toolUseResult;
    this.push(rec);
  }

  result(toolUseId: string, ts: string, over: { promptId?: string } = {}): void {
    const rec: Record<string, unknown> = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: false }] },
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: false, isImage: false },
      timestamp: ts,
    };
    if (over.promptId !== undefined) rec['promptId'] = over.promptId;
    this.push(rec);
  }

  assistant(over: { id: string; ts: string; stop?: string | null; text?: string; tool?: string; toolUseId?: string; out?: number; promptId?: string }): void {
    const content: unknown[] = [];
    if (over.text !== undefined) content.push({ type: 'text', text: over.text });
    if (over.toolUseId !== undefined) content.push({ type: 'tool_use', id: over.toolUseId, name: over.tool ?? 'Bash', input: { command: 'true' } });
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        id: over.id,
        role: 'assistant',
        model: 'claude-test-5',
        stop_reason: over.stop === undefined ? 'end_turn' : over.stop,
        content,
        usage: usage({ output_tokens: over.out ?? 1 }),
      },
      timestamp: over.ts,
    };
    if (over.promptId !== undefined) rec['promptId'] = over.promptId;
    this.push(rec);
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }

  src(): LineSource {
    return { kind: 'text', text: this.text(), name: `agent-${this.agentId}.jsonl` };
  }
}

/** A main transcript with one async Agent launch (`tu-agent` → agent a1) and two done turns. */
function mainWithAgent(): CC {
  const t = cc();
  t.human('kick off', { promptId: 'p1', ts: T(0) });
  t.assistant({ id: 'msg-m1', stop: 'tool_use', tools: [{ id: 'tu-agent', name: 'Agent' }], usage: usage({ output_tokens: 5 }), ts: T(1) });
  t.toolResult('tu-agent', 'launched', {
    promptId: 'p1',
    ts: T(2),
    result: { isAsync: true, status: 'async_launched', agentId: 'a1', description: 'explore the repo', resolvedModel: 'claude-test-5' },
  });
  t.assistant({ id: 'msg-m2', stop: 'end_turn', text: 'agent launched', usage: usage({ output_tokens: 7 }), ts: T(10) });
  t.human('second task', { promptId: 'p2', ts: T(20) });
  t.assistant({ id: 'msg-m3', stop: 'end_turn', text: 'done two', usage: usage({ output_tokens: 9 }), ts: T(30) });
  return t;
}

function memorySource(entries: Record<string, string>): { kind: 'memory'; files: Map<string, LineSource> } {
  const files = new Map<string, LineSource>();
  for (const [name, text] of Object.entries(entries)) files.set(name, { kind: 'text', text, name });
  return { kind: 'memory', files };
}

function mergedSubCalls(s: Session, agentId: string) {
  return s.toolCalls.filter((c) => c.agentId === agentId);
}

describe('memory-source merge: attribution, envelope, postFinal, info', () => {
  async function merged(): Promise<Session> {
    const t = mainWithAgent();
    const sub = new Sub('a1', t.sid);
    sub.user('do the subtask', T(3), { promptId: 'p1' });
    sub.assistant({ id: 'msg-s1', stop: 'tool_use', toolUseId: 'tu-s1', out: 11, ts: T(4) });
    sub.result('tu-s1', T(5), { promptId: 'p1' });
    sub.assistant({ id: 'msg-s2', stop: 'tool_use', toolUseId: 'tu-s2', out: 13, ts: T(6) });
    sub.result('tu-s2', T(25), { promptId: 'p2' }); // re-stamped to the second parent turn
    sub.assistant({ id: 'msg-s3', stop: 'tool_use', toolUseId: 'tu-s3', out: 17, ts: T(26) });
    sub.result('tu-s3', T(27), { promptId: 'p2' });
    sub.assistant({ id: 'msg-s4', stop: 'tool_use', toolUseId: 'tu-s4', out: 19, ts: T(28), promptId: 'px' }); // unknown parent promptId
    sub.result('tu-s4', T(29), { promptId: 'px' });
    sub.assistant({ id: 'msg-s5', stop: 'end_turn', text: 'sub done', out: 23, ts: T(35) });
    const meta = JSON.stringify({ agentType: 'Explore', toolUseId: 'tu-agent', spawnDepth: 1 });
    const { session } = await readCC(t, { subagents: memorySource({ 'agent-a1.jsonl': sub.text(), 'agent-a1.meta.json': meta }) });
    return session;
  }

  it('attributes tool calls to the parent turns their stamped promptIds name', async () => {
    const s = await merged();
    const byId = new Map(s.toolCalls.map((c) => [c.id, c]));
    expect(byId.get('tu-s1')?.turnIndex).toBe(0);
    expect(byId.get('tu-s2')?.turnIndex).toBe(0); // its tool_use line inherits p1 from the previous line
    expect(byId.get('tu-s3')?.turnIndex).toBe(1); // re-stamped file: second parent turn
    // Unknown promptId → the turn containing the spawning Agent call.
    expect(byId.get('tu-s4')?.turnIndex).toBe(0);
    expect(s.diagnostics.notes.some((n) => n.includes('agentUnlinked'))).toBe(false);
  });

  it('places events by the envelope: never before the Agent call; postFinal past the final; seq unique & increasing', async () => {
    const s = await merged();
    const byId = new Map(s.toolCalls.map((c) => [c.id, c]));
    const agentCall = byId.get('tu-agent');
    const turn0 = s.turns[0];
    const turn1 = s.turns[1];
    expect(agentCall).toBeDefined();
    for (const c of mergedSubCalls(s, 'a1')) expect(c.seq).toBeGreaterThan(agentCall?.seq ?? Infinity);
    // Early events interleave inside turn 0's window; the post-final call is flagged.
    expect(byId.get('tu-s1')?.seq).toBeLessThan(turn0?.finalSeq ?? -1);
    expect(byId.get('tu-s1')?.postFinal).toBeUndefined();
    expect(byId.get('tu-s4')?.seq).toBeGreaterThan(turn0?.finalSeq ?? Infinity);
    expect(byId.get('tu-s4')?.postFinal).toBe(true);
    expect(byId.get('tu-s3')?.seq).toBeLessThan(turn1?.finalSeq ?? -1);
    expect(byId.get('tu-s3')?.postFinal).toBeUndefined();
    // seq strictly increasing and unique across the merged tool calls.
    const seqs = s.toolCalls.map((c) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('carries agentId on every merged tool call and usage row and folds usage into session and turns', async () => {
    const s = await merged();
    expect(mergedSubCalls(s, 'a1')).toHaveLength(4);
    for (const row of s.usageRows.filter((r) => r.messageId.startsWith('msg-s'))) expect(row.agentId).toBe('a1');
    // 21 main output tokens + 83 subagent output tokens, counted once each.
    expect(s.usage.output).toBe(104);
    expect(s.usage.calls).toBe(8);
    expect(s.turns[0]?.apiCalls).toBe(6); // m1, m2 + s1, s2, s4, s5
    expect(s.turns[1]?.apiCalls).toBe(2); // m3 + s3
  });

  it('completes the SubagentInfo from the meta sidecar and the file itself', async () => {
    const s = await merged();
    const info = s.subagents.find((a) => a.agentId === 'a1');
    expect(info?.spawnedBy).toEqual({ tool: 'Agent', toolUseId: 'tu-agent' });
    expect(info?.agentType).toBe('Explore');
    expect(info?.spawnDepth).toBe(1);
    expect(info?.description).toBe('explore the repo'); // the Agent result's description wins
    expect(info?.parentAgentId).toBeNull();
    expect(info?.toolCalls).toBe(4);
    expect(info?.finished).toBe(true); // terminal end_turn
    expect(info?.startedAt).toBe(T(3));
    expect(info?.endedAt).toBe(T(35));
    expect(s.diagnostics.subagentFiles).toEqual({ direct: 1, workflow: 0, unlinked: 0, missing: 0 });
  });
});

describe('fork files (§4.2.7)', () => {
  it('flags inherited usage rows so cost counts a forked message once', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1', ts: T(0) });
    t.assistant({ id: 'msg-m1', stop: 'end_turn', text: 'done', usage: usage({ output_tokens: 7 }), ts: T(1) });
    const sub = new Sub('a2', t.sid);
    sub.raw({
      type: 'fork-context-ref',
      uuid: 'fork-1',
      agentId: 'a2',
      parentSessionId: t.sid,
      parentLastUuid: 'u-0002',
      contextLength: 1234,
      timestamp: T(2),
    });
    sub.assistant({ id: 'msg-m1', stop: 'end_turn', text: 'copy of the parent final', out: 3, ts: T(3), promptId: 'p1' });
    sub.assistant({ id: 'msg-f1', stop: 'end_turn', text: 'fork work', out: 31, ts: T(4) });
    const { session: s } = await readCC(t, { subagents: memorySource({ 'agent-a2.jsonl': sub.text() }) });
    const copy = s.usageRows.find((r) => r.messageId === 'msg-m1' && r.agentId === 'a2');
    expect(copy?.inherited).toBe(true);
    expect(s.usageRows.find((r) => r.messageId === 'msg-f1')?.inherited).toBeUndefined();
    // msg-m1 billed once (7), fork's own message billed (31).
    expect(s.usage.output).toBe(38);
    const info = s.subagents.find((a) => a.agentId === 'a2');
    expect(info?.isFork).toBe(true);
    // An unlinked in-memory chain is an inline merge, never an unlinked diagnostic (§4.2.9).
    expect(info?.spawnedBy.tool).toBe('inline');
    expect(s.diagnostics.subagentFiles.unlinked).toBe(0);
    expect(s.diagnostics.unknownRecordTypes['fork-context-ref']).toBeUndefined();
  });

  it('a later merge never treats previously merged subagent rows as parent rows (§4.2.7)', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1', ts: T(0) });
    t.assistant({ id: 'msg-m1', stop: 'end_turn', text: 'done', usage: usage({ output_tokens: 7 }), ts: T(1) });
    const a1 = new Sub('a1', t.sid);
    a1.user('first', T(2), { promptId: 'p1' });
    a1.assistant({ id: 'msg-a1', stop: 'end_turn', text: 'a done', out: 11, ts: T(3) });
    const { session: s } = await readCC(t, { subagents: memorySource({ 'agent-a1.jsonl': a1.text() }) });
    // Second merge (mirrors reader.ts's inline-then-dir double call): a3
    // shares one id with a1's rows (not main) and one with the main file.
    const a3 = new Sub('a3', t.sid);
    a3.user('second', T(4), { promptId: 'p1' });
    a3.assistant({ id: 'msg-a1', stop: 'end_turn', text: 'same id as a1, not main', out: 13, ts: T(5) });
    a3.assistant({ id: 'msg-m1', stop: 'end_turn', text: 'copy of the main final', out: 3, ts: T(6), promptId: 'p1' });
    await mergeSubagents(s, memorySource({ 'agent-a3.jsonl': a3.text() }));
    const sharedWithSub = s.usageRows.find((r) => r.messageId === 'msg-a1' && r.agentId === 'a3');
    expect(sharedWithSub?.inherited).toBeUndefined(); // subagent-shared id is not "inherited"
    const sharedWithMain = s.usageRows.find((r) => r.messageId === 'msg-m1' && r.agentId === 'a3');
    expect(sharedWithMain?.inherited).toBe(true); // main-file ids still are
  });

  it('notes agentUnlinked when neither a promptId nor a spawning call resolves', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1', ts: T(0) });
    t.assistant({ id: 'msg-m1', stop: 'end_turn', text: 'done', usage: usage({ output_tokens: 7 }), ts: T(1) });
    const sub = new Sub('zz', t.sid);
    sub.user('mystery work', T(2), { promptId: 'nope' });
    sub.assistant({ id: 'msg-z1', stop: 'tool_use', toolUseId: 'tu-z1', out: 2, ts: T(3) });
    sub.result('tu-z1', T(4), { promptId: 'nope' });
    const { session: s } = await readCC(t, { subagents: memorySource({ 'agent-zz.jsonl': sub.text() }) });
    expect(s.toolCalls.find((c) => c.id === 'tu-z1')?.turnIndex).toBe(-1);
    expect(s.diagnostics.notes.some((n) => n.includes('agentUnlinked'))).toBe(true);
  });
});

describe('directory enumeration', () => {
  it('caps depth at 4, never follows symlinks, counts journals and strays', async () => {
    await withTempDir(async (dir) => {
      const subDir = join(dir, 'subagents');
      mkdirSync(join(subDir, 'a', 'b', 'c', 'd'), { recursive: true });
      const t = mainWithAgent(); // spawns agentId a1 — absent on disk → missing
      const ab12 = new Sub('ab12', t.sid);
      ab12.user('task', T(3), { promptId: 'p1' });
      ab12.assistant({ id: 'msg-d1', stop: 'tool_use', toolUseId: 'tu-d1', out: 5, ts: T(4) });
      ab12.result('tu-d1', T(5), { promptId: 'p1' });
      ab12.assistant({ id: 'msg-d2', stop: 'end_turn', text: 'ok', out: 5, ts: T(6) });
      writeFileSync(join(subDir, 'agent-ab12.jsonl'), ab12.text());
      writeFileSync(join(subDir, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tu-agent-none', spawnDepth: 1 }));
      writeFileSync(join(subDir, 'journal.jsonl'), 'not json at all\n');
      writeFileSync(join(subDir, 'notes.txt'), 'stray\n');
      symlinkSync(subDir, join(subDir, 'loop')); // a symlink loop back into the scanned tree
      const cccc = new Sub('cccc', t.sid);
      cccc.user('deep', T(7), { promptId: 'p1' });
      writeFileSync(join(subDir, 'a', 'b', 'c', 'agent-cccc.jsonl'), cccc.text()); // depth 4 → read
      const dddd = new Sub('dddd', t.sid);
      writeFileSync(join(subDir, 'a', 'b', 'c', 'd', 'agent-dddd.jsonl'), dddd.text()); // depth 5 → never read
      const { session: s } = await readCC(t, { subagents: { kind: 'dir', path: subDir } });
      expect(s.diagnostics.journals).toBe(1);
      expect(s.diagnostics.unrecognisedFiles).toBe(2); // notes.txt + the symlink
      expect(s.subagents.some((a) => a.agentId === 'cccc')).toBe(true);
      expect(s.subagents.some((a) => a.agentId === 'dddd')).toBe(false);
      // ab12: no Agent result matches → unlinked (counted); a1's transcript is absent → missing.
      expect(s.diagnostics.subagentFiles.unlinked).toBe(2); // ab12 + cccc
      expect(s.diagnostics.subagentFiles.missing).toBe(1);
      expect(s.toolCalls.find((c) => c.id === 'tu-d1')?.agentId).toBe('ab12');
    });
  });

  it('counts an absent transcript for a launched agent in subagentFiles.missing', async () => {
    await withTempDir(async (dir) => {
      const subDir = join(dir, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const t = mainWithAgent();
      const { session: s } = await readCC(t, { subagents: { kind: 'dir', path: subDir } });
      expect(s.diagnostics.subagentFiles).toEqual({ direct: 0, workflow: 0, unlinked: 0, missing: 1 });
    });
  });

  it.skipIf(process.getuid?.() === 0)('notes an enumerated agent file that cannot be read', async () => {
    await withTempDir(async (dir) => {
      const subDir = join(dir, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const bad = join(subDir, 'agent-beef.jsonl');
      writeFileSync(bad, '{}\n');
      chmodSync(bad, 0o000); // open() fails → the file must not vanish silently
      try {
        const t = mainWithAgent();
        const { session: s } = await readCC(t, { subagents: { kind: 'dir', path: subDir } });
        expect(s.diagnostics.notes.some((n) => n.includes('agent-beef.jsonl') && n.includes('unreadable'))).toBe(true);
      } finally {
        chmodSync(bad, 0o600);
      }
    });
  });
});

describe('nested spawns (§4.2.6)', () => {
  it("a nested agent's merged events all sit after its own spawning call inside the parent agent", async () => {
    const t = mainWithAgent(); // main launches a1 via tu-agent
    const a1 = new Sub('a1', t.sid);
    a1.user('parent task', T(3), { promptId: 'p1' });
    a1.assistant({ id: 'msg-a1', stop: 'tool_use', tool: 'Agent', toolUseId: 'tu-spawn-b', out: 3, ts: T(4) });
    a1.user([{ type: 'tool_result', tool_use_id: 'tu-spawn-b', content: 'launched', is_error: false }], T(5), {
      promptId: 'p1',
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'b1', description: 'nested explore', resolvedModel: 'claude-test-5' },
    });
    a1.assistant({ id: 'msg-a2', stop: 'end_turn', text: 'spawned', out: 5, ts: T(6) });
    const b1 = new Sub('b1', t.sid);
    b1.user('nested task', T(7), { promptId: 'p1' });
    b1.assistant({ id: 'msg-b1', stop: 'tool_use', toolUseId: 'tu-b1', out: 7, ts: T(8) });
    b1.result('tu-b1', T(9), { promptId: 'p1' });
    b1.assistant({ id: 'msg-b2', stop: 'end_turn', text: 'nested done', out: 9, ts: T(10) });
    const { session: s } = await readCC(t, { subagents: memorySource({ 'agent-a1.jsonl': a1.text(), 'agent-b1.jsonl': b1.text() }) });
    expect(s.subagents.find((a) => a.agentId === 'b1')?.parentAgentId).toBe('a1');
    const spawn = s.toolCalls.find((c) => c.id === 'tu-spawn-b');
    expect(spawn).toBeDefined();
    const bCalls = mergedSubCalls(s, 'b1');
    expect(bCalls.length).toBeGreaterThan(0);
    for (const c of bCalls) expect(c.seq).toBeGreaterThan(spawn?.seq ?? Infinity);
    for (const r of s.usageRows.filter((row) => row.agentId === 'b1')) expect(r.seq).toBeGreaterThan(spawn?.seq ?? Infinity);
  });
});

describe('the 2.1.235 fixture (nested agents)', () => {
  it('links ≥ 12 files directly, resolves nested parents, and merges every file', async () => {
    await withTempDir(async (dir) => {
      const m = materialize('claude-code/2.1.235', dir);
      const sid = '57687dd1-8430-4568-a210-4a3d63ce162c';
      const projectDir = join(m.claudeConfigDir ?? '', 'projects', '-home-u-proj');
      const ref = { harness: 'claude-code' as const, sessionId: sid, path: join(projectDir, `${sid}.jsonl`), size: 0, mtimeMs: 0, subagentManifest: [] };
      const base = await readClaudeCodeSession(ref, { home: '/home/u' });
      const { session: s } = await readClaudeCodeSession(ref, { home: '/home/u', subagents: { kind: 'dir', path: join(projectDir, sid, 'subagents') } });
      const files = s.diagnostics.subagentFiles;
      expect(files.direct).toBeGreaterThanOrEqual(12);
      expect(files.direct + files.workflow + files.unlinked).toBe(22); // every fixture file counted exactly once
      // Nested agents carry their parent's id (meta.parentAgentId).
      const nested = s.subagents.filter((a) => a.parentAgentId !== null);
      expect(nested.length).toBeGreaterThanOrEqual(5);
      expect(nested.some((a) => a.parentAgentId === 'a2cb8ba4d2274a973')).toBe(true);
      // Every merged subagent tool call carries its agentId; seq stays ordered and unique.
      const subCalls = s.toolCalls.filter((c) => c.agentId !== null);
      expect(subCalls.length).toBeGreaterThan(0);
      const seqs = s.toolCalls.map((c) => c.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(seqs.length);
      // Subagent usage joined the session totals.
      expect(s.usage.output).toBeGreaterThan(base.session.usage.output);
      expect(s.usageRows.length).toBeGreaterThan(base.session.usageRows.length);
    });
  });
});

describe('the 2.1.241 fixture (workflows)', () => {
  it('merges workflow files with agentType workflow-subagent and spawnedBy Workflow; absent run → missing', async () => {
    await withTempDir(async (dir) => {
      const m = materialize('claude-code/2.1.241', dir);
      const sid = '2c707aeb-ba85-44e3-aec6-b50184966e3d';
      const projectDir = join(m.claudeConfigDir ?? '', 'projects', '-home-u-proj');
      const ref = { harness: 'claude-code' as const, sessionId: sid, path: join(projectDir, `${sid}.jsonl`), size: 0, mtimeMs: 0, subagentManifest: [] };
      const { session: s } = await readClaudeCodeSession(ref, { home: '/home/u', subagents: { kind: 'dir', path: join(projectDir, sid, 'subagents') } });
      const files = s.diagnostics.subagentFiles;
      expect(files.direct).toBe(2);
      expect(files.workflow).toBe(3);
      expect(files.unlinked).toBe(0);
      const wfAgents = s.subagents.filter((a) => a.agentType === 'workflow-subagent');
      expect(wfAgents).toHaveLength(3);
      for (const a of wfAgents) {
        expect(a.spawnedBy.tool).toBe('Workflow');
        expect(a.spawnedBy.runId).toBe('wf_42a7dcd5-323');
      }
      // The run-level info keeps the directory-shaped key (no double wf_ prefix).
      expect(s.subagents.some((a) => a.agentId === 'wf_42a7dcd5-323')).toBe(true);
      expect(s.subagents.some((a) => a.agentId.startsWith('wf_wf_'))).toBe(false);
      // The second Workflow run in the transcript has no files on disk → missing.
      expect(files.missing).toBeGreaterThanOrEqual(1);
    });
  });
});
