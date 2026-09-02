/**
 * S06 — legacy shapes (§4.2.9). The synthetic `claude-code/legacy` fixture:
 * Task→Agent, MultiEdit→Edit, `type:'summary'` ignored, usage without
 * `cache_creation` → the `wU` path, in-file `isSidechain:true` chains handed
 * to `mergeSubagents`, a human prompt without a promptId. Every case counted
 * in `legacyShapes`, none a doctor-class problem.
 */
import { describe, expect, it } from 'vitest';
import { legacyToolName, SidechainCollector } from '../../../../src/readers/claude-code/legacy.js';
import { readFixtureLines } from '../../../helpers/fixtures.js';
import { cc, parseCC, usage } from '../../../helpers/cc-lines.js';

describe('name remapping', () => {
  it('Task → Agent, MultiEdit → Edit with the legacy shape key', () => {
    expect(legacyToolName('Task')).toEqual({ tool: 'Agent', legacyShape: 'Task' });
    expect(legacyToolName('MultiEdit')).toEqual({ tool: 'Edit', legacyShape: 'MultiEdit' });
    expect(legacyToolName('Bash')).toEqual({ tool: 'Bash', legacyShape: null });
  });
});

describe('SidechainCollector', () => {
  it('groups isSidechain lines by their parentUuid:null root and round-trips its state', () => {
    const c = new SidechainCollector();
    const root = { uuid: 'r1', parentUuid: null, agentId: 'ag1', isSidechain: true };
    const child = { uuid: 'c1', parentUuid: 'r1', agentId: 'ag1', isSidechain: true };
    c.feed(root);
    c.feed(child);
    expect(c.chainCount()).toBe(1);
    // Serialise → resume → same chain count and a usable source.
    const revived = new SidechainCollector(c.state());
    expect(revived.chainCount()).toBe(1);
    const source = revived.source();
    expect(source?.kind).toBe('memory');
    if (source?.kind === 'memory') expect([...source.files.keys()]).toEqual(['agent-ag1.jsonl']);
  });

  it('falls back to the root uuid for agentId when absent', () => {
    const c = new SidechainCollector();
    c.feed({ uuid: 'r2', parentUuid: null, isSidechain: true });
    const source = c.source();
    if (source?.kind === 'memory') expect([...source.files.keys()]).toEqual(['agent-r2.jsonl']);
  });
});

describe('the synthetic legacy fixture', () => {
  it('parses with legacyShapes counts > 0 and zero doctor-class problems', async () => {
    const lines = readFixtureLines('claude-code/legacy');
    const t = cc('9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d');
    for (const line of lines) t.raw(line);
    const s = await parseCC(t);
    // At least one legacy shape was recognised.
    const shapes = s.diagnostics.legacyShapes;
    expect(Object.keys(shapes).length).toBeGreaterThan(0);
    // Task and MultiEdit remaps, and the summary line.
    expect(shapes['Task']).toBeGreaterThanOrEqual(1);
    expect(shapes['MultiEdit']).toBeGreaterThanOrEqual(1);
    expect(shapes['summary']).toBeGreaterThanOrEqual(1);
    // The in-file sidechain chain is diverted (counted, never a turn).
    expect(shapes['inline-sidechain']).toBeGreaterThanOrEqual(1);
    // No unknown record types / tool shapes / subtypes (doctor-class problems).
    expect(Object.keys(s.diagnostics.unknownRecordTypes)).toHaveLength(0);
    expect(Object.keys(s.diagnostics.unknownToolShapes)).toHaveLength(0);
    expect(Object.keys(s.diagnostics.unknownSubtypes)).toHaveLength(0);
    // The main turn is present with a final; the sidechain never supplies it.
    expect(s.turns.length).toBeGreaterThanOrEqual(1);
    const done = s.turns.find((turn) => turn.finalText?.includes('src/app.py'));
    expect(done).toBeDefined();
  });

  it('a promptId-less human-shaped line mid-chain never starts a second turn', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', text: 'done', usage: usage() });
    // A stray human-shaped line chained to the assistant (non-null parent):
    // real transcripts only omit promptId on interrupts/tool-results, never
    // on a mid-chain human line, so it resolves by the walk, not a new turn.
    t.user('a stray note', { parent: t.last() });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(1);
  });
});

describe('legacy wU usage path (§4.2.9)', () => {
  it('usage without a cache_creation breakdown uses the wU bucket', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({
      id: 'msg-legacy',
      stop: 'end_turn',
      text: 'done',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 300, service_tier: 'standard' } as never,
    });
    const s = await parseCC(t);
    const a = s.usageRows.find((r) => r.messageId === 'msg-legacy')?.attempts[0];
    expect(a?.wU).toBe(300);
    expect(s.diagnostics.legacyShapes['no-cache-breakdown']).toBe(1);
  });
});
