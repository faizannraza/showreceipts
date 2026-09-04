/**
 * S35 — corpus precision/recall per rule is 100 % (ARCHITECTURE §14.3).
 *
 * In-process mirror of `scripts/accuracy.mjs`: every corpus line's
 * expectations are ground truth — a produced claim no expectation matches is
 * a false positive charged to the rule that produced it; an expectation no
 * claim matches is a false negative charged to the expected rule (or the
 * expected kind when the corpus line does not pin a rule). The suite fails
 * with the exact per-rule table entry that dropped below 100 %, so a rule
 * regression is attributable at a glance without running the script.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Claim } from '../../../src/model/types.js';
import { extractClaims } from '../../../src/claims/extract.js';

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
interface RuleScore {
  tp: number;
  fp: number;
  fn: number;
}

const CORPUS_PATH = fileURLToPath(new URL('../../../fixtures/claims/corpus.jsonl', import.meta.url));
const LINES: CorpusLine[] = readFileSync(CORPUS_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as CorpusLine);

/** The `scripts/accuracy.mjs` matcher: kind + polarity exact, rule when given, fields subset. */
function matches(claim: Claim, exp: Expectation): boolean {
  if (claim.kind !== exp.kind) return false;
  if (claim.polarity !== (exp.polarity ?? 'positive')) return false;
  if (exp.rule !== undefined && claim.rule !== exp.rule) return false;
  for (const [key, value] of Object.entries(exp.fields ?? {})) {
    if (JSON.stringify(claim[key as keyof Claim]) !== JSON.stringify(value)) return false;
  }
  return true;
}

/** Scores the whole corpus into a per-rule {tp, fp, fn} map, exactly like the script. */
function scoreCorpus(): { perRule: Map<string, RuleScore>; failures: string[] } {
  const perRule = new Map<string, RuleScore>();
  const bump = (rule: string, key: keyof RuleScore): void => {
    const row = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    row[key] += 1;
    perRule.set(rule, row);
  };
  const failures: string[] = [];
  LINES.forEach((line, i) => {
    const { claims } = extractClaims(line.text, {
      turnIndex: 0,
      echoHashes: [],
      ledgerPaths: line.ledgerPaths ?? [],
      cwd: line.cwd ?? '/repo',
    });
    const used = new Set<number>();
    for (const exp of line.expect) {
      const hit = claims.findIndex((c, j) => !used.has(j) && matches(c, exp));
      if (hit === -1) {
        bump(exp.rule ?? `(${exp.kind})`, 'fn');
        failures.push(`line ${i + 1}: MISSING ${JSON.stringify(exp)} in ${JSON.stringify(line.text.slice(0, 80))}`);
      } else {
        used.add(hit);
        bump((claims[hit] as Claim).rule, 'tp');
      }
    }
    for (const [j, c] of claims.entries()) {
      if (used.has(j)) continue;
      bump(c.rule, 'fp');
      failures.push(
        `line ${i + 1}: EXTRA ${JSON.stringify({ kind: c.kind, polarity: c.polarity, rule: c.rule, subject: c.subject })} in ${JSON.stringify(line.text.slice(0, 80))}`
      );
    }
  });
  return { perRule, failures };
}

describe('corpus precision/recall per rule (mirrors scripts/accuracy.mjs)', () => {
  const { perRule, failures } = scoreCorpus();

  it('the corpus has lines and produces per-rule scores', () => {
    expect(LINES.length).toBeGreaterThanOrEqual(200);
    expect(perRule.size).toBeGreaterThan(0);
  });

  it('every corpus line matches exactly (no MISSING, no EXTRA)', () => {
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('precision and recall are 100 % for every rule', () => {
    const below: string[] = [];
    for (const [rule, { tp, fp, fn }] of [...perRule.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
      const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
      if (precision < 1 || recall < 1) {
        below.push(`${rule}: tp=${tp} fp=${fp} fn=${fn} precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`);
      }
    }
    expect(below, below.join('\n')).toEqual([]);
  });

  it('every scored rule has support (tp > 0) so 100 % is never vacuous', () => {
    const unsupported = [...perRule.entries()].filter(([, s]) => s.tp === 0).map(([rule]) => rule);
    expect(unsupported, `rules with no true positive in the corpus: ${unsupported.join(', ')}`).toEqual([]);
  });
});
