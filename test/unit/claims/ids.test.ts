/**
 * S15 — Claim ids (§3 invariant), dedupe, the echo check (§4.7 step 7) and
 * `explainClaim`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha1 } from '../../../src/util/hash.js';
import { echoHashes } from '../../../src/claims/text.js';
import { explainClaim, extractClaims } from '../../../src/claims/extract.js';

const CTX = { turnIndex: 0, echoHashes: [], ledgerPaths: [], cwd: '/repo' };

describe('Claim.id', () => {
  it('is 8 lowercase hex characters', () => {
    const { claims } = extractClaims('Tests pass.', CTX);
    expect(claims[0]?.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is unique within a message even when the same rule fires repeatedly', () => {
    const text = 'Created `a_one.py`. Created `b_two.py`. Lint is clean; typecheck passes. 12 tests pass.';
    const { claims } = extractClaims(text, CTX);
    expect(claims.length).toBeGreaterThanOrEqual(5);
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
  });

  it('positions follow clause order and distinguish ids of identical rules', () => {
    const { claims } = extractClaims('Created `a_one.py`. Created `b_two.py`.', CTX);
    expect(claims.map((c) => c.rule)).toEqual(['file.verb', 'file.verb']);
    expect(claims[0]?.position).not.toBe(claims[1]?.position);
    expect(claims[0]?.id).not.toBe(claims[1]?.id);
  });

  it('is stable across runs', () => {
    const text = 'Committed and pushed. 44 tests pass, lint clean.';
    const a = extractClaims(text, CTX);
    const b = extractClaims(text, CTX);
    expect(a).toEqual(b);
  });

  it('changes with the turn index', () => {
    const a = extractClaims('Tests pass.', CTX).claims[0]?.id;
    const b = extractClaims('Tests pass.', { ...CTX, turnIndex: 3 }).claims[0]?.id;
    expect(a).not.toBe(b);
  });

  it('gate check claims carry the listed tool, so their ids differ (§3 invariant)', () => {
    // Multiple claims from one clause share rule/position/kind — the id
    // formula's (tool ?? op) term is what keeps them apart.
    const text = 'Full validation gate (pytest, ruff check, mypy, mkdocs build --strict) passed.';
    const { claims } = extractClaims(text, CTX);
    const checks = claims.filter((c) => c.kind === 'check');
    expect(checks.map((c) => c.tool)).toEqual(['ruff check', 'mypy', 'mkdocs build --strict']);
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
  });

  it('is unique within every corpus line (uniqueness asserted over the corpus, §3)', () => {
    const raw = readFileSync(fileURLToPath(new URL('../../../fixtures/claims/corpus.jsonl', import.meta.url)), 'utf8');
    for (const jsonl of raw.split('\n')) {
      if (jsonl.trim() === '') continue;
      const line = JSON.parse(jsonl) as { text: string; ledgerPaths?: string[]; cwd?: string };
      const { claims } = extractClaims(line.text, { ...CTX, ledgerPaths: line.ledgerPaths ?? [], cwd: line.cwd ?? '/repo' });
      const ids = claims.map((c) => c.id);
      expect(new Set(ids).size, `duplicate Claim.id in ${JSON.stringify(line.text)}`).toBe(ids.length);
    }
  });
});

describe('per-message dedupe (§4.7 step 7)', () => {
  it('identical (kind, subject, polarity, family/op) claims collapse to one', () => {
    const { claims } = extractClaims('Lint is clean.\nLint is clean.', CTX);
    expect(claims).toHaveLength(1);
  });

  it('keeps the max count', () => {
    const { claims } = extractClaims('12 tests pass. 40 tests pass.', CTX);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.count).toBe(40);
  });

  it('does not collapse across polarity or family', () => {
    const { claims } = extractClaims('Lint is clean, but the tests are not passing.', CTX);
    expect(claims.map((c) => [c.kind, c.polarity]).sort()).toEqual([
      ['check', 'positive'],
      ['test', 'negated'],
    ]);
  });
});

describe('echo check (§4.7 step 7)', () => {
  it('marks a claim echoed when its count appears in the prompt hashes', () => {
    const prompt = 'Please make sure all 64 tests pass before you stop.';
    const { claims } = extractClaims('All 64 tests still green.', { ...CTX, echoHashes: echoHashes(prompt) });
    expect(claims[0]?.echoed).toBe(true);
  });

  it('marks a claim echoed when its ≥ 25-char clause matches a prompt hash', () => {
    // The agent parrots the user's sentence verbatim — the clause hash matches.
    const sentence = 'The fix is implemented in `src/loop.py`.';
    const { claims } = extractClaims(sentence, { ...CTX, echoHashes: echoHashes(sentence) });
    expect(claims[0]?.echoed).toBe(true);
  });

  it('marks a claim echoed when its sha appears in the prompt', () => {
    const prompt = 'Cherry-pick 1ffc965 onto main and confirm.';
    const { claims } = extractClaims('Committed as `1ffc965`.', { ...CTX, echoHashes: echoHashes(prompt) });
    expect(claims[0]?.echoed).toBe(true);
  });

  it('stays false when the prompt hashes match neither clause, count nor sha', () => {
    const prompt = 'Confirm exactly 999 things work here today, please.';
    const { claims } = extractClaims('All 64 tests still green.', { ...CTX, echoHashes: echoHashes(prompt) });
    expect(claims[0]?.echoed).toBe(false);
  });

  it('stays false with no prompt hashes at all', () => {
    const { claims } = extractClaims('All 64 tests still green.', CTX);
    expect(claims[0]?.echoed).toBe(false);
  });
});

describe('echoHashes()', () => {
  it('hashes long sentences and clauses, counts and shas — never short text', () => {
    const text = 'Make the forty-two widget tests pass, then commit as 9f2c1ab3.\nok';
    const hashes = new Set(echoHashes(text));
    expect(hashes.has(sha1('42'))).toBe(false);
    expect(hashes.has(sha1('9f2c1ab3'))).toBe(true);
    expect(hashes.has(sha1('ok'))).toBe(false);
    expect(hashes.has(sha1('Make the forty-two widget tests pass, then commit as 9f2c1ab3.'))).toBe(true);
  });

  it('hashes counts as standalone tokens', () => {
    const hashes = new Set(echoHashes('exactly 64 tests'));
    expect(hashes.has(sha1('64'))).toBe(true);
  });

  it('is deterministic', () => {
    const text = 'All 12 tests must pass before the release is tagged.';
    expect(echoHashes(text)).toEqual(echoHashes(text));
  });
});

describe('explainClaim (§5.1)', () => {
  it('returns rule, trigger, cue, clause and sentence', () => {
    const text = 'You should run `pytest` to double-check.';
    const claim = extractClaims(text, CTX).claims[0];
    expect(claim).toBeDefined();
    const explained = explainClaim(claim!, text);
    expect(explained.rule).toBe('command.ran');
    expect(explained.trigger).toContain('ran|run');
    expect(explained.cue).toContain('hedge');
    expect(explained.clause).toBe('You should run `pytest` to double-check.');
    expect(explained.sentence).toBe('You should run `pytest` to double-check.');
  });

  it('names the negation cue', () => {
    const text = "I haven't run the tests yet.";
    const claim = extractClaims(text, CTX).claims[0];
    const explained = explainClaim(claim!, text);
    expect(explained.cue).toContain('negation');
  });

  it('falls back to the claim text when it cannot be re-located', () => {
    const claim = extractClaims('Tests pass.', CTX).claims[0]!;
    const explained = explainClaim(claim, 'Entirely different text.');
    expect(explained).toEqual({ rule: claim.rule, trigger: '', cue: '', clause: claim.clause, sentence: claim.sentence });
  });
});
