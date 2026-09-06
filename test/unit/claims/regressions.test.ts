/**
 * Closing-review regressions (Pass 1) for the claims extractor:
 *
 *  - ReDoS: `CHAIN_RE`'s tool-list expansion and the aux-verb stars were
 *    ambiguous and unbounded — quadratic on adversarial final messages
 *    (~5 s at 40 KB, extrapolating to hours at transcript scale). The
 *    pathological inputs below must stay within a small, CI-safe budget.
 *  - Dedupe: `sha` is part of the claim identity — a message citing two
 *    different commit shas must yield two claims, not one.
 */
import { describe, expect, it } from 'vitest';
import { extractClaims } from '../../../src/claims/extract.js';

const ctx = { turnIndex: 0, echoHashes: [], ledgerPaths: ['src/app.ts'], cwd: '/home/u' };

/** Wall-time budget per pathological input; the fixed regexes finish in milliseconds. */
const BUDGET_MS = 1500;

function timed(fn: () => unknown): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('ReDoS regressions (bounded list/aux regexes + literal pre-check)', () => {
  it('a 40 KB slash-token clause finishes fast', () => {
    const ms = timed(() => extractClaims('updated ' + 'a/'.repeat(20000) + 'b.ts', ctx));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('a 90 KB aux-verb run finishes fast', () => {
    const ms = timed(() => extractClaims('tests ' + 'is '.repeat(30000) + 'x', ctx));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('an and-separator bomb with a predicate present finishes fast', () => {
    const ms = timed(() => extractClaims('x ' + 'and '.repeat(5000) + 'ok', ctx));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('tool-list expansion still works after the bounds', () => {
    const { claims } = extractClaims('All 64 tests still green, ruff/mypy clean.', ctx);
    expect(claims.some((c) => c.kind === 'test' && c.count === 64)).toBe(true);
    expect(claims.some((c) => c.kind === 'check' && c.family === 'lint' && c.tool === 'ruff')).toBe(true);
    expect(claims.some((c) => c.kind === 'check' && c.family === 'type' && c.tool === 'mypy')).toBe(true);
  });
});

describe('per-message dedupe keeps distinct commit shas apart', () => {
  it('two committed-as clauses with different shas yield two git claims', () => {
    const { claims } = extractClaims('Committed the parser fix as `aaaaaaa`. I committed the cleanup as `bbbbbbb`.', ctx);
    const commits = claims.filter((c) => c.kind === 'git' && c.op === 'commit');
    expect(commits.map((c) => c.sha).sort()).toEqual(['aaaaaaa', 'bbbbbbb']);
  });

  it('the same sha cited twice still dedupes to one claim', () => {
    const { claims } = extractClaims('Committed as `aaaaaaa`. I committed everything as `aaaaaaa`.', ctx);
    const commits = claims.filter((c) => c.kind === 'git' && c.op === 'commit');
    expect(commits).toHaveLength(1);
  });
});
