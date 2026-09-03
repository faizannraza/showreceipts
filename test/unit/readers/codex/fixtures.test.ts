/**
 * S08 acceptance: the two real redacted rollouts (codex/0.98.0) and the
 * synthetic `codex/shell_command` dialect fixture, parsed end to end.
 * Golden counts per §0.3 / Appendix B: 67 + 2 turns, 286 + 6 tool calls
 * (`write_stdin` included), 27 + 1 patches, 23 + 1 back-filled exits, one
 * `-1` exit, 722 `token_count` events (16 + 706) with 7 + 352 zero-delta
 * duplicates.
 */
import { describe, expect, it } from 'vitest';
import type { LineSource, Session, SessionRef } from '../../../../src/model/types.js';
import { readCodexSession } from '../../../../src/readers/codex/reader.js';
import { readFixtureBytes } from '../../../helpers/fixtures.js';

const HOME = '/home/u';

async function readFixtureRollout(fixtureId: string, rel: string, sessionId: string, title?: string): Promise<Session> {
  const text = readFixtureBytes(fixtureId, rel).toString('utf8');
  const lines: LineSource = { kind: 'text', text, name: rel };
  const ref: SessionRef = {
    harness: 'codex',
    sessionId,
    path: `/home/u/.codex/${rel}`,
    size: text.length,
    mtimeMs: 0,
    subagentManifest: [],
    ...(title === undefined ? {} : { title }),
  };
  const { session } = await readCodexSession(ref, { lines, home: HOME });
  return session;
}

// The 64-line rollout (2 turns, 6 tool calls).
const r1 = await readFixtureRollout(
  'codex/0.98.0',
  'sessions/2026/02/09/rollout-2026-02-09T23-56-42-019c45e8-ac72-76c9-96e4-1a38177c0fb3.jsonl',
  '019c45e8-ac72-76c9-96e4-1a38177c0fb3',
  'Fixture thread 1',
);
// The 2,179-line rollout (67 turns, 286 tool calls).
const r2 = await readFixtureRollout(
  'codex/0.98.0',
  'sessions/2026/02/10/rollout-2026-02-10T02-33-36-019c4678-53b6-71c6-bb5b-d5b24ff14873.jsonl',
  '019c4678-53b6-71c6-bb5b-d5b24ff14873',
);
// The synthetic 0.148 shell_command dialect (confidence: synthetic).
const sc = await readFixtureRollout(
  'codex/shell_command',
  'sessions/2026/08/15/rollout-2026-08-15T10-00-00-019d1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b.jsonl',
  '019d1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b',
);

describe('rollout 019c45e8 (real, 64 lines)', () => {
  it('builds the session skeleton', () => {
    expect(r1.harness).toBe('codex');
    expect(r1.harnessVersion).toBe('0.98.0');
    expect(r1.shortId).toBe('177c0fb3'); // UUIDv7 → last 8 hex
    expect(r1.originator).toBe('codex_vscode');
    expect(r1.subagent).toBeUndefined(); // source is the string 'vscode'
    expect(r1.title).toBe('Fixture thread 1');
    expect(r1.cwd).toBe('/home/u/proj1');
    expect(r1.models).toEqual(['gpt-5.2-codex']);
    expect(r1.primaryModel).toBe('gpt-5.2-codex');
    expect(r1.sandbox).toEqual({ type: 'workspace-write', writableRoots: ['/home/u/proj1'], networkAccess: false });
    expect(r1.startedAt).toBe('2026-02-10T04:56:42.354Z'); // session_meta.timestamp
    expect(r1.endedAt).toBe('2026-02-10T05:09:50.414Z'); // last record timestamp
    expect(r1.kind).toBe('normal');
    expect(r1.records).toBe(64);
    expect(r1.spansDays).toBe(1);
    expect(r1.diagnostics.badLines).toBe(0);
    expect(r1.diagnostics.unknownRecordTypes).toEqual({});
    expect(r1.diagnostics.unknownCodexPayloads).toEqual({});
  });

  it('parses 2 turns, both done, with the IDE wrapper stripped', () => {
    expect(r1.turns).toHaveLength(2);
    expect(r1.turns.every((t) => t.isDone)).toBe(true);
    expect(r1.turns[0]?.finalText?.startsWith('Created `lea_col_drop_preview.ipynb`')).toBe(true);
    expect(r1.turns[1]?.userText).toBe('<prompt:44b>'); // wrapper stripped
    for (const t of r1.turns) expect(t.userText?.startsWith('# Context from my IDE setup:')).toBe(false);
  });

  it('parses 6 tool calls with one back-filled exit', () => {
    expect(r1.toolCalls).toHaveLength(6);
    expect(r1.toolCalls.filter((c) => c.stdinWrite === true)).toHaveLength(1);
    const sources = r1.toolCalls.map((c) => c.exitCodeSource);
    expect(sources.filter((x) => x === 'backfilled')).toHaveLength(1);
    expect(sources.filter((x) => x === 'harness')).toHaveLength(5);
    const backfilled = r1.toolCalls.find((c) => c.exitCodeSource === 'backfilled');
    expect(backfilled?.tool).toBe('exec_command');
    expect(backfilled?.exitCode).toBe(0);
    expect(backfilled?.background).toBe(true);
    expect(backfilled?.stdinWrites).toHaveLength(1);
    expect(r1.toolCalls.some((c) => c.exitCode === 127)).toBe(true);
  });

  it('sums token deltas to input 94,642 / cached 82,560 / output 2,343', () => {
    // 16 token_count events: 1 null info, 7 exact duplicates → 8 deltas.
    expect(r1.tokenDeltas).toHaveLength(8);
    const sum = r1.tokenDeltas.reduce(
      (acc, d) => ({ input: acc.input + d.input, cached: acc.cached + d.cached, output: acc.output + d.output }),
      { input: 0, cached: 0, output: 0 },
    );
    expect(sum).toEqual({ input: 94_642, cached: 82_560, output: 2_343 });
    expect(r1.usage.calls).toBe(8);
    expect(r1.usage.input).toBe(94_642 - 82_560);
    expect(r1.usage.cacheRead).toBe(82_560);
    expect(r1.usage.output).toBe(2_343);
    expect(r1.cost.planUsagePct).toBe(1);
    expect(r1.diagnostics.negativeDeltas).toBe(0);
  });
});

describe('rollout 019c4678 (real, 2,179 lines)', () => {
  it('parses 67 turns and 286 tool calls (write_stdin included)', () => {
    expect(r2.turns).toHaveLength(67);
    expect(r2.turns.every((t) => t.isDone)).toBe(true);
    expect(r2.toolCalls).toHaveLength(286);
    expect(r2.toolCalls.filter((c) => c.stdinWrite === true)).toHaveLength(143);
    expect(r2.records).toBe(2_179);
    expect(r2.diagnostics.badLines).toBe(0);
    expect(r2.diagnostics.unknownCodexPayloads).toEqual({});
  });

  it('strips the IDE wrapper from every turn', () => {
    for (const t of r2.turns) expect(t.userText?.startsWith('# Context from my IDE setup:')).toBe(false);
  });

  it('finds 27 successful apply_patch calls and 1 failure with attempted paths', () => {
    const patches = r2.toolCalls.filter((c) => c.tool === 'apply_patch');
    expect(patches).toHaveLength(28);
    const ok = patches.filter((c) => !c.isError);
    const failed = patches.filter((c) => c.isError);
    expect(ok).toHaveLength(27);
    expect(failed).toHaveLength(1);
    for (const c of ok) {
      expect(c.exitCode).toBe(0);
      expect(c.filesTouched.length).toBeGreaterThan(0);
      for (const p of c.filesTouched) expect(p.startsWith('/')).toBe(true); // resolved against turn_context.cwd
    }
    expect(failed[0]?.exitCode).toBe(1);
    expect(failed[0]?.filesTouched).toEqual([]);
    expect(failed[0]?.attempted?.length).toBeGreaterThan(0);
    expect(failed[0]?.attempted?.[0]?.startsWith('/home/u/proj1/')).toBe(true);
  });

  it('back-fills 23 exits and maps the one -1 exit to null + terminated', () => {
    expect(r2.toolCalls.filter((c) => c.exitCodeSource === 'backfilled')).toHaveLength(23);
    // The -1 arrives on a write_stdin output: its own call and the back-filled target both terminate.
    const terminated = r2.toolCalls.filter((c) => c.terminated === true);
    expect(terminated).toHaveLength(2);
    for (const c of terminated) expect(c.exitCode).toBeNull();
    expect(terminated.some((c) => c.exitCodeSource === 'backfilled')).toBe(true);
  });

  it('produces 353 token deltas (706 events − 1 null info − 352 duplicates)', () => {
    expect(r2.tokenDeltas).toHaveLength(353);
    expect(r2.usage.calls).toBe(353);
  });
});

describe('codex/shell_command (synthetic 0.148 dialect)', () => {
  const byCommand = (needle: string) => sc.toolCalls.find((c) => c.command?.includes(needle));

  it('parses the session skeleton and both turns', () => {
    expect(sc.harnessVersion).toBe('0.148.0');
    expect(sc.originator).toBe('codex_cli_rs');
    expect(sc.models).toEqual(['gpt-5.6-terra']); // S19 step 0 re-dated the fixture (gpt-5.6-terra, Aug 2026)
    expect(sc.turns).toHaveLength(2);
    expect(sc.turns.every((t) => t.isDone)).toBe(true);
    expect(sc.turns[0]?.finalText?.startsWith('Added `src/new_module.py`')).toBe(true);
    expect(sc.turns[1]?.finalText).toBe('Committed as `0f1e2d3` on `main`. I did not push.');
    expect(sc.toolCalls).toHaveLength(11);
    expect(sc.cost.planUsagePct).toBe(4);
  });

  it('parses with zero unknownCodexPayloads', () => {
    expect(sc.diagnostics.unknownCodexPayloads).toEqual({});
    expect(sc.diagnostics.badLines).toBe(0);
  });

  it('has exitCodeSource values harness, backfilled and unknown', () => {
    const sources = new Set(sc.toolCalls.map((c) => c.exitCodeSource));
    expect(sources.has('harness')).toBe(true);
    expect(sources.has('backfilled')).toBe(true);
    expect(sources.has('unknown')).toBe(true);
  });

  it('parses JSON-string outputs (shell dialect)', () => {
    const npmTest = byCommand('npm test');
    expect(npmTest?.exitCode).toBe(0);
    expect(npmTest?.exitCodeSource).toBe('harness');
    expect(npmTest?.resultText).toContain('Test Files  3 passed (3)');
    const ruff = byCommand('ruff check');
    expect(ruff?.exitCode).toBe(1);
    expect(ruff?.resultText).toContain('Found 2 errors.');
  });

  it('joins string[] commands with the wrapper collapse', () => {
    const pytest = sc.toolCalls.find((c) => c.tool === 'shell');
    expect(pytest?.command).toBe('pytest -q tests/');
    expect(pytest?.kind).toBe('shell');
    expect(pytest?.exitCode).toBe(1);
  });

  it('parses the exec-delivered apply_patch with Add/Delete/Move writes', () => {
    const patch = byCommand('apply_patch');
    expect(patch?.tool).toBe('exec_command');
    expect(patch?.kind).toBe('shell');
    expect(patch?.isError).toBe(false);
    expect(patch?.exitCode).toBe(0);
    expect(patch?.filesTouched).toEqual([
      '/home/u/proj1/src/new_module.py',
      '/home/u/proj1/src/old_module.py',
      '/home/u/proj1/src/renamed_to.py',
    ]);
    expect(patch?.patch?.hunks).toBe(1);
  });

  it('maps the -1 exit to null + terminated', () => {
    const sleep = byCommand('sleep 100');
    expect(sleep?.exitCode).toBeNull();
    expect(sleep?.terminated).toBe(true);
  });

  it('back-fills the background npm run dev via write_stdin and records the Ctrl-C interrupt', () => {
    const dev = byCommand('npm run dev');
    expect(dev?.background).toBe(true);
    expect(dev?.exitCode).toBe(130);
    expect(dev?.exitCodeSource).toBe('backfilled');
    expect(dev?.interrupted).toBe(true);
    expect(dev?.stdinWrites).toHaveLength(2);
    expect(dev?.stdinWrites?.[0]?.interrupted).toBeUndefined();
    expect(dev?.stdinWrites?.[1]?.interrupted).toBe(true);
    const writes = sc.toolCalls.filter((c) => c.stdinWrite === true);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.exitCode).toBeNull(); // its output still shows the process running
    expect(writes[0]?.exitCodeSource).toBe('unknown');
    expect(writes[1]?.exitCode).toBe(130);
  });

  it('strips the harness truncation markers', () => {
    const cat = byCommand('cat data/big.log');
    expect(cat?.truncated).toBe('harness');
    expect(cat?.originalTokens).toBe(24_000);
    expect(cat?.resultText).not.toContain('Total output lines');
    expect(cat?.resultText).not.toContain('tokens truncated');
  });

  it('flags the sandbox denial as denied, with the embedded exit', () => {
    const curl = byCommand('curl');
    expect(curl?.denied).toBe('sandbox-denied');
    expect(curl?.isError).toBe(true);
    expect(curl?.exitCode).toBe(1);
    expect(curl?.exitCodeSource).toBe('parsed');
  });
});
