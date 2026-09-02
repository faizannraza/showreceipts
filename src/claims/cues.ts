/**
 * Polarity, attribution and scoping cues (ARCHITECTURE §4.7 step 5).
 *
 * `polarity(clause, triggerIndex)` classifies one trigger occurrence with the
 * precedence `excluded > deferred > negated > positive` (S15). Rules whose
 * trigger consumes its own `no` (`no failing tests`, `no changes needed`) pass
 * `consumesNo` so the consumed token cannot re-negate the claim — double
 * negatives resolve to positive.
 *
 * Pure functions: no fs, no env, no wall clock.
 */
import { blankBackticks } from './text.js';

/** Positive status markers (leading ✅-family; §4.7 step 1). */
export const MARK_OK_RE = /(?:✅|✔|✓|☑|🟢)️?/u;
/** Negative status markers (leading ❌-family; §4.7 step 1). */
export const MARK_BAD_RE = /(?:❌|✘|✗|✖|🔴|❗)️?/u;

/** Negation cues (§4.7 step 5); a match before the trigger negates the claim. */
export const NEGATION_RE =
  /\b(?:not|never|no|none|nothing|neither|nor|nobody|nowhere|nearly|almost|rather\s+than|instead\s+of|without|unable|cannot|failed\s+to|skipped|skipping|still\s+failing|is\s+failing|are\s+failing)(?![\p{L}\p{N}_])|\b\p{L}+n't(?![\p{L}\p{N}_])/giu;

/** `nothing/none/neither` anywhere in the clause negates every trigger. */
const NOTHING_RE = /\b(?:nothing|none|neither)(?![\p{L}\p{N}_])/giu;

/** Hedge / deferral cues (§4.7 step 5); anywhere in the clause defers the claim. */
export const HEDGE_RE =
  /\b(?:should|would|might|may|could|probably|likely|hopefully|expected\s+to|i\s+expect|i\s+assume|assuming|presumably|i\s+think|i\s+believe|in\s+theory|once\s+you|when\s+you|after\s+you|you\s+can|you\s+should|you'll\s+need|you\s+need\s+to|please\s+run|remember\s+to|for\s+you\s+to|todo|fixme|pending|next\s+steps?|remaining|not\s+yet|yet\s+to|still\s+needs?|to\s+be\s+done|will\s+(?:run|add|do|fix|show)|going\s+to|about\s+to|plan\s+to|next\s+i'll|then\s+i'll|let\s+me\s+know|if|unless|whether|in\s+case|you(?:'ll|\s+will|\s+should)\s+see|should\s+(?:print|show|report|say)|look\s+for)(?![\p{L}\p{N}_])|\b\p{L}+'ll(?![\p{L}\p{N}_])|\bleft\b[^.;]{0,40}?\bfor\s+you\b/giu;

/**
 * Imperative sentence starts (§4.7 step 5) — case-sensitive, and only when the
 * next word is not a finite verb ("Build succeeds" is a claim, "Build it" an
 * instruction).
 */
export const IMPERATIVE_RE =
  /^\s*(Run|Push|Try|Re-?run|Open|Check|Expect|Go(?:\s+to)?|Click|Paste|Send|Post|Commit|Verify|Confirm|Install|Add|Cut|Set|Record|Reproduce|Rebase|Merge|Tag|Build)(?![\p{L}\p{N}_])(?!\s*[:|✅✔✓☑🟢❌✘✗✖🔴❗])(?!\s+(?:is|are|was|were|has|have|had|succeed(?:s|ed)?|pass(?:es|ed)?|works?|worked|compil(?:es|ed)|complet(?:es|ed)|finish(?:es|ed)|runs?|ran|fails?|failed|still|now|also|went)\b)/u;

/**
 * Temporal exclusion forms (§4.7 step 5): the claim describes the state
 * before the agent's changes, so no claim is produced — but only when the cue
 * modifies the trigger (within 3 tokens or the same parenthetical).
 */
export const TEMPORAL_RE =
  /(?:was|were)\s+(?:already\s+)?(?:passing|green|clean|committed|there)\s+before(?![\p{L}\p{N}_])|\bbefore\s+(?:my|these|the)\s+changes?\b|\bprior\s+to\s+(?:my|these)\s+changes\b/giu;

/** Second-party / third-party subjects (§4.7 step 5 attribution). */
const ATTRIB_RE =
  /\b(?:you've|you'd|you|your|the\s+user|dependabot|renovate|ci|github|they|he|she|\w+\[bot\])(?![\p{L}\p{N}_])/giu;

/** Named third-party subject: `Marcus cloned/ran/verified/validated/pushed`. */
const THIRD_PARTY_RE =
  /\b([A-Z][a-z]{2,})\s+(?:(?:independently|also|just|then|already)\s+)?(?:cloned|ran|verified|validated|pushed)(?![\p{L}\p{N}_])/gu;

/** Capitalised sentence-starters that are not names. */
const NAME_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'They', 'She', 'He', 'It', 'We', 'You', 'But', 'And', 'Also', 'Then',
  'Just', 'Already', 'Now', 'First', 'Finally', 'Manually', 'Independently', 'Successfully', 'Everything', 'All',
  'Both', 'Which', 'Who', 'Note', 'Once', 'After', 'Before', 'Tests', 'Test', 'Everyone', 'Nobody',
]);

/** Options refining a `polarity`/`classify` call (all optional). */
export interface CueOptions {
  /** End offset of the trigger match (defaults to `triggerIndex`). */
  triggerEnd?: number;
  /** The rule consumes its own `no` (test.nofail, nochange.marker). */
  consumesNo?: boolean;
  /** Clause sits under a deferring section heading / bold lead-in. */
  deferredScope?: boolean;
  /** Clause opens its sentence (imperative detection; defaults to true). */
  sentenceStart?: boolean;
}

/** A polarity classification plus the cue that produced it (for --explain-claim). */
export interface CueResult {
  polarity: 'positive' | 'negated' | 'deferred' | 'excluded';
  /** Human-readable cue, e.g. `negation "haven't"`; empty for positive. */
  cue: string;
}

/** Whitespace-token count between two offsets. */
function tokensBetween(text: string, from: number, to: number): number {
  if (to <= from) return 0;
  return text.slice(from, to).split(/\s+/).filter((t) => t !== '').length;
}

/** True when [aStart,aEnd) and [bStart,bEnd) overlap or sit ≤ 3 tokens apart. */
function near(text: string, aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (aStart < bEnd && bStart < aEnd) return true;
  const gap = aEnd <= bStart ? tokensBetween(text, aEnd, bStart) : tokensBetween(text, bEnd, aStart);
  return gap <= 3;
}

/** True when both offsets sit inside the same parenthetical. */
function sameParenthetical(text: string, a: number, b: number): boolean {
  const open = text.lastIndexOf('(', Math.min(a, b));
  if (open === -1) return false;
  const close = text.indexOf(')', open);
  return close !== -1 && Math.max(a, b) < close && text.slice(open, Math.min(a, b)).indexOf(')') === -1;
}

/**
 * Classifies one trigger occurrence in a clause and names the deciding cue.
 * Precedence: excluded > deferred > negated > positive (S15).
 */
export function classify(clause: string, triggerIndex: number, opts: CueOptions = {}): CueResult {
  const scan = blankBackticks(clause);
  const end = opts.triggerEnd ?? triggerIndex;
  TEMPORAL_RE.lastIndex = 0;
  for (const m of scan.matchAll(TEMPORAL_RE)) {
    const mEnd = m.index + m[0].length;
    if (near(scan, triggerIndex, end, m.index, mEnd) || sameParenthetical(scan, triggerIndex, m.index)) {
      return { polarity: 'excluded', cue: `temporal "${m[0]}"` };
    }
  }
  if (opts.deferredScope === true) return { polarity: 'deferred', cue: 'section scope' };
  if (opts.sentenceStart !== false) {
    const imp = IMPERATIVE_RE.exec(clause);
    if (imp !== null) return { polarity: 'deferred', cue: `imperative "${imp[1] as string}"` };
  }
  HEDGE_RE.lastIndex = 0;
  const hedge = HEDGE_RE.exec(scan);
  if (hedge !== null) return { polarity: 'deferred', cue: `hedge "${hedge[0]}"` };
  const mark = MARK_BAD_RE.exec(scan);
  if (mark !== null) return { polarity: 'negated', cue: `marker "${mark[0]}"` };
  NEGATION_RE.lastIndex = 0;
  for (const m of scan.matchAll(NEGATION_RE)) {
    // A cue before the trigger's predicate negates ("tests are not passing");
    // one the trigger consumed on purpose does not ("no failing tests",
    // "compiles without warnings" — consumesNo rules).
    const at = m.index ?? 0;
    if (at >= end) continue;
    if (opts.consumesNo === true && at >= triggerIndex) continue;
    return { polarity: 'negated', cue: `negation "${m[0]}"` };
  }
  NOTHING_RE.lastIndex = 0;
  for (const m of scan.matchAll(NOTHING_RE)) {
    // A nothing/none/neither *subject* negates every trigger it precedes or
    // opens — unless the trigger consumes it ("Nothing changed" ⇒ no-change).
    const at = m.index ?? 0;
    if (at >= end) continue;
    const inSpan = at >= triggerIndex && at < end;
    if (!(opts.consumesNo === true && inSpan)) return { polarity: 'negated', cue: `negation "${m[0]}"` };
  }
  return { polarity: 'positive', cue: '' };
}

/**
 * Polarity of a trigger occurrence with the S15 precedence
 * `excluded > deferred > negated > positive` (§4.7 step 5).
 */
export function polarity(clause: string, triggerIndex: number, opts: CueOptions = {}): CueResult['polarity'] {
  return classify(clause, triggerIndex, opts).polarity;
}

/**
 * Attribution of a trigger occurrence: `'other'` when a second-person /
 * third-party subject precedes the trigger within 6 tokens, or a named
 * third-party subject verb phrase points at it (§4.7 step 5) — those claims
 * reconcile as NOT_SCORED (ALSO SAID).
 */
export function attribution(clause: string, triggerIndex: number): 'agent' | 'other' {
  const scan = blankBackticks(clause);
  ATTRIB_RE.lastIndex = 0;
  for (const m of scan.matchAll(ATTRIB_RE)) {
    const mEnd = m.index + m[0].length;
    if (mEnd <= triggerIndex && tokensBetween(scan, mEnd, triggerIndex) < 6) return 'other';
  }
  THIRD_PARTY_RE.lastIndex = 0;
  for (const m of scan.matchAll(THIRD_PARTY_RE)) {
    if (NAME_STOPWORDS.has(m[1] as string)) continue;
    const mEnd = m.index + m[0].length;
    const before = mEnd <= triggerIndex && tokensBetween(scan, mEnd, triggerIndex) <= 6;
    const overlaps = m.index <= triggerIndex && triggerIndex < mEnd;
    if (before || overlaps) return 'other';
  }
  return 'agent';
}
