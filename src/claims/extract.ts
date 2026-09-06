/**
 * Claims extractor (ARCHITECTURE §4.7): runs the §6.1 rule table over a final
 * message's normalised clauses, applies polarity / attribution / scoping cues,
 * the echo check, and per-message dedupe. `explainClaim` backs
 * `--explain-claim` (§5.1).
 *
 * Pure functions: no fs, no env, no wall clock, no ledger access — the ledger
 * paths and echo hashes arrive through the context.
 */
import type { Claim } from '../model/types.js';
import { sha1 } from '../util/hash.js';
import { analyse, blankBackticks } from './text.js';
import { attribution, classify } from './cues.js';
import { RULES, type RuleContext } from './rules.js';

/** Per-turn context for extraction (§4.7 steps 6–7). */
export interface ExtractContext {
  /** Turn index — part of `Claim.id`. */
  turnIndex: number;
  /** `Turn.echoHashes` from the human/skill prompt (never raw prompt text). */
  echoHashes: readonly string[];
  /** Canonical paths the ledger knows about (PATH cases b/d). */
  ledgerPaths: readonly string[];
  /** Session working directory (relative resolution). */
  cwd: string;
}

/** Extraction result: the claims plus scan stats (§5.3). */
export interface ExtractResult {
  claims: Claim[];
  /** Sentences scanned (`stats.sentencesScanned`). */
  sentences: number;
  /** Claims recognised, scored and not (`claims recognized: N`). */
  recognized: number;
}

/** One `--explain-claim` row (§5.1). */
export interface ClaimExplanation {
  rule: string;
  /** Source of the trigger regex that fired. */
  trigger: string;
  /** The polarity cue that decided the claim (empty for plain positive). */
  cue: string;
  clause: string;
  sentence: string;
}

/** An `N/M tests` ratio makes test.pass yield to test.counts (§6.1). */
const RATIO_RE = /\b\d{1,6}\/\d{1,6}\s+tests?\b/iu;

const GLOBAL_CACHE = new Map<RegExp, RegExp>();
/** The same trigger with the `g` flag, cached (triggers are shared data). */
function global(re: RegExp): RegExp {
  let g = GLOBAL_CACHE.get(re);
  if (g === undefined) {
    g = new RegExp(re.source, `${re.flags}g`);
    GLOBAL_CACHE.set(re, g);
  }
  return g;
}

/** Copies the optional claim fields a rule produced onto the claim. */
function assign(claim: Claim, f: Partial<Claim>): void {
  if (f.subject !== undefined) claim.subject = f.subject;
  if (f.fromPath !== undefined) claim.fromPath = f.fromPath;
  if (f.verb !== undefined) claim.verb = f.verb;
  if (f.count !== undefined) claim.count = f.count;
  if (f.ratio !== undefined) claim.ratio = f.ratio;
  if (f.family !== undefined) claim.family = f.family;
  if (f.tool !== undefined) claim.tool = f.tool;
  if (f.op !== undefined) claim.op = f.op;
  if (f.sha !== undefined) claim.sha = f.sha;
  if (f.branch !== undefined) claim.branch = f.branch;
  if (f.remote !== undefined) claim.remote = f.remote;
  if (f.prNumber !== undefined) claim.prNumber = f.prNumber;
  if (f.successPredicate !== undefined) claim.successPredicate = f.successPredicate;
  if (f.explicitVerb !== undefined) claim.explicitVerb = f.explicitVerb;
  if (f.directObject !== undefined) claim.directObject = f.directObject;
}

/** `Claim.id` per the §3 invariant, stable across runs. */
function claimId(turnIndex: number, c: Claim): string {
  return sha1(`${turnIndex}${c.rule}${c.position}${c.kind}${c.subject ?? ''}${c.tool ?? c.op ?? ''}`).slice(0, 8);
}

/** §4.7 step 7 echo check against the turn's human-prompt hashes. */
function isEchoed(c: Claim, echo: ReadonlySet<string>): boolean {
  if (echo.size === 0) return false;
  const clause = c.clause.trim();
  if (clause.length >= 25 && echo.has(sha1(clause))) return true;
  if (c.count !== undefined && echo.has(sha1(String(c.count)))) return true;
  if (c.sha !== undefined && echo.has(sha1(c.sha))) return true;
  return false;
}

interface Detailed {
  claims: Claim[];
  details: { trigger: string; cue: string }[];
  sentences: number;
}

/** Full extraction with per-claim trigger/cue details (explain support). */
function extractDetailed(finalText: string, ctx: ExtractContext): Detailed {
  const { clauses, sentenceCount } = analyse(finalText);
  const ruleCtx: RuleContext = { ledgerPaths: ctx.ledgerPaths, cwd: ctx.cwd };
  const echo = new Set(ctx.echoHashes);
  const claims: Claim[] = [];
  const details: { trigger: string; cue: string }[] = [];
  const byKey = new Map<string, Claim>();
  for (const c of clauses) {
    if (c.question) continue;
    const masked = blankBackticks(c.clause, true);
    const tickless = c.clause.replace(/`/g, ' ');
    const fired = new Set<string>();
    for (const rule of RULES) {
      if (rule.skipIf !== undefined && rule.skipIf.some((id) => fired.has(id))) continue;
      if (rule.skipIfRatio === true && RATIO_RE.test(masked)) continue;
      const view = rule.view === 'raw' ? c.clause : rule.view === 'tickless' ? tickless : masked;
      const seen = new Set<string>();
      for (const trigger of rule.triggers) {
        for (const m of view.matchAll(global(trigger))) {
          const at = m.index ?? 0;
          const built = rule.fields(m, view, ruleCtx);
          if (built === null) continue;
          for (const f of Array.isArray(built) ? built : [built]) {
            const subjectKey = `${f.kind ?? ''}|${f.subject ?? ''}|${f.family ?? ''}|${f.op ?? ''}|${f.verb ?? ''}`;
            if (seen.has(subjectKey)) continue;
            seen.add(subjectKey);
            const cue = classify(c.clause, at, {
              triggerEnd: at + m[0].length,
              consumesNo: rule.consumesNo === true,
              deferredScope: c.deferredScope,
              sentenceStart: c.sentenceStart,
            });
            if (cue.polarity === 'excluded') continue;
            const pol = cue.polarity === 'positive' && f.polarity !== undefined ? f.polarity : cue.polarity;
            const claim: Claim = {
              id: '',
              kind: f.kind ?? rule.kind,
              polarity: pol,
              attribution: attribution(c.clause, at),
              rule: rule.id,
              sentence: c.sentence,
              clause: c.clause,
              position: c.index,
              echoed: false,
            };
            assign(claim, f);
            if (c.partial) claim.partial = true;
            claim.id = claimId(ctx.turnIndex, claim);
            claim.echoed = isEchoed(claim, echo);
            fired.add(rule.id);
            // `sha` is part of the identity: a message citing two different
            // commit shas is two claims, not one (sha-less git claims keep
            // the previous key — the suffix is empty for them).
            const key = `${claim.kind}|${claim.subject ?? ''}|${claim.polarity}|${claim.family ?? claim.op ?? ''}|${claim.sha ?? ''}`;
            const prev = byKey.get(key);
            if (prev === undefined) {
              byKey.set(key, claim);
              claims.push(claim);
              details.push({ trigger: trigger.source, cue: cue.cue });
            } else if (claim.count !== undefined && (prev.count === undefined || claim.count > prev.count)) {
              prev.count = claim.count;
            }
          }
        }
      }
    }
  }
  return { claims, details, sentences: sentenceCount };
}

/**
 * Extracts every claim from a final message (§4.7). Identical
 * `(kind, subject, polarity, family/op, sha)` claims dedupe to one, keeping
 * the max count; `position` is the clause order; ids are stable across runs
 * and unique within a message.
 */
export function extractClaims(finalText: string, ctx: ExtractContext): ExtractResult {
  const { claims, sentences } = extractDetailed(finalText, ctx);
  return { claims, sentences, recognized: claims.length };
}

/**
 * Re-derives the rule, trigger, cue, clause and sentence behind one claim for
 * `--explain-claim` (§5.1). Falls back to the claim's own text when the claim
 * cannot be re-located (foreign text).
 */
export function explainClaim(claim: Claim, text: string): ClaimExplanation {
  const { claims, details } = extractDetailed(text, { turnIndex: 0, echoHashes: [], ledgerPaths: [], cwd: '' });
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i] as Claim;
    if (c.rule === claim.rule && c.position === claim.position && c.kind === claim.kind && (c.subject ?? '') === (claim.subject ?? '')) {
      const d = details[i] as { trigger: string; cue: string };
      return { rule: c.rule, trigger: d.trigger, cue: d.cue, clause: c.clause, sentence: c.sentence };
    }
  }
  return { rule: claim.rule, trigger: '', cue: '', clause: claim.clause, sentence: claim.sentence };
}
