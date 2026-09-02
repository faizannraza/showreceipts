/**
 * S15 — normalisation and scoping (ARCHITECTURE §4.7 steps 1–3): fences,
 * emphasis, tables, section scoping, lead-in lists, clause splitting and
 * tool-list expansion.
 */
import { describe, expect, it } from 'vitest';
import { analyse, sentences } from '../../../src/claims/text.js';
import { extractClaims } from '../../../src/claims/extract.js';

const CTX = { turnIndex: 0, echoHashes: [], ledgerPaths: [], cwd: '/repo' };
const clauses = (text: string): string[] => analyse(text).clauses.map((c) => c.clause);

describe('normalisation (§4.7 step 1)', () => {
  it('normalises curly quotes, dashes and ellipses', () => {
    expect(clauses('I can’t stop…')).toEqual(["I can't stop..."]);
  });

  it('strips emphasis outside backticks and keeps it inside', () => {
    expect(clauses('**bold** and `a ** b`')).toEqual(['bold and `a ** b`']);
  });

  it('strips bullets and heading markers', () => {
    expect(clauses('## Heading\n- item one\n2. item two')).toEqual(['Heading', 'item one', 'item two']);
  });

  it('removes fenced blocks and HTML comments', () => {
    expect(clauses('before\n```\ninside\n```\nafter <!-- gone --> end')).toEqual(['before', 'after end']);
  });

  it('turns a 2-cell table row into one `label: status` clause', () => {
    expect(clauses('| Tests | ✅ 41 passed |')).toEqual(['Tests: ✅ 41 passed']);
  });

  it('splits wider table rows into cells and skips separator rows', () => {
    expect(clauses('| a | b | c |\n|---|---|---|')).toEqual(['a', 'b', 'c']);
  });
});

describe('sentence and clause splitting (§4.7 steps 2–3)', () => {
  it('does not split after abbreviations, decimals or inside backticks', () => {
    expect(sentences('e.g. this stays. And 2.5 too. `x. y` intact.')).toEqual([
      'e.g. this stays.',
      'And 2.5 too.',
      '`x. y` intact.',
    ]);
  });

  it('splits clauses on ; : — -- , but / however / while', () => {
    expect(clauses('a pass; b clean: c ok — d fine -- e good, but f bad however g while h')).toEqual([
      'a pass',
      'b clean',
      'c ok',
      'd fine',
      'e good',
      'f bad',
      'g',
      'h',
    ]);
  });

  it('marks the head of an `except` split partial', () => {
    const parsed = analyse('Tests pass (except the flaky one).').clauses;
    expect(parsed[0]?.partial).toBe(true);
    expect(parsed[0]?.clause).toBe('Tests pass');
  });

  it('flags questions', () => {
    expect(analyse('Is it green?').clauses[0]?.question).toBe(true);
  });

  it('expands slash/plus/and tool lists sharing one predicate', () => {
    expect(clauses('ruff/mypy clean')).toEqual(['ruff/mypy clean', 'ruff clean', 'mypy clean']);
    const { claims } = extractClaims('typecheck and lint clean', CTX);
    expect(claims.map((c) => c.family).sort()).toEqual(['lint', 'type']);
  });

  it('expands parenthesised tool lists', () => {
    const { claims } = extractClaims('All checks (ruff, mypy) passed.', CTX);
    expect(claims.map((c) => c.family).sort()).toEqual(['lint', 'type']);
  });

  it('leaves validation-gate lines to the test.gate rule', () => {
    const { claims } = extractClaims('Full validation gate (pytest, mypy) passed.', CTX);
    expect(claims.map((c) => c.rule)).toEqual(['test.gate', 'test.gate']);
  });
});

describe('section scoping (§4.7 step 5)', () => {
  it('a `## Not done` heading defers following clauses until the next heading', () => {
    const text = '## Not done\nThe tests pass on CI.\n\n## Done\nThe tests pass locally.';
    const { claims } = extractClaims(text, CTX);
    // The `## Done` heading itself is a done marker (corpus scope block).
    expect(claims.map((c) => [c.kind, c.polarity])).toEqual([
      ['test', 'deferred'],
      ['completion', 'positive'],
      ['test', 'positive'],
    ]);
  });

  it('a `### Remaining` heading defers everything after it without a closing heading', () => {
    const { claims } = extractClaims('### Remaining\n- the tests pass only on Linux\n\nDone with the rest.', CTX);
    expect(claims.map((c) => [c.kind, c.polarity])).toEqual([
      ['test', 'deferred'],
      ['completion', 'deferred'],
    ]);
  });

  it('a deeper heading does not close the scope', () => {
    const text = '## Next steps\n### details\ntests pass\n\n## Status\ntests pass';
    const { claims } = extractClaims(text, CTX);
    expect(claims.map((c) => c.polarity)).toEqual(['deferred', 'positive']);
  });

  it('a bold lead-in scope ends at the next blank-line-separated non-list paragraph', () => {
    const text = '**Next steps:**\n- push the branch\n\nThe exporter is done.';
    const { claims } = extractClaims(text, CTX);
    expect(claims.map((c) => [c.kind, c.polarity])).toEqual([
      ['git', 'deferred'],
      ['completion', 'positive'],
    ]);
  });
});

describe('lead-in lists (§4.7 step 2)', () => {
  it('bullets under a generated/outputs lead-in inherit the create verb', () => {
    const { claims } = extractClaims('**Outputs generated**\n- `outputs/a.csv`\n- `outputs/b.png`', CTX);
    expect(claims.map((c) => [c.verb, c.subject])).toEqual([
      ['create', 'outputs/a.csv'],
      ['create', 'outputs/b.png'],
    ]);
  });

  it('bullets under an updated lead-in inherit update', () => {
    const { claims } = extractClaims('**Files updated:**\n- `src/cli.ts`', CTX);
    expect(claims.map((c) => [c.verb, c.subject])).toEqual([['update', 'src/cli.ts']]);
  });

  it('a "Verified:" lead-in distributes the verb over bullets', () => {
    const { claims } = extractClaims('Verified:\n- ran `pytest` twice\n- `uv build` produces a wheel', CTX);
    expect(claims.map((c) => c.kind).sort()).toEqual(['command', 'verification']);
  });

  it('a blank line ends the lead-in', () => {
    const { claims } = extractClaims('Created:\n\n- `tool.py`', CTX);
    expect(claims).toEqual([]);
  });

  it('a heading with "New files" acts as a create lead-in', () => {
    const { claims } = extractClaims('## New files\n- `docs/schema.md`', CTX);
    expect(claims.map((c) => [c.verb, c.subject])).toEqual([['create', 'docs/schema.md']]);
  });
});
