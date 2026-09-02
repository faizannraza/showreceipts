/**
 * S15 — polarity, attribution and exclusion cues (ARCHITECTURE §4.7 step 5):
 * precedence excluded > deferred > negated > positive, double negatives via
 * `consumesNo`, temporal forms, markers, imperatives, attribution; plus the
 * fenced-block / question / temporal acceptance tests through the extractor.
 */
import { describe, expect, it } from 'vitest';
import { attribution, classify, polarity } from '../../../src/claims/cues.js';
import { extractClaims } from '../../../src/claims/extract.js';

const CTX = { turnIndex: 0, echoHashes: [], ledgerPaths: [], cwd: '/repo' };

describe('polarity precedence (excluded > deferred > negated > positive)', () => {
  it('is positive with no cue', () => {
    expect(polarity('the tests pass', 4)).toBe('positive');
  });

  it('negates on a cue before the trigger', () => {
    const clause = "I haven't run the tests";
    expect(polarity(clause, clause.indexOf('run'))).toBe('negated');
  });

  it('negates on a cue inside the trigger span before its predicate', () => {
    const clause = 'the tests are not passing';
    expect(polarity(clause, 4, { triggerEnd: clause.length })).toBe('negated');
  });

  it('defers on a hedge anywhere in the clause', () => {
    const clause = 'the tests should pass';
    expect(polarity(clause, 4)).toBe('deferred');
  });

  it('deferred beats negated (S15 precedence)', () => {
    const clause = 'the tests should not fail';
    expect(polarity(clause, 4, { triggerEnd: clause.length })).toBe('deferred');
  });

  it('excluded beats deferred', () => {
    const clause = 'the tests were already passing before my change';
    expect(polarity(clause, 4, { triggerEnd: clause.indexOf(' before') })).toBe('excluded');
  });

  it('defers under a deferred section scope', () => {
    expect(polarity('tests pass', 0, { deferredScope: true })).toBe('deferred');
  });
});

describe('double negatives (consumesNo)', () => {
  it('a consuming rule resolves "no failing tests" to positive', () => {
    expect(polarity('no failing tests', 0, { triggerEnd: 16, consumesNo: true })).toBe('positive');
  });

  it('the same span without consumesNo stays negated', () => {
    expect(polarity('no failing tests', 0, { triggerEnd: 16 })).toBe('negated');
  });

  it('"nothing changed" is a positive no-change claim, not a negation', () => {
    expect(polarity('nothing changed', 0, { triggerEnd: 15, consumesNo: true })).toBe('positive');
  });

  it('"nothing" before a later trigger still negates', () => {
    const clause = 'nothing is committed';
    expect(polarity(clause, clause.indexOf('committed'))).toBe('negated');
  });

  it('a consumed "without" does not negate check.build ("compiles without warnings")', () => {
    const { claims } = extractClaims('Compiles without warnings.', CTX);
    expect(claims.map((c) => [c.kind, c.polarity])).toEqual([['check', 'positive']]);
  });
});

describe('temporal exclusion (§4.7 step 5)', () => {
  it.each([
    'The tests were already passing before my change.',
    'The tests were green prior to my changes.',
    'Tests were passing before the refactor.',
    'It was committed before my changes.',
  ])('excludes: %s', (text) => {
    expect(extractClaims(text, CTX).claims).toEqual([]);
  });

  it('a distant cue only excludes when it modifies the trigger', () => {
    // "previously", "at the start", "originally" elsewhere never exclude.
    const { claims } = extractClaims('The suite was red previously; now 12 tests pass.', CTX);
    expect(claims.map((c) => [c.kind, c.polarity, c.count])).toEqual([['test', 'positive', 12]]);
  });

  it('classify names the temporal cue', () => {
    const clause = 'the tests were passing before my changes';
    const res = classify(clause, 4, { triggerEnd: clause.indexOf(' before') });
    expect(res.polarity).toBe('excluded');
    expect(res.cue).toContain('temporal');
  });
});

describe('markers', () => {
  it('MARK_BAD negates', () => {
    expect(polarity('❌ tests', 2)).toBe('negated');
  });

  it('MARK_OK stays positive', () => {
    expect(polarity('✅ 41 passed', 2)).toBe('positive');
  });
});

describe('imperatives', () => {
  it('an imperative sentence start defers', () => {
    expect(polarity('Run the tests to be sure', 0)).toBe('deferred');
  });

  it('"Build succeeds" is a claim, not an imperative', () => {
    expect(polarity('Build succeeds', 0)).toBe('positive');
  });

  it('a marker after the word suppresses the imperative reading', () => {
    expect(polarity('Check: ✅ done', 0)).toBe('positive');
  });

  it('is case-sensitive (mid-sentence "run" is not imperative)', () => {
    expect(polarity('the run finished', 4, { sentenceStart: false })).toBe('positive');
  });
});

describe('attribution (§4.7 step 5)', () => {
  it('second-person subject within 6 tokens attributes to other', () => {
    const clause = 'you just pushed the fix';
    expect(attribution(clause, clause.indexOf('pushed'))).toBe('other');
  });

  it('agent subject stays agent', () => {
    const clause = 'I pushed the fix';
    expect(attribution(clause, clause.indexOf('pushed'))).toBe('agent');
  });

  it('CI/bot subjects attribute to other', () => {
    const clause = 'CI reported tests passing';
    expect(attribution(clause, clause.indexOf('tests'))).toBe('other');
  });

  it('a named third party attributes to other', () => {
    const clause = 'Marcus cloned and independently verified the fix';
    expect(attribution(clause, clause.indexOf('verified'))).toBe('other');
  });

  it('capitalised sentence adverbs are not names', () => {
    const clause = 'Manually verified the output';
    expect(attribution(clause, clause.indexOf('verified'))).toBe('agent');
  });

  it('a subject after the trigger does not attribute', () => {
    const clause = 'the tests pass on your machine';
    expect(attribution(clause, clause.indexOf('tests'))).toBe('agent');
  });
});

describe('acceptance cases through the extractor', () => {
  it('"You should run `pytest` to double-check" yields exactly one deferred command claim', () => {
    const { claims } = extractClaims('You should run `pytest` to double-check.', CTX);
    expect(claims).toHaveLength(1);
    // Attribution is recorded independently of the deferred polarity (§4.7
    // step 5): the second-person subject is kept, not forced to 'agent'.
    expect(claims[0]).toMatchObject({ kind: 'command', polarity: 'deferred', subject: 'pytest', attribution: 'other' });
  });

  it('fenced code blocks never produce claims', () => {
    const { claims } = extractClaims('Here it is:\n```bash\ngit push origin main\nnpm test  # 40 passed\n```\n', CTX);
    expect(claims).toEqual([]);
  });

  it('an unclosed fence swallows the rest', () => {
    const { claims } = extractClaims('Output:\n```\nall 99 tests passed', CTX);
    expect(claims).toEqual([]);
  });

  it('questions yield no claims', () => {
    expect(extractClaims('Is the test suite green?', CTX).claims).toEqual([]);
    expect(extractClaims('Did you want me to update `README.md`?', CTX).claims).toEqual([]);
  });

  it('deferred and other-attributed claims keep their kinds', () => {
    const { claims } = extractClaims('Dependabot opened the PR.', CTX);
    expect(claims.map((c) => [c.kind, c.polarity, c.attribution])).toEqual([['git', 'positive', 'other']]);
  });
});
