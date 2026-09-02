/**
 * S15 — the labelled claims corpus is ground truth (ARCHITECTURE §6.2):
 * every expected claim is produced with matching kind/polarity/fields and
 * nothing extra, on every one of the ≥ 200 lines; `sentences()` agrees with
 * `scripts/lib/sentences.mjs` over every corpus text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Claim } from '../../../src/model/types.js';
import { extractClaims } from '../../../src/claims/extract.js';
import { sentences } from '../../../src/claims/text.js';

interface Expectation {
  kind: Claim['kind'];
  polarity?: Claim['polarity'];
  rule?: string;
  fields?: Record<string, unknown>;
}
interface CorpusLine {
  text: string;
  expect: Expectation[];
  tags?: string[];
  ledgerPaths?: string[];
  cwd?: string;
}

const CORPUS_PATH = fileURLToPath(new URL('../../../fixtures/claims/corpus.jsonl', import.meta.url));
const LINES: CorpusLine[] = readFileSync(CORPUS_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as CorpusLine);

function run(line: CorpusLine): ReturnType<typeof extractClaims> {
  return extractClaims(line.text, {
    turnIndex: 0,
    echoHashes: [],
    ledgerPaths: line.ledgerPaths ?? [],
    cwd: line.cwd ?? '/repo',
  });
}

/** The accuracy matcher: kind + polarity exact, rule when given, fields subset. */
function matches(claim: Claim, exp: Expectation): boolean {
  if (claim.kind !== exp.kind) return false;
  if (claim.polarity !== (exp.polarity ?? 'positive')) return false;
  if (exp.rule !== undefined && claim.rule !== exp.rule) return false;
  for (const [key, value] of Object.entries(exp.fields ?? {})) {
    if (JSON.stringify(claim[key as keyof Claim]) !== JSON.stringify(value)) return false;
  }
  return true;
}

describe('fixtures/claims/corpus.jsonl', () => {
  it('has at least 200 lines and the required category coverage', () => {
    expect(LINES.length).toBeGreaterThanOrEqual(200);
    const tag = (t: string): number => LINES.filter((l) => l.tags?.includes(t)).length;
    expect(tag('spec')).toBe(58); // every §6.2 row
    expect(tag('cue')).toBeGreaterThanOrEqual(40); // negation/hedge variants
    expect(tag('marker')).toBeGreaterThanOrEqual(20); // table/marker lines
    expect(tag('path')).toBeGreaterThanOrEqual(20); // path variants
    expect(tag('git')).toBeGreaterThanOrEqual(15);
    expect(tag('temporal')).toBeGreaterThanOrEqual(10);
    expect(tag('codex')).toBeGreaterThanOrEqual(10); // curly quotes / # Context
    expect(LINES.filter((l) => l.expect.length === 0).length).toBeGreaterThanOrEqual(15); // distractors
  });

  it('every expected claim is produced and nothing extra (100 %)', () => {
    const problems: string[] = [];
    for (const [i, line] of LINES.entries()) {
      const { claims } = run(line);
      const used = new Set<number>();
      for (const exp of line.expect) {
        const hit = claims.findIndex((c, j) => !used.has(j) && matches(c, exp));
        if (hit === -1) problems.push(`line ${i + 1}: missing ${JSON.stringify(exp)} in ${JSON.stringify(line.text)}`);
        else used.add(hit);
      }
      for (const [j, c] of claims.entries()) {
        if (!used.has(j)) problems.push(`line ${i + 1}: extra ${c.rule}/${c.kind}/${c.polarity} in ${JSON.stringify(line.text)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('reports recognized = claims.length and a positive sentence count', () => {
    for (const line of LINES) {
      const result = run(line);
      expect(result.recognized).toBe(result.claims.length);
      expect(result.sentences).toBeGreaterThan(0);
    }
  });

  it('sentences() agrees with scripts/lib/sentences.mjs over every corpus text', async () => {
    const mod = (await import(
      new URL('../../../scripts/lib/sentences.mjs', import.meta.url).href
    )) as { splitSentences: (text: string) => string[] };
    for (const line of LINES) {
      expect(sentences(line.text), JSON.stringify(line.text)).toEqual(mod.splitSentences(line.text));
    }
  });
});
