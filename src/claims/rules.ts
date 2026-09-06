/**
 * The claim rule table (ARCHITECTURE §6.1) as data, in table order. Triggers
 * compile with `iu`; `\b` after a marker alternative is `(?![\p{L}\p{N}_])`
 * (END). `fields` may return one claim, several (one per PATH; test.gate's
 * per-tool checks), or null to reject a match. Pure data — no fs, no env.
 */
import type { Claim, ClaimKind } from '../model/types.js';
import { blankBackticks } from './text.js';
import { findPaths, type PathToken } from './paths.js';

/** `Receipt.rulesVersion`. claims/2 = the two S35 §14.3 demotions (grammar unchanged; see reconcile/rules.ts and docs/accuracy.md). */
export const RULES_VERSION = 'claims/2';

/** Ledger context handed to `fields` for PATH resolution (cases b/d). */
export interface RuleContext { ledgerPaths: readonly string[]; cwd: string; }

/** One row of the §6.1 rule table. */
export interface Rule {
  id: string;
  kind: ClaimKind; // default claim kind; `fields` may override it (check.marker → test)
  triggers: RegExp[]; // tried in order; every match is offered to `fields`
  consumesNo?: boolean; // trigger consumes its own `no` — double negatives resolve positive
  view?: 'raw' | 'tickless'; // 'raw' keeps backticks (command/path capture), 'tickless' blanks only the backtick chars (check rules read code spans); default: whitespace-bearing code spans are opaque (§4.7 step 4)
  skipIf?: string[]; // skip when any of these rules already fired on the clause
  skipIfRatio?: boolean; // yields to test.counts when an `N/M tests` ratio is in the clause
  /** Builds the claim fields; null rejects the match. */
  fields: (m: RegExpMatchArray, clause: string, ctx: RuleContext) => Partial<Claim> | Partial<Claim>[] | null;
  notes: string;
}

// --- shared fragments (§6.1 notation), built once --------------------------
const N = String.raw`\d{1,6}`;
const MARK_OK = String.raw`(?:✅|✔|✓|☑|🟢)️?`;
const MARK_BAD = String.raw`(?:❌|✘|✗|✖|🔴|❗)️?`;
const END = String.raw`(?![\p{L}\p{N}_])`;
const TOOLS_LINT = String.raw`ruff|eslint|flake8|pylint|clippy|golangci-lint|biome|oxlint|rubocop|shellcheck|lint(?:er|ing)?`;
const TOOLS_TYPE = String.raw`mypy(?:\s+--strict|[-\s]strict)?|pyright|tsc|typecheck(?:s|ing)?|type-?checks?`;
const TOOLS_FMT = String.raw`prettier|black|isort|ruff\s+format(?:\s+--check)?|gofmt|rustfmt|cargo\s+fmt|biome\s+format|format(?:ter|ting)?`;
const TOOLS_BUILD = String.raw`(?:npm\s+run\s+|yarn\s+|pnpm\s+|cargo\s+|go\s+|docker\s+|mkdocs\s+|docs\s+|the\s+)build|mkdocs(?:\s+build)?(?:\s+--strict|[-\s]strict)?|webpack|vite\s+build|tsc\s+-b`;
const CLEAN = String.raw`clean|pass(?:es|ed|ing)?|green|ok|succeed(?:s|ed)?|successful(?:ly)?|no\s+(?:errors|issues|warnings|problems)|0\s+(?:errors|problems)|without\s+(?:errors|warnings)|${MARK_OK}`;
const GAP = String.raw`(?:\s+(?:--?[\w-]+|check|run|step|job|output|is|are|was|were|all|and|already|still|now|also|remains?|came\s+back|comes\s+back|→|->|:)){0,4}\s*`;
const CLEAN_END = String.raw`(?=\s*(?:[.,;:!)\]]|(?:on|for|in|with|across|and|again|at)\b|\(|$))`;
// Bounded ({0,6}): the unbounded star was quadratic on adversarial aux runs (ReDoS).
const AUX = String.raw`(?:(?:are|is|were|was|still|now|all|already|should|would|might|may|could|will|can|do|does|did|not|never|probably|likely|hopefully|just|no\s+longer)\s+){0,6}`;

const rx = (src: string): RegExp => new RegExp(src, 'iu');
const INT_RE = /(?<![\w/.])(\d{1,6})(?![\w/.])/u;
/** Claim skeleton with the first standalone integer of `from` as its count. */
const withCount = (kind: ClaimKind, from: string): Partial<Claim> => {
  const m = INT_RE.exec(from);
  return m === null ? { kind } : { kind, count: Number(m[1]) };
};

/** File-verb → WriteFact verb group. */
const VERBS: Record<string, NonNullable<Claim['verb']>> = {
  created: 'create', added: 'create', wrote: 'create', written: 'create', generated: 'create', scaffolded: 'create',
  introduced: 'create', implemented: 'create', extracted: 'create', split: 'create',
  updated: 'update', edited: 'update', modified: 'update', changed: 'update', touched: 'update', fixed: 'update',
  patched: 'update', refactored: 'update', rewrote: 'update', reworked: 'update', 'cleaned up': 'update',
  rewritten: 'update', removed: 'delete', deleted: 'delete', dropped: 'delete', renamed: 'rename', moved: 'rename',
};
const NOT_A_FILE_RE = /\b(?:branch|tag|commit|remote|repo(?:sitor(?:y|ies))?|pull\s+request|PR)\b/i;
const PREPOSITION_RE = /\b(?:from|in|out\s+of|inside)\b/i;

/** One file claim per PATH after a verb (§4.7 step 6; `renamed A to B`). */
function fileClaims(verbWord: string, window: string, ctx: RuleContext): Partial<Claim>[] | null {
  const verb = VERBS[verbWord.toLowerCase().replace(/\s+/g, ' ')] ?? 'update';
  const masked = blankBackticks(window);
  const usable: PathToken[] = [];
  let prevEnd = 0;
  for (const p of findPaths(window, ctx.ledgerPaths)) {
    if (/[.;:]/.test(masked.slice(prevEnd, p.start)) && usable.length > 0) break;
    if (!NOT_A_FILE_RE.test(masked.slice(0, p.start))) usable.push(p);
    prevEnd = p.end;
  }
  const [first, second] = [usable[0], usable[1]];
  if (first === undefined) return null;
  if (verb === 'rename' && second !== undefined && /\b(?:to|into)\b/i.test(masked.slice(first.end, second.start))) {
    return [{ kind: 'file', verb: 'rename', subject: second.display, fromPath: first.display, explicitVerb: true }];
  }
  return usable.map((p) => {
    const direct = !PREPOSITION_RE.test(masked.slice(0, p.start));
    const v = !direct && (verb === 'delete' || verb === 'create') ? 'update' : verb;
    const claim: Partial<Claim> = { kind: 'file', verb: v, subject: p.display, explicitVerb: true };
    if (direct) claim.directObject = true;
    return claim;
  });
}

/** Family for a gate-listed tool (`ruff check` → lint, `mkdocs build` → build). */
function familyOf(tool: string): 'lint' | 'type' | 'build' | 'format' | null {
  if (/format|prettier|black|isort|gofmt|rustfmt/i.test(tool)) return 'format';
  if (/mypy|pyright|tsc\b|typecheck|type-?check/i.test(tool)) return 'type';
  if (/build|mkdocs|webpack|vite/i.test(tool)) return 'build';
  if (/ruff|eslint|flake8|pylint|clippy|golangci|biome|oxlint|rubocop|shellcheck|lint/i.test(tool)) return 'lint';
  return null;
}
const checkTool = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').replace(/(?<!-)[-\s]strict$/, ' --strict').replace(/^typechecks$/, 'typecheck').trim();
const checkFields = (family: 'lint' | 'type' | 'build' | 'format') => (m: RegExpMatchArray): Partial<Claim> => ({
  kind: 'check', family, tool: checkTool(m[1] ?? /^[\w-]+/.exec(m[0])?.[0] ?? family),
});
const SUCCESS_RE = /\b(?:successfully|passes|works|clean|ok)\b/i;
const BAD_SUBJECT_RE = /^(?:\d+|a|an|the|it|this|that|them|these|those|in|on|at|to|for|with|as|and|or|one|two|three)$/i;
const AGENTISH_RE = /\b(?:i|i've|we|we've|not|never|nothing|none)(?![\p{L}\p{N}_])|n't(?![\p{L}\p{N}_])/iu;

/** The §6.1 rule table, in table order. */
export const RULES: readonly Rule[] = [
  { id: 'test.pass', kind: 'test', skipIfRatio: true, triggers: [
      rx(String.raw`\b(?:all\s+)?(?:the\s+)?(?<!\d/)(?:${N}\s+)?(?:unit\s+|integration\s+|e2e\s+)?tests?\s+${AUX}(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)${END}`),
      rx(String.raw`\btest\s+suite\s+(?:(?:is|was|were)\s+(?:now\s+|already\s+|not\s+)?)?(?:green|passing|clean)${END}`),
      rx(String.raw`\btest\s+suite\s+passes`),
      rx(String.raw`\b(?:everything|all)\s+(?:is\s+)?(?:passing|green)${END}`),
    ], fields: (m) => withCount('test', m[0]), notes: 'Rows 1–2; yields to test.counts when an N/M ratio is in the clause.' },
  { id: 'test.counts', kind: 'test', triggers: [
      rx(String.raw`(?<![\d/])(?<!\bof\s)(${N})\s+(?:tests?\s+)?(?:passed|passing)${END}`),
      rx(String.raw`\b(${N})/(${N})\s+tests?`),
      rx(String.raw`\b(${N})\s+tests?,\s+0\s+failures?`),
      rx(String.raw`${MARK_OK}\s*(${N})\s+passed`),
    ], fields: (m) => {
      if (m[2] === undefined) return { kind: 'test', count: Number(m[1]) };
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a === b ? { kind: 'test', count: a } : { kind: 'test', ratio: [a, b], polarity: 'negated' };
    }, notes: 'Row 2; equal ratio ⇒ positive count, short ratio ⇒ negated.' },
  { id: 'test.gate', kind: 'test', view: 'tickless', triggers: [
      rx(String.raw`\b(?:full\s+)?validation\s+gate\b[^.;]{0,140}?\b(?:passed|pass(?:es)?|green|clean)${END}`),
    ], fields: (m) => {
      const count = /\((\d{1,6})\s+tests?/iu.exec(m[0])?.[1];
      const claims: Partial<Claim>[] = [count === undefined ? { kind: 'test' } : { kind: 'test', count: Number(count) }];
      const inner = /\(([^)]+)\)/.exec(m[0])?.[1];
      if (inner !== undefined) {
        for (const item of inner.split(/,\s*/)) for (const part of item.split('/')) {
          const family = familyOf(part.trim());
          if (family !== null) claims.push({ kind: 'check', family, tool: checkTool(part.trim()) });
        }
      }
      return claims;
    }, notes: 'Row 1; one check claim per listed tool, count from `(N tests`.' },
  { id: 'test.count_clean', kind: 'test', triggers: [
      rx(String.raw`(?<![\d/])\b(${N})\s+tests?\b(?:\s*\([^)]{0,40}\))?(?=[^.;]{0,80}\b(?:${CLEAN})${END})`),
    ], fields: (m) => ({ kind: 'test', count: Number(m[1]) }), notes: 'Rows 1–2; "345 tests, typecheck and lint clean".' },
  { id: 'test.ran', kind: 'test-ran', triggers: [
      rx(String.raw`\b(?:ran|run|re-?ran|re-?run|running|executed|kicked\s+off)\s+(?:(?:the|all|full|a|any|my|our)\s+){0,2}(?:test\s+suite|tests?|pytest|vitest|jest|specs?|unit\s+tests)${END}`),
      rx(String.raw`\btests?\s+to\s+run\b`),
      rx(String.raw`\btest(?:ed)?\s+(?:it|this|that|them|anything|locally|here)${END}`),
    ], fields: () => ({}), notes: 'Row 3.' },
  { id: 'test.nofail', kind: 'test', consumesNo: true, triggers: [
      rx(String.raw`\bno\s+(?:failing|failed|broken|red)\s+tests?`), rx(String.raw`\bzero\s+failures?`),
      rx(String.raw`\b0\s+failed\b`), rx(String.raw`\bwithout\s+(?:any\s+)?(?:test\s+)?failures?`),
    ], fields: () => ({}), notes: 'Row 1; consumes its own "no".' },
  { id: 'test.green_marker', kind: 'test', triggers: [
      rx(String.raw`^\s*(?:${MARK_OK})?\s*(?:all\s+)?green\s*(?:${MARK_OK})?\s*[.!]?\s*$`),
    ], fields: () => ({}), notes: 'Row 1; "All green ✅" standalone.' },
  { id: 'test.added', kind: 'test-added', triggers: [
      rx(String.raw`\b(?:added|wrote|created|introduced|implemented)\s+(?:${N}\s+)?(?:new\s+|more\s+)?(?:unit\s+|integration\s+|e2e\s+|regression\s+)?tests?(?:\s+cases?)?${END}`),
    ], fields: (m) => withCount('test-added', m[0]), notes: 'Row 4.' },
  { id: 'check.lint', kind: 'check', view: 'tickless', consumesNo: true, triggers: [
      rx(String.raw`\b(${TOOLS_LINT})${END}${GAP}(?:${CLEAN})${CLEAN_END}`),
      rx(String.raw`\b(?:clean|passing)\s+(${TOOLS_LINT})${END}`),
      rx(String.raw`\b(lint|ruff|eslint)\s*[:：]?\s*(?:${MARK_OK}|passed|ok)${END}`),
    ], fields: checkFields('lint'), notes: 'Rows 5–6.' },
  { id: 'check.type', kind: 'check', view: 'tickless', consumesNo: true, triggers: [
      rx(String.raw`\b(${TOOLS_TYPE})${END}${GAP}(?:${CLEAN})${CLEAN_END}`),
      rx(String.raw`\b(?:clean|passing)\s+(${TOOLS_TYPE})${END}`),
    ], fields: checkFields('type'), notes: 'Rows 5–6; `mypy --strict` keeps `--strict`.' },
  { id: 'check.format', kind: 'check', view: 'tickless', consumesNo: true, triggers: [
      rx(String.raw`\b(${TOOLS_FMT})${END}${GAP}(?:${CLEAN})${CLEAN_END}`),
      rx(String.raw`\b(?:clean|passing)\s+(${TOOLS_FMT})${END}`),
      rx(String.raw`\b(?:code|files?|everything|tree|it)\s+(?:is|are|was|were)\s+formatted\b`),
      rx(String.raw`\bformatted\s+(?:with|via|using)\s+(\w+)`),
      rx(String.raw`\bformat(?:ting)?\s+(?:check\s+)?(?:is\s+)?(?:${CLEAN})${END}`),
    ], fields: checkFields('format'), notes: 'Row 5.' },
  { id: 'check.build', kind: 'check', view: 'tickless', consumesNo: true, triggers: [
      rx(String.raw`\b(${TOOLS_BUILD})${END}${GAP}(?:${CLEAN})${CLEAN_END}`),
      rx(String.raw`^\s*(build)${END}${GAP}(?:${CLEAN})${CLEAN_END}`),
      rx(String.raw`\b(?:it|code|project|everything|tree|package|crate|module|app|build)\s+compiles\b`),
      rx(String.raw`\bcompiles\s+(?:cleanly|fine|ok|without\s+(?:errors|warnings)|successfully|again)${END}`),
      rx(String.raw`\b(mkdocs|docs)\s+build[^.;:]{0,20}(?:${CLEAN})`),
    ], fields: (m) => {
      const tool = /(mkdocs|webpack|vite|tsc|cargo|docker|compiles?)/i.exec(m[0])?.[1] ?? 'build';
      return { kind: 'check', family: 'build', tool: checkTool(tool.replace(/compiles?/i, 'build')) };
    }, notes: 'Row 5; imperative/modal "Build …" is deferred by the cue rules.' },
  { id: 'check.marker', kind: 'check', view: 'tickless', triggers: [
      rx(String.raw`\b(lint|typecheck|types|build|format|tests?)\b\s*[:|]?\s*(?:${MARK_OK}|${MARK_BAD}|passed|ok|clean)${END}`),
      rx(String.raw`^\s*(?:${MARK_OK}|${MARK_BAD})\s*(lint|typecheck|types|build|format|tests?)${END}`),
    ], fields: (m) => {
      const word = (m[1] as string).toLowerCase();
      if (word.startsWith('test')) return { kind: 'test' };
      return { kind: 'check', family: word === 'types' || word === 'typecheck' ? 'type' : (word as 'lint' | 'build' | 'format'), tool: word };
    }, notes: 'Rows 1/5; "lint ✅, typecheck ✅"; a leading marker with a bare status word.' },
  { id: 'file.verb', kind: 'file', view: 'raw', triggers: [
      rx(String.raw`(?<=^|\b(?:i|i've|we|we've|and|also|then|now|just)\s|[,—:]\s|[,—:])(?<!\b(?:a|an|the|this|that|each|every|any|some|one|newly|previously)\s)(?<!hand-)(?<!\bun)(created|added|wrote|written|generated|scaffolded|introduced|updated|edited|modified|changed|touched|fixed|patched|refactored|rewrote|reworked|cleaned\s+up|removed|deleted|dropped|renamed|moved|extracted|implemented|split)\b`),
      rx(String.raw`\b(?:was|is|has\s+been|have\s+been|were)\s+(created|added|updated|edited|modified|changed|fixed|removed|deleted|renamed|moved|rewritten)\b`),
    ], fields: (m, clause, ctx) => {
      const scan = blankBackticks(clause);
      if (/\balready\b/i.test(scan) || /\b(?:you|your|the\s+user)(?![\p{L}\p{N}_])/iu.test(scan)) return null;
      const at = m.index ?? 0;
      if (/^(?:was|is|has|have|were)/i.test(m[0])) {
        const pre = clause.slice(0, at);
        const p = findPaths(pre, ctx.ledgerPaths).filter((t) => /^[^.;:]{0,40}$/.test(blankBackticks(pre.slice(t.end)))).pop();
        if (p === undefined) return null;
        return { kind: 'file', verb: VERBS[(m[1] as string).toLowerCase()] ?? 'update', subject: p.display, explicitVerb: false };
      }
      return fileClaims(m[1] as string, clause.slice(at + m[0].length, at + m[0].length + 120), ctx);
    }, notes: 'Rows 7–10; one claim per PATH; `renamed A to B` ⇒ subject B, fromPath A; excluded with "already" or a you/your/the-user subject.' },
  { id: 'file.implemented_in', kind: 'file', view: 'raw', triggers: [
      rx(String.raw`\b(?:is|was|are|were|been|now|i|i've|we|we've|and)\s+(?:implemented|added|defined)\s+in\s+`),
    ], fields: (m, clause, ctx) => {
      const at = (m.index ?? 0) + m[0].length;
      const p = findPaths(clause.slice(at, at + 90), ctx.ledgerPaths)[0];
      return p === undefined ? null : { kind: 'file', verb: 'update', subject: p.display };
    }, notes: 'Row 8; UNVERIFIED-only, requires an agent-verb clause.' },
  { id: 'file.count', kind: 'file-count', triggers: [
      rx(String.raw`\b(${N})\s+files?\s+(?:changed|modified|updated|touched|edited|created|added)${END}`),
    ], fields: (m) => ({ kind: 'file-count', count: Number(m[1]) }), notes: 'Row 11.' },
  { id: 'file.new_file', kind: 'file', view: 'raw', triggers: [
      rx(String.raw`\bnew\s+(?:file|module|test\s+file|component|script|package)\s*[:,]?\s*`),
    ], fields: (m, clause, ctx) => {
      const at = (m.index ?? 0) + m[0].length;
      const p = findPaths(clause.slice(at, at + 90), ctx.ledgerPaths)[0];
      return p === undefined ? null : { kind: 'file', verb: 'create', subject: p.display };
    }, notes: 'Row 7.' },
  { id: 'command.ran', kind: 'command', view: 'raw', triggers: [
      rx(String.raw`\b(?:ran|run|re-?ran|re-?run|running|executed|invoked|launched|kicked\s+off)\s+\x60([^\x60]{1,120})\x60`),
    ], fields: (m, clause) => {
      const claim: Partial<Claim> = { kind: 'command', subject: (m[1] as string).trim() };
      if (SUCCESS_RE.test(blankBackticks(clause))) claim.successPredicate = true;
      return claim;
    }, notes: 'Row 12.' },
  { id: 'command.ran_bare', kind: 'command', triggers: [
      rx(String.raw`\b(?:ran|run|running|executed)\s+(?:the\s+)?(migrations?|build|linter|formatter|script|smoke\s+test|benchmark|command)${END}`),
      rx(String.raw`\b(migrations?|build|linter|formatter|script|smoke\s+test|benchmark)\b[^.;:]{0,30}\bfor\s+you\s+to\s+run\b`),
    ], fields: (m) => ({ kind: 'command', subject: (m[1] as string).toLowerCase().replace(/\s+/g, ' ') }), notes: 'Row 13.' },
  { id: 'install.pkg', kind: 'install', view: 'raw', skipIf: ['test.added'], triggers: [
      rx(String.raw`\b(installed|added|pulled\s+in)\s+(?:the\s+)?(?:\x60([^\x60\s]+)\x60|((?:@[\w-]+/)?[\w.-]+(?:@[\w.^~-]+)?))\s+(?:as\s+(?:a\s+)?)?(?:dev\s+|peer\s+|optional\s+)?(?:dependency|dependencies|dep|deps|package|packages|plugin|library)${END}`),
      rx(String.raw`\b(?:npm|pnpm|yarn|bun|pip|uv|cargo|go|gem|composer|brew)\s+(?:install|add|i)\b[^.;:\x60]{0,40}\x60(\S[^\x60]{0,80})\x60`),
    ], fields: (m) => {
      const subject = (m.length === 2 ? m[1] : m[2] ?? m[3])?.trim();
      if (subject === undefined || subject === '' || BAD_SUBJECT_RE.test(subject)) return null;
      if (m.length > 2 && !/^added/i.test(m[1] as string) && m[3] !== undefined && !subject.includes('@')) return null;
      return { kind: 'install', subject };
    }, notes: 'Row 14; bare nouns only for "added", name@version/@scope for "installed".' },
  { id: 'git.commit', kind: 'git', view: 'raw', triggers: [
      rx(String.raw`(?<!\b(?:a|an|the|this|that|each|every|all|both|your|my|its|their|previously|already|\d+|nine|ten)\s)(?<!hand-)(?<!\bun)\bcommitted\b(?!\s+(?:evidence|artifact|file|fixture|trace|scenario|run|snapshot|recording|version|history|data|baseline|set|transcript|screenshot)s?\b)`),
      rx(String.raw`\bmade\s+(?:a|the|${N})\s+commits?\b`),
      rx(String.raw`\bcommits?\s+(?:is|are)\s+in\b`),
      rx(String.raw`\bcommit\b(?!\s+(?:message|history|hash|sha|body|trailer|log)s?\b)`),
    ], fields: (m, clause) => {
      if (/^commits?$/i.test(m[0]) && !AGENTISH_RE.test(blankBackticks(clause))) return null;
      const sha = /\b(?:commit(?:ted)?|as|at|\()\s*\x60?([0-9a-f]{7,40})(?![\w.])/i.exec(clause)?.[1];
      return sha === undefined ? { kind: 'git', op: 'commit' } : { kind: 'git', op: 'commit', sha };
    }, notes: 'Row 15; the bare verb needs an agent/negation subject; sha from the clause.' },
  { id: 'git.push', kind: 'git', view: 'raw', triggers: [
      rx(String.raw`\b(?:pushed|push)\b(?=\s*(?:to\b|it\b|up\b|the\s+(?:commit|branch|tag|fix|change)s?\b|\x60|origin\b|\(|,|\.|—|and\b|$))(?!\s+(?:across|the\s+conversation|back|through|for|on|down)\b)`),
      rx(String.raw`\bis\s+on\s+\x60?origin/[\w./-]+\x60?`),
    ], fields: (m, clause) => {
      if (m[0] === 'Push' && (m.index ?? 0) === 0) return null;
      const claim: Partial<Claim> = { kind: 'git', op: 'push' };
      const o = /\b(?:to|on)\s+\x60?(origin|upstream)\/([\w./-]*[\w/-])/i.exec(clause);
      if (o !== null) {
        claim.remote = (o[1] as string).toLowerCase();
        claim.branch = o[2] as string;
      }
      return claim;
    }, notes: 'Row 16; sentence-initial imperative "Push …" is a request, not a claim.' },
  { id: 'git.pr', kind: 'git', triggers: [
      rx(String.raw`\b(?:opened|created|raised|submitted|filed)\s+(?:a\s+|the\s+)?(?:pull\s+request|PR)\b(?:\s*#?(${N}))?`),
    ], fields: (m) => (m[1] === undefined ? { kind: 'git', op: 'pr' } : { kind: 'git', op: 'pr', prNumber: Number(m[1]) }), notes: 'Row 17; a bare "PR #N" is not a claim.' },
  { id: 'git.branch', kind: 'git', view: 'raw', triggers: [
      rx(String.raw`\b(?:created|checked\s+out|switched\s+to)\s+(?:a\s+)?(?:new\s+)?branch\s+\x60?([\w./-]+)\x60?`),
    ], fields: (m) => ({ kind: 'git', op: 'branch', branch: (m[1] as string).replace(/[.,;:!?]+$/, '') }), notes: 'Row 18.' },
  { id: 'git.tag', kind: 'git', view: 'raw', triggers: [
      rx(String.raw`(?<![\w-])(?:tagged|created\s+(?:the\s+)?tag|cut\s+(?:a\s+|the\s+)?tag|pushed\s+(?:the\s+)?tag)\s+(?:the\s+)?(?:release\s+|commit\s+|it\s+as\s+)?\x60?(v?\d+(?:\.\d+)+[\w.-]*)\x60?`),
    ], fields: (m) => ({ kind: 'git', op: 'tag', subject: (m[1] as string).replace(/[.,;:!?]+$/, '') }), notes: 'Row 18.' },
  { id: 'nochange.marker', kind: 'no-change', consumesNo: true, view: 'raw', triggers: [
      rx(String.raw`\bno\s+(?:code\s+)?changes?\b(?:\s+(?:to|in)\s+\S{1,60})?\s+(?:were\s+|was\s+)?(?:needed|required|necessary|made)\b`),
      rx(String.raw`\bnothing\s+(?:to\s+change|changed|needed\s+changing)\b`),
      rx(String.raw`\bleft\s+(?:the\s+)?(?:code|files?)\s+(?:as\s+is|untouched|unchanged)\b`),
    ], fields: (m, _clause, ctx) => {
      const p = findPaths(m[0], ctx.ledgerPaths)[0];
      return p === undefined ? { kind: 'no-change' } : { kind: 'no-change', subject: p.display };
    }, notes: 'Row 21; consumes its own "no"; PATH captured when present.' },
  { id: 'verify.generic', kind: 'verification', triggers: [
      rx(String.raw`(?:^|\b(?:i|i've|we|we've|and|also|then|now|everything|all|both|each|which|that|it|this|fix\s*#?\d+|\w+\s+is|\w+\s+are)\s+)(?:(?:was|were|is|are|has\s+been|have\s+been|got|just|also|then|now|independently)\s+){0,6}(?:re-)?(?:verified|validated|confirmed|double-checked|sanity-checked|smoke-tested)${END}(?!\s+(?:email|bug|findings?|context|numbers?|claims?|account|commit|badge|token|user|file|tour|copy|source|data|example|by\s+(?:the\s+)?(?:brief|docs?|user|reviewer|provider|maintainer|community)))`),
      rx(String.raw`\b(?:tested\s+(?:it\s+)?(?:manually|locally|end-to-end|by\s+hand)|manually\s+tested|works?\s+as\s+expected|working\s+(?:correctly|as\s+intended|end-to-end)|confirmed\s+(?:live|working))${END}`),
      rx(String.raw`\b(?:should|would|might|may|could|will)\s+(?:now\s+|all\s+|just\s+)?works?${END}(?!\s+(?:by|like|around|through)\b)`),
    ], fields: () => ({}), notes: 'Row 19; never CONTRADICTED; modal "should work" defers via the cue rules.' },
  { id: 'verify.with_cmd', kind: 'verification', view: 'raw', triggers: [
      rx(String.raw`\b(?:verified|confirmed|checked)\s+(?:with|via|using|by\s+running)\s+\x60([^\x60]+)\x60`),
    ], fields: (m) => [
      { kind: 'verification' },
      { kind: 'command', subject: (m[1] as string).trim(), successPredicate: true },
    ], notes: 'Row 20; yields a verification and a command claim.' },
  { id: 'done.marker', kind: 'completion', triggers: [
      rx(String.raw`^\s*(?:done|all\s+done|both\s+done|completed?|finished|shipped|that's\s+it)\b(?!\s+(?:when|once|if|for\s+runs))`),
      rx(String.raw`\b(?:it|this|that|everything|all|the\s+\w+(?:\s+\w+){0,3}|phase\s*\w+|step\s*\w+|m\d|fix\s*#?\d+|task\s*\w+|item\s*\w+|milestone\s*\w+)\s+(?:is|are)\s+(?:now\s+)?(?:done|complete|finished|in\s+place)${END}(?!\s*(?:when|once|if|for)\b)`),
      rx(String.raw`\b(?:all\s+)?(?:\d+\s+)?(?:items?|tasks?|steps?|fixes)\s+(?:are\s+)?done\b`),
      rx(String.raw`\bis\s+ready\s+to\s+(?:ship|merge|submit|send|release|publish)\b`),
    ], fields: () => ({}), notes: 'Row 22; never matches inside backticks; "ready for review" is excluded.' },
];
