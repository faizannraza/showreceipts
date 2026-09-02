import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributeExit, tokenize } from '../../../../src/ledger/shell/index.js';
import type { ExitSource, ShellSegment } from '../../../../src/model/types.js';

interface ExpectedRedirect {
  op: string;
  target: string;
  resolved: boolean;
}

interface ExpectedSegment {
  program: string;
  family?: string;
  runner?: string;
  exit?: number | null;
  exitSource?: string;
  suppressed?: boolean;
  ran?: boolean | string;
  cwd?: string;
  redirects?: ExpectedRedirect[];
}

interface Entry {
  cmd: string;
  cwd: string;
  exit: number | null;
  exitSource?: ExitSource;
  output?: string;
  expect: {
    segments: ExpectedSegment[];
    background?: boolean;
    pipefail?: boolean;
    notes?: string[];
  };
}

const HOME = '/home/u';
const raw = readFileSync(new URL('../../../../fixtures/shell/corpus.jsonl', import.meta.url), 'utf8');
const entries: Entry[] = raw
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Entry);

describe('fixtures/shell/corpus.jsonl (§4.5.1 acceptance)', () => {
  it('has at least 60 entries including a 10 KB command', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
    expect(entries.some((e) => e.cmd.length > 10_000)).toBe(true);
  });

  it.each(entries.map((e, i) => [`#${i}: ${e.cmd.slice(0, 60).replace(/\n/g, '⏎')}`, e] as const))('%s', (_label, entry) => {
    const parse = tokenize(entry.cmd, entry.cwd, { home: HOME });
    attributeExit(parse, entry.exit, entry.exitSource ?? 'harness', entry.output);
    expect(parse.segments.map((s) => s.program)).toEqual(entry.expect.segments.map((s) => s.program));
    for (let i = 0; i < entry.expect.segments.length; i += 1) {
      const want = entry.expect.segments[i] as ExpectedSegment;
      const got = parse.segments[i] as ShellSegment;
      const at = `segment ${i} (${want.program})`;
      if ('family' in want) expect(got.family, at).toBe(want.family);
      if ('runner' in want) expect(got.runner, at).toBe(want.runner);
      if ('exit' in want) expect(got.exitCode, at).toBe(want.exit);
      if ('exitSource' in want) expect(got.exitCodeSource, at).toBe(want.exitSource);
      if ('suppressed' in want) expect(got.suppressed, at).toBe(want.suppressed);
      if ('ran' in want) expect(got.ran, at).toBe(want.ran);
      if ('cwd' in want) expect(got.cwd, at).toBe(want.cwd);
      if (want.redirects !== undefined) {
        expect(got.redirects.map((r) => ({ op: r.op, target: r.target, resolved: r.resolved })), at).toEqual(want.redirects);
      }
    }
    if (entry.expect.background !== undefined) expect(parse.background).toBe(entry.expect.background);
    if (entry.expect.pipefail !== undefined) expect(parse.pipefail).toBe(entry.expect.pipefail);
    for (const note of entry.expect.notes ?? []) expect(parse.notes).toContain(note);
  });

  it('produces zero redirect targets ending in ":" or containing "[" across the whole corpus', () => {
    for (const entry of entries) {
      const parse = tokenize(entry.cmd, entry.cwd, { home: HOME });
      for (const seg of parse.segments) {
        for (const r of seg.redirects) {
          expect(r.target.endsWith(':'), `${entry.cmd.slice(0, 60)} → ${r.target}`).toBe(false);
          expect(r.target.includes('['), `${entry.cmd.slice(0, 60)} → ${r.target}`).toBe(false);
        }
      }
    }
  });

  it('every corpus entry parses in linear time (whole corpus < 250 ms)', () => {
    const t0 = performance.now();
    for (const entry of entries) tokenize(entry.cmd, entry.cwd, { home: HOME });
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
