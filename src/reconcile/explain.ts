/**
 * `--explain-claim` payloads (S17, §5.1): why a sentence became a claim
 * (rule, trigger, cue — re-derived from the final text by the claims
 * extractor) and why it got its verdict (the §4.8 row, the facts the row
 * examined, and a one-line `why`).
 */
import type { Claim, Explanation, Judgement } from '../model/types.js';
import { explainClaim } from '../claims/extract.js';
import { rowNumberFor } from './reconcile.js';

/** Inputs `explain` needs beyond the claim and its judgement. */
export interface ExplainFacts {
  /** The final message the claim came from; without it trigger/cue stay empty. */
  finalText?: string;
  /** Facts the row examined; defaults to the judgement's evidence labels and notes. */
  factsExamined?: readonly string[];
}

/**
 * Builds one `Explanation` (§5.1). `trigger` and `cue` are re-derived by
 * running the claims extractor over `finalText` (empty strings when the text
 * is not provided or the claim cannot be re-located); `row` is the §4.8
 * dispatch row; `why` combines verdict, reason and the judgement text —
 * time-free, like everything else in a `Judgement`.
 */
export function explain(claim: Claim, judgement: Judgement, facts: ExplainFacts = {}): Explanation {
  const located =
    facts.finalText === undefined
      ? { rule: claim.rule, trigger: '', cue: '', clause: claim.clause, sentence: claim.sentence }
      : explainClaim(claim, facts.finalText);
  const factsExamined =
    facts.factsExamined !== undefined ? [...facts.factsExamined] : [...judgement.evidence.map((e) => e.label), ...judgement.notes];
  const why =
    judgement.text === ''
      ? `${judgement.verdict} (${judgement.reason})`
      : `${judgement.verdict} (${judgement.reason}) — ${judgement.text}`;
  return {
    claimId: claim.id,
    sentence: claim.sentence,
    clause: claim.clause,
    rule: claim.rule,
    trigger: located.trigger,
    cue: located.cue,
    polarity: claim.polarity,
    attribution: claim.attribution,
    row: rowNumberFor(claim),
    factsExamined,
    why,
  };
}
