import { mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Roots, SessionRef } from '../../../src/model/types.js';
import { enumerateSessions } from '../../../src/discover/enumerate.js';
import { resolveRoots } from '../../../src/discover/roots.js';
import { materializeAll } from '../../helpers/fixtures.js';
import { makeTempDir, withTempDir } from '../../helpers/tmp.js';

const DAY = 86_400_000;

/** Writes `content` at `path` (parents created) and optionally pins its mtime. */
function put(path: string, content: string, mtime?: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}

/** Roots over `<root>/{claude,codex,sr}` (created so their realpaths resolve). */
function makeRoots(root: string): Roots {
  for (const name of ['claude', 'codex', 'sr']) mkdirSync(join(root, name), { recursive: true });
  return resolveRoots(
    { CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), SHOWRECEIPTS_HOME: join(root, 'sr') },
    join(root, 'home'),
  );
}

function byId(refs: SessionRef[], sessionId: string): SessionRef {
  const ref = refs.find((r) => r.sessionId === sessionId);
  if (ref === undefined) throw new Error(`no ref for ${sessionId}`);
  return ref;
}

describe('enumerateSessions over the materialised fixture tree', () => {
  const tree = makeTempDir('sr-enumerate-');
  let roots: Roots;
  let refs: SessionRef[];
  let counts: ReturnType<typeof enumerateSessions>['counts'];

  beforeAll(() => {
    const all = materializeAll(tree);
    roots = resolveRoots(
      { CLAUDE_CONFIG_DIR: all.claudeConfigDir, CODEX_HOME: all.codexHome, SHOWRECEIPTS_HOME: join(tree, 'sr-home') },
      join(tree, 'home'),
    );
    ({ refs, counts } = enumerateSessions(roots, { all: true }));
  });

  afterAll(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it('finds every fixture session with the right harness and id', () => {
    const claude = refs.filter((r) => r.harness === 'claude-code').map((r) => r.sessionId);
    const codex = refs.filter((r) => r.harness === 'codex').map((r) => r.sessionId);
    expect(claude.sort()).toEqual(
      [
        '1f574b70-66e7-4434-96de-1c7d4a0c6fb8',
        '21cf6a82-ebf2-4214-8dce-1869efe9e406',
        '2c707aeb-ba85-44e3-aec6-b50184966e3d',
        '57687dd1-8430-4568-a210-4a3d63ce162c',
        '6954d8ef-eedb-4b23-8cdc-17e422453dfa',
        '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d',
        'f150468e-ae67-4d6b-a36d-688ae5025a53',
      ].sort(),
    );
    expect(codex.sort()).toEqual(
      [
        '019c45e8-ac72-76c9-96e4-1a38177c0fb3',
        '019c4678-53b6-71c6-bb5b-d5b24ff14873',
        '019d1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b',
      ].sort(),
    );
  });

  it('reports the on-disk size and mtime for every ref', () => {
    for (const ref of refs) {
      const stat = statSync(ref.path);
      expect(ref.size).toBe(stat.size);
      expect(ref.mtimeMs).toBe(stat.mtimeMs);
    }
  });

  it('lists ≥ 12 agent files plus their metas in the 2.1.235 manifest', () => {
    const ref = byId(refs, '57687dd1-8430-4568-a210-4a3d63ce162c');
    const agents = ref.subagentManifest.filter((e) => /agent-[0-9a-f]+\.jsonl$/.test(e.rel));
    const metas = ref.subagentManifest.filter((e) => /agent-[0-9a-f]+\.meta\.json$/.test(e.rel));
    expect(agents.length).toBeGreaterThanOrEqual(12);
    expect(metas.length).toBe(agents.length);
    for (const agent of agents) {
      expect(metas.some((m) => m.rel === agent.rel.replace(/\.jsonl$/, '.meta.json'))).toBe(true);
    }
    expect(ref.subagentDir).toBe(join(ref.projectDir as string, ref.sessionId, 'subagents'));
  });

  it('lists the workflow files in the 2.1.241 manifest', () => {
    const ref = byId(refs, '2c707aeb-ba85-44e3-aec6-b50184966e3d');
    const workflow = ref.subagentManifest.filter((e) => e.rel.includes('/subagents/workflows/wf_42a7dcd5-323/'));
    expect(workflow.length).toBe(6); // 3 agents + 3 metas
    expect(ref.subagentManifest.length).toBe(10); // + 2 direct agents + 2 metas
  });

  it('lists journal.jsonl in the 2.1.251 manifest and counts it', () => {
    const ref = byId(refs, '6954d8ef-eedb-4b23-8cdc-17e422453dfa');
    expect(ref.subagentManifest.some((e) => e.rel.endsWith('/journal.jsonl'))).toBe(true);
    expect(counts.journals).toBe(1);
    expect(counts.unrecognisedFiles).toBe(0);
    expect(counts.orphanSessionDirs).toBe(0);
    expect(counts.emptyProjects).toBe(0);
  });

  it('enumerates the 2.1.243 no-turns session as a normal, non-empty ref', () => {
    const ref = byId(refs, '1f574b70-66e7-4434-96de-1c7d4a0c6fb8');
    expect(ref.empty).toBeUndefined();
    expect(ref.size).toBeGreaterThan(2);
    expect(ref.subagentManifest).toEqual([]);
    expect(ref.subagentDir).toBeUndefined();
  });

  it('resolves Codex titles from session_index.jsonl (used for nothing else)', () => {
    expect(byId(refs, '019c45e8-ac72-76c9-96e4-1a38177c0fb3').title).toBe('Fixture thread 1');
    expect(byId(refs, '019c4678-53b6-71c6-bb5b-d5b24ff14873').title).toBe('Fixture thread 2');
    expect(byId(refs, '019d1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b').title).toBe('Fixture thread 1');
  });

  it('anchors every manifest rel under the ref projectDir', () => {
    for (const ref of refs.filter((r) => r.harness === 'claude-code')) {
      expect(ref.projectDir).toBeDefined();
      for (const entry of ref.subagentManifest) {
        const stat = statSync(join(ref.projectDir as string, entry.rel));
        expect(stat.size).toBe(entry.size);
        expect(stat.mtimeMs).toBe(entry.mtimeMs);
      }
    }
  });

  it('sorts manifests by rel and refs by mtimeMs desc then path asc, under the realpathed roots', () => {
    for (const ref of refs) {
      const rels = ref.subagentManifest.map((e) => e.rel);
      expect(rels).toEqual([...rels].sort());
      expect(ref.path.startsWith(`${tree}/`)).toBe(true);
    }
    for (let i = 1; i < refs.length; i += 1) {
      const prev = refs[i - 1] as SessionRef;
      const curr = refs[i] as SessionRef;
      expect(prev.mtimeMs > curr.mtimeMs || (prev.mtimeMs === curr.mtimeMs && prev.path < curr.path)).toBe(true);
    }
  });

  it('filters harnesses when asked', () => {
    const codexOnly = enumerateSessions(roots, { all: true, harness: ['codex'] });
    expect(codexOnly.refs.length).toBe(3);
    expect(codexOnly.refs.every((r) => r.harness === 'codex')).toBe(true);
    const none = enumerateSessions(roots, { all: true, harness: [] });
    expect(none.refs).toEqual([]);
  });

  it('applies since as an mtime prefilter (a caller-derived timestamp, never the wall clock)', () => {
    const since = Date.UTC(2026, 7, 1); // 2026-08-01, between the fixture mtimes
    const windowed = enumerateSessions(roots, { since });
    const expected = refs.filter((r) => r.mtimeMs >= since).map((r) => r.sessionId);
    expect(windowed.refs.map((r) => r.sessionId).sort()).toEqual(expected.sort());
    expect(windowed.refs.length).toBeGreaterThan(0);
    expect(windowed.refs.length).toBeLessThan(refs.length);
    // `all` disables the window even when `since` is present.
    expect(enumerateSessions(roots, { since, all: true }).refs.length).toBe(refs.length);
  });
});

describe('enumerateSessions over synthetic trees', () => {
  it('returns empty arrays for absent roots without throwing', () => {
    const roots = resolveRoots({}, '/definitely/not/a/home');
    const { refs, counts } = enumerateSessions(roots, { all: true });
    expect(refs).toEqual([]);
    expect(counts).toEqual({ orphanSessionDirs: 0, emptyProjects: 0, unrecognisedFiles: 0, journals: 0 });
  });

  it('returns nothing for roots that exist but hold no sessions', async () => {
    await withTempDir((dir) => {
      const { refs } = enumerateSessions(makeRoots(dir), { all: true });
      expect(refs).toEqual([]);
    });
  });

  it('flags transcripts under 2 bytes as empty', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const project = join(dir, 'claude', 'projects', '-p');
      put(join(project, '00000000-0000-4000-8000-000000000000.jsonl'), '');
      put(join(project, '00000000-0000-4000-8000-000000000001.jsonl'), 'x');
      put(join(project, '00000000-0000-4000-8000-000000000002.jsonl'), '{}');
      const { refs } = enumerateSessions(roots, { all: true });
      expect(byId(refs, '00000000-0000-4000-8000-000000000000').empty).toBe(true);
      expect(byId(refs, '00000000-0000-4000-8000-000000000001').empty).toBe(true);
      expect(byId(refs, '00000000-0000-4000-8000-000000000002').empty).toBeUndefined();
    });
  });

  it('counts orphan session dirs, empty projects and unrecognised subagent files', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const p1 = join(dir, 'claude', 'projects', '-p1');
      put(join(p1, 'aaaa.jsonl'), '{}\n');
      mkdirSync(join(p1, 'deadbeef'), { recursive: true }); // orphan: no deadbeef.jsonl
      put(join(p1, 'aaaa', 'subagents', 'agent-0abc.jsonl'), '{}\n');
      put(join(p1, 'aaaa', 'subagents', 'agent-0abc.meta.json'), '{}');
      put(join(p1, 'aaaa', 'subagents', 'journal.jsonl'), '{}\n');
      put(join(p1, 'aaaa', 'subagents', 'notes.txt'), 'not a transcript');
      mkdirSync(join(dir, 'claude', 'projects', '-p2', 'cafe0000'), { recursive: true }); // empty project + orphan
      const { refs, counts } = enumerateSessions(roots, { all: true });
      expect(refs.map((r) => r.sessionId)).toEqual(['aaaa']);
      expect(counts.orphanSessionDirs).toBe(2);
      expect(counts.emptyProjects).toBe(1);
      expect(counts.unrecognisedFiles).toBe(1);
      expect(counts.journals).toBe(1);
      expect(byId(refs, 'aaaa').subagentManifest.map((e) => e.rel)).toEqual([
        'aaaa/subagents/agent-0abc.jsonl',
        'aaaa/subagents/agent-0abc.meta.json',
        'aaaa/subagents/journal.jsonl',
      ]);
    });
  });

  it('tolerates the older beside-the-main-file agent layout and lists it in the manifest', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const p = join(dir, 'claude', 'projects', '-p');
      put(join(p, 'bbbb.jsonl'), '{}\n');
      put(join(p, 'agent-0123.jsonl'), '{}\n');
      put(join(p, 'agent-0123.meta.json'), '{}');
      const { refs, counts } = enumerateSessions(roots, { all: true });
      expect(refs.map((r) => r.sessionId)).toEqual(['bbbb']); // never a session of its own
      expect(byId(refs, 'bbbb').subagentManifest.map((e) => e.rel)).toEqual(['agent-0123.jsonl', 'agent-0123.meta.json']);
      expect(counts.unrecognisedFiles).toBe(0);
    });
  });

  it('caps the subagent scan at depth 4 and never follows symlinks', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const p = join(dir, 'claude', 'projects', '-p');
      put(join(p, 'cccc.jsonl'), '{}\n');
      const sub = join(p, 'cccc', 'subagents');
      put(join(sub, 'd1', 'd2', 'd3', 'agent-aa.jsonl'), '{}\n'); // depth 4: kept
      put(join(sub, 'd1', 'd2', 'd3', 'd4', 'agent-bb.jsonl'), '{}\n'); // depth 5: ignored
      put(join(dir, 'outside.jsonl'), '{}\n');
      symlinkSync(join(dir, 'outside.jsonl'), join(sub, 'agent-cc.jsonl')); // symlink: never followed
      const { refs, counts } = enumerateSessions(roots, { all: true });
      expect(byId(refs, 'cccc').subagentManifest.map((e) => e.rel)).toEqual(['cccc/subagents/d1/d2/d3/agent-aa.jsonl']);
      expect(counts.unrecognisedFiles).toBe(1); // the symlink
    });
  });

  it('never enters the session-dir siblings of subagents/', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const p = join(dir, 'claude', 'projects', '-p');
      put(join(p, 'dddd.jsonl'), '{}\n');
      put(join(p, 'dddd', 'tool-results', 'x.txt'), 'never opened');
      put(join(p, 'dddd', 'memory', 'y.md'), 'never opened');
      put(join(p, 'dddd', 'sessions-index.json'), '{}');
      put(join(p, 'sessions-index.json'), '{}');
      const { refs, counts } = enumerateSessions(roots, { all: true });
      const ref = byId(refs, 'dddd');
      expect(ref.subagentManifest).toEqual([]);
      expect(ref.subagentDir).toBeUndefined();
      expect(counts.unrecognisedFiles).toBe(0);
    });
  });

  it('enumerates Codex rollouts from sessions/ and archived_sessions/ with the trailing uuid as id', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const codex = join(dir, 'codex');
      put(join(codex, 'sessions', '2026', '08', '28', 'rollout-2026-08-28T10-00-00-01900000-1111-7222-8333-444455556666.jsonl'), '{}\n');
      put(join(codex, 'archived_sessions', '2026', '05', '01', 'rollout-2026-05-01T09-00-00-01900000-1111-7222-8333-AAAA55556666.jsonl'), '{}\n');
      put(join(codex, 'sessions', '2026', '08', '28', 'notes.txt'), 'ignored');
      put(join(codex, 'sessions', '2026', '08', '28', 'rollout-not-a-uuid.jsonl'), '{}\n');
      put(join(codex, 'models_cache.json'), '{}');
      const { refs } = enumerateSessions(roots, { all: true });
      const ids = refs.map((r) => r.sessionId).sort();
      expect(ids).toEqual(['01900000-1111-7222-8333-444455556666', '01900000-1111-7222-8333-aaaa55556666']);
      expect(refs.every((r) => r.harness === 'codex' && r.subagentManifest.length === 0)).toBe(true);
      expect(refs.every((r) => r.title === undefined)).toBe(true); // no session_index.jsonl
    });
  });

  it('uses the Codex path date only as a ±1-day prefilter, beside the mtime prefilter', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const codex = join(dir, 'codex');
      const recent = new Date(Date.UTC(2026, 7, 28, 10)); // 2026-08-28
      const ancient = new Date(Date.UTC(2020, 0, 1));
      // Old path date, recent mtime: the path prefilter drops it.
      put(join(codex, 'sessions', '2020', '01', '01', 'rollout-2020-01-01T00-00-00-01900000-1111-7222-8333-000000000001.jsonl'), '{}\n', recent);
      // Recent path date, old mtime: the mtime prefilter drops it.
      put(join(codex, 'sessions', '2026', '08', '28', 'rollout-2026-08-28T10-00-00-01900000-1111-7222-8333-000000000002.jsonl'), '{}\n', ancient);
      // Recent on both counts: kept.
      put(join(codex, 'sessions', '2026', '08', '28', 'rollout-2026-08-28T11-00-00-01900000-1111-7222-8333-000000000003.jsonl'), '{}\n', recent);
      const since = Date.UTC(2026, 7, 29, 12) - 90 * DAY;
      const windowed = enumerateSessions(roots, { since });
      expect(windowed.refs.map((r) => r.sessionId)).toEqual(['01900000-1111-7222-8333-000000000003']);
      const everything = enumerateSessions(roots, { all: true });
      expect(everything.refs.length).toBe(3);
    });
  });

  it('lets the last session_index.jsonl entry per id win and ignores malformed lines', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const codex = join(dir, 'codex');
      const id = '01900000-1111-7222-8333-444455556666';
      put(join(codex, 'sessions', '2026', '08', '28', `rollout-2026-08-28T10-00-00-${id}.jsonl`), '{}\n');
      put(
        join(codex, 'session_index.jsonl'),
        [
          JSON.stringify({ id, thread_name: 'First title' }),
          'not json at all',
          JSON.stringify({ id: 42, thread_name: 'wrong types' }),
          JSON.stringify({ id, thread_name: 'Last title wins' }),
        ].join('\n'),
      );
      const { refs } = enumerateSessions(roots, { all: true });
      expect(byId(refs, id).title).toBe('Last title wins');
    });
  });

  it('enumerates hook-captured ledgers per harness and skips unknown harness directories', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      put(join(dir, 'sr', 'ledger', 'claude-code', 'sid-1.jsonl'), '{}\n');
      put(join(dir, 'sr', 'ledger', 'cursor', 'sid-2.jsonl'), '{}\n');
      put(join(dir, 'sr', 'ledger', 'not-a-harness', 'sid-3.jsonl'), '{}\n');
      put(join(dir, 'sr', 'ledger', 'cursor', 'not-a-ledger.txt'), 'ignored');
      const { refs } = enumerateSessions(roots, { all: true });
      expect(refs.map((r) => `${r.harness}:${r.sessionId}`).sort()).toEqual(['claude-code:sid-1', 'cursor:sid-2']);
      expect(refs.every((r) => r.ledger === true && r.subagentManifest.length === 0)).toBe(true);
      const filtered = enumerateSessions(roots, { all: true, harness: ['cursor'] });
      expect(filtered.refs.map((r) => r.sessionId)).toEqual(['sid-2']);
    });
  });

  it('sorts by mtimeMs descending, then path ascending', async () => {
    await withTempDir((dir) => {
      const roots = makeRoots(dir);
      const p = join(dir, 'claude', 'projects', '-p');
      const older = new Date(Date.UTC(2026, 5, 1));
      const newer = new Date(Date.UTC(2026, 6, 1));
      put(join(p, 'b-newer.jsonl'), '{}\n', newer);
      put(join(p, 'a-older.jsonl'), '{}\n', older);
      put(join(p, 'c-older.jsonl'), '{}\n', older);
      const { refs } = enumerateSessions(roots, { all: true });
      expect(refs.map((r) => r.sessionId)).toEqual(['b-newer', 'a-older', 'c-older']);
    });
  });
});
