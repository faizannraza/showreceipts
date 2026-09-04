/**
 * Receipt composition (ARCHITECTURE §5.2, S18): claims (S15) → judgements
 * (S17) → worst-first CLAIMED/EVIDENCE lines, ALSO SAID, ALSO DID, stats,
 * cost (S16 — session-level for the receipt cost line, per-turn onto
 * `Turn.costUsd`), verdict and counts, the timeline and explanations on
 * demand, and the `--hash-paths` final pass. Everything here runs
 * post-cache: prices, rules and `--as-of` never invalidate a parse.
 *
 * Renderer discipline: no widths, no glyph characters — `ReceiptLine.glyph`
 * is semantic (`ok|bad|unk|said`), evidence strings carry UTC clocks from
 * `EvidenceRef.at`, and ALSO DID texts are time-free (their refs carry the
 * instants). The Codex stdin wording ("interactive input", "interrupted by
 * Ctrl-C") is composed here from the structured facts (W1 merge note).
 */
import type {
  Claim,
  Cost,
  EvidenceRef,
  Judgement,
  Receipt,
  ReceiptLine,
  Session,
  ToolCall,
  Turn,
  UsageRow,
  Verdict,
  WriteFact,
} from '../model/types.js';
import { HARNESS_LABELS } from '../model/types.js';
import { RESULT_TEXT_CAP, truncateBytes } from '../cache/cache.js';
import { extractClaims, type ExtractResult } from '../claims/extract.js';
import { RULES_VERSION } from '../claims/rules.js';
import { priceClaudeCode, priceCodex, type CodexCostOpts, type CostOpts } from '../cost/cost.js';
import type { PriceTable } from '../cost/resolve.js';
import { filesChangedEligible } from '../ledger/writes.js';
import { evidenceLabel, evidenceStrings, makeRef, type EvidenceFormat } from '../reconcile/evidence.js';
import { explain } from '../reconcile/explain.js';
import { reconcile } from '../reconcile/reconcile.js';
import { RECONCILE_RULES_VERSION } from '../reconcile/rules.js';
import { hashStrings } from '../util/hashpaths.js';
import { stableStringify } from '../util/json.js';
import { maskSecrets } from '../util/mask.js';
import { basename, displayPath, isUnder } from '../util/paths.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { calendarDaysBetween, parseIso } from '../util/time.js';
import { TOOL_VERSION } from '../version.js';
import { buildTimeline } from './timeline.js';

/** `Receipt.rulesVersion`: the claim rules and the reconcile table together. */
export const RECEIPT_RULES_VERSION = `${RULES_VERSION}+${RECONCILE_RULES_VERSION}`;

/** ALSO SAID cap (§5.2). */
const ALSO_SAID_MAX = 3;
/** ALSO DID cap before `+N more` (§5.2). */
const ALSO_DID_MAX = 6;
/** Danger lines inside ALSO DID (§4.6.8). */
const DANGER_MAX = 3;
/** File lists switch to directory grouping above this (§5.2). */
const FILE_LIST_MAX = 6;

export interface ReceiptOptions {
  /** Turn to compose for; default: the last done turn (§5.2). */
  turnIndex?: number | undefined;
  /** The command clock (`ctx.now`); receipts contain no generated-at, but the option keeps call sites uniform. */
  now: Date;
  /** `--as-of YYYY-MM-DD` (§8): prices resolve at that date. */
  asOf?: string | undefined;
  /** The effective price table (built-in ← override ← `--prices`). */
  prices: PriceTable;
  /** The `--hash-paths` salt; a non-empty value turns the §11.2 pass on. */
  hashPaths?: string | undefined;
  /** The user's home directory (display forms of out-of-repo paths). */
  homeDir: string;
  /** Build `Receipt.timeline`. */
  timeline?: boolean | undefined;
  /** Build `Receipt.explanations` (`--explain-claim`). */
  explain?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Turn selection and extraction
// ---------------------------------------------------------------------------

/** Per-session memo of claim extraction (keyed by turn index) — sessions are stable within a run. */
const EXTRACTIONS = new WeakMap<Session, Map<number, ExtractResult>>();

/** Canonical paths the ledger knows about (claims PATH cases b/d). */
function ledgerPathsOf(session: Session): string[] {
  const paths = new Set<string>(session.ledger.filesChanged);
  for (const w of session.ledger.writes) paths.add(w.path);
  return [...paths];
}

/** Extraction for one turn, memoised; `null` when the turn has no final text. */
function extractFor(session: Session, turn: Turn): ExtractResult | null {
  if (turn.finalText === null || turn.finalText === '') return null;
  let map = EXTRACTIONS.get(session);
  if (map === undefined) {
    map = new Map();
    EXTRACTIONS.set(session, map);
  }
  let result = map.get(turn.index);
  if (result === undefined) {
    result = extractClaims(turn.finalText, {
      turnIndex: turn.index,
      echoHashes: turn.echoHashes,
      ledgerPaths: ledgerPathsOf(session),
      cwd: session.cwd,
    });
    map.set(turn.index, result);
  }
  return result;
}

/** A claim rows 1–21 will score (positive, agent-attributed, not a bare completion marker). */
function isScoredClaim(c: Claim): boolean {
  return c.polarity === 'positive' && c.attribution === 'agent' && c.kind !== 'completion';
}

/** Every turn index whose final message carries ≥ 1 scored claim (§5.2 `turnsWithClaims`). */
export function turnsWithClaims(session: Session): number[] {
  const out: number[] = [];
  for (const turn of session.turns) {
    if (!turn.isDone) continue;
    const extracted = extractFor(session, turn);
    if (extracted !== null && extracted.claims.some(isScoredClaim)) out.push(turn.index);
  }
  return out;
}

/** The receipt's turn: `--turn N`, else the last done turn, else the last turn (`no-final`). */
function selectTurn(session: Session, turnIndex: number | undefined): Turn | null {
  if (turnIndex !== undefined) return session.turns.find((t) => t.index === turnIndex) ?? null;
  let lastDone: Turn | null = null;
  for (const t of session.turns) if (t.isDone) lastDone = t;
  return lastDone ?? session.turns[session.turns.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Cost (post-cache, §8.3)
// ---------------------------------------------------------------------------

/** The `usd: null` cost of a hook-captured session (`cost n/a (hook-captured)` in renderers). */
function hookCost(pricesVersion: string): Cost {
  return {
    usd: null,
    apiCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteOther: 0,
    output: 0,
    cacheHitPct: null,
    unverified: false,
    unpriced: [],
    apiEquivalent: true,
    pricesVersion,
    notes: [],
  };
}

/** True when the session prices through the Codex delta path. */
function usesDeltas(session: Session): boolean {
  return session.harness === 'codex' || session.tokenDeltas.length > 0;
}

/** Session-level cost for the receipt cost line (§8.3; never stored in the cache). */
export function sessionCost(session: Session, opts: ReceiptOptions): Cost {
  if (session.source === 'ledger') return hookCost(opts.prices.version);
  const shared: CostOpts = {
    table: opts.prices,
    asOf: opts.asOf,
    fetchSearch: session.toolCalls.some((c) => c.kind === 'fetch'),
    compactions: session.compactions.length,
  };
  if (usesDeltas(session)) {
    const codexOpts: CodexCostOpts = { ...shared, planUsagePct: session.cost.planUsagePct };
    return priceCodex(session.tokenDeltas, codexOpts);
  }
  return priceClaudeCode(session.usageRows, shared);
}

/** Stamps `Turn.costUsd` on every turn (Codex by `TokenDelta.turnIndex`; Claude Code by row seq). */
export function stampTurnCosts(session: Session, opts: ReceiptOptions): void {
  if (session.source === 'ledger') return;
  const costOpts: CostOpts = { table: opts.prices, asOf: opts.asOf };
  if (usesDeltas(session)) {
    const byTurn = new Map<number, Session['tokenDeltas']>();
    for (const d of session.tokenDeltas) {
      const list = byTurn.get(d.turnIndex);
      if (list === undefined) byTurn.set(d.turnIndex, [d]);
      else list.push(d);
    }
    for (const t of session.turns) {
      const deltas = byTurn.get(t.index);
      t.costUsd = deltas === undefined ? null : priceCodex(deltas, costOpts).usd;
    }
    return;
  }
  const ordered = [...session.turns].sort((a, b) => a.seqStart - b.seqStart);
  const rowsByTurn = new Map<number, UsageRow[]>();
  for (const row of session.usageRows) {
    let owner: Turn | null = null;
    for (const t of ordered) {
      if (t.seqStart <= row.seq) owner = t;
      else break;
    }
    if (owner === null) continue;
    const list = rowsByTurn.get(owner.index);
    if (list === undefined) rowsByTurn.set(owner.index, [row]);
    else list.push(row);
  }
  for (const t of session.turns) {
    const rows = rowsByTurn.get(t.index);
    t.costUsd = rows === undefined ? null : priceClaudeCode(rows, costOpts).usd;
  }
}

// ---------------------------------------------------------------------------
// Window facts
// ---------------------------------------------------------------------------

/** The §5.2 evidence window of one turn: its calls with `seq ≤ F`. */
interface Window {
  turn: Turn;
  F: number;
  /** Turn calls with `seq ≤ F`, seq order. */
  calls: ToolCall[];
  /** Turn calls with `seq > F` (post-final). */
  postFinal: ToolCall[];
  callById: Map<string, ToolCall>;
  callBySeq: Map<number, ToolCall>;
}

function windowOf(session: Session, turn: Turn): Window {
  const turnCalls = session.toolCalls.filter((c) => c.turnIndex === turn.index).sort((a, b) => a.seq - b.seq);
  let F = turn.finalSeq;
  if (F === null) {
    F = turn.seqEnd;
    for (const c of turnCalls) if (c.seq > F) F = c.seq;
  }
  const calls: ToolCall[] = [];
  const postFinal: ToolCall[] = [];
  for (const c of turnCalls) (c.seq <= F ? calls : postFinal).push(c);
  const callById = new Map<string, ToolCall>();
  const callBySeq = new Map<number, ToolCall>();
  for (const c of calls) {
    callById.set(c.id, c);
    callBySeq.set(c.seq, c);
  }
  return { turn, F, calls, postFinal, callById, callBySeq };
}

/** The window's `ok` writes that count for `filesChanged` (§4.6.1). */
function windowFilesChanged(session: Session, window: Window): WriteFact[] {
  return session.ledger.writes.filter((w) => window.callById.has(w.toolCallId) && w.status === 'ok' && filesChangedEligible(w));
}

// ---------------------------------------------------------------------------
// ALSO DID (§5.2)
// ---------------------------------------------------------------------------

interface DidEntry {
  text: string;
  warn?: boolean;
  refs: EvidenceRef[];
}

/** Display form of a path: relative under the cwd, `~`-form under home, as logged otherwise. */
function displayRel(p: string, cwd: string, homeDir: string): string {
  if (cwd !== '' && cwd !== '/' && isUnder(p, cwd)) return p === cwd ? '.' : p.slice(cwd.length + 1);
  return displayPath(p, homeDir);
}

/** One `EvidenceRef` for an ALSO DID line via the call behind a seq (falls back to the turn end). */
function didRef(seq: number, label: string, window: Window): EvidenceRef {
  const call = window.callBySeq.get(seq);
  return makeRef(seq, call?.startedAt ?? window.turn.endedAt, evidenceLabel(label), call !== undefined ? { toolCallId: call.id } : {});
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The subjects a message claimed (path spellings, cwd-relative forms and basenames). */
function claimedPathKeys(claims: readonly Claim[], cwd: string): Set<string> {
  const keys = new Set<string>();
  for (const c of claims) {
    if (c.subject === undefined || c.subject === '') continue;
    keys.add(c.subject);
    keys.add(basename(c.subject));
    if (!c.subject.startsWith('/')) keys.add(`${cwd}/${c.subject}`);
  }
  return keys;
}

/** The failed-patch path parsed from a result head (survives the §4.9 512-byte cache cap). */
const PATCH_FAIL_PATH_RE = /Failed to find expected lines in (\/[^\s:]+)/;

/**
 * The §4.9 cache view of a result head: masked, then capped at 512 bytes —
 * exactly the bytes a warm (cache-restored) call carries, so cold and warm
 * receipts parse identical text (W3 integration fix).
 */
function maskedHead(resultText: string): string {
  return truncateBytes(maskSecrets(resultText), RESULT_TEXT_CAP);
}

/** True for a failed `apply_patch` call (§4.3.4; `attempted[]` is trimmed away, the result head is not). */
function isFailedPatch(call: ToolCall): boolean {
  if (!call.isError) return false;
  return call.tool === 'apply_patch' || (call.command !== undefined && call.command.trimStart().startsWith('apply_patch'));
}

/**
 * Composes the ALSO DID entries of one turn window (§5.2 order), before the
 * ≤ 6 + `+N more` cap is applied by the caller.
 */
function alsoDidEntries(session: Session, window: Window, claims: readonly Claim[], cwd: string, homeDir: string): DidEntry[] {
  const entries: DidEntry[] = [];
  const ledger = session.ledger;
  const inWindow = <T extends { seq: number }>(facts: readonly T[]): T[] =>
    facts.filter((f) => f.seq >= window.turn.seqStart && f.seq <= window.F);

  // 1. Files changed but not claimed (grouped by directory when > 6).
  const okWrites = windowFilesChanged(session, window);
  const claimed = claimedPathKeys(claims, cwd);
  const anyFileClaims = claims.some((c) => (c.kind === 'file' || c.kind === 'file-count') && isScoredClaim(c));
  const seenPaths = new Set<string>();
  const unmentioned: WriteFact[] = [];
  for (const w of okWrites) {
    if (seenPaths.has(w.path)) continue;
    seenPaths.add(w.path);
    const rel = displayRel(w.path, cwd, homeDir);
    if (claimed.has(w.path) || claimed.has(rel) || claimed.has(basename(w.path))) continue;
    unmentioned.push(w);
  }
  if (unmentioned.length > 0) {
    const n = unmentioned.length;
    const noun = anyFileClaims ? `more file${n === 1 ? '' : 's'}` : `file${n === 1 ? '' : 's'}`;
    let list: string;
    if (n > FILE_LIST_MAX) {
      const dirs: string[] = [];
      for (const w of unmentioned) {
        const rel = displayRel(w.path, cwd, homeDir);
        const slash = rel.lastIndexOf('/');
        const dir = slash === -1 ? './' : `${rel.slice(0, slash)}/`;
        if (!dirs.includes(dir)) dirs.push(dir);
      }
      list = dirs.slice(0, 3).join(', ') + (dirs.length > 3 ? ', …' : '');
    } else {
      list = unmentioned.map((w) => displayRel(w.path, cwd, homeDir)).join(', ');
    }
    const first = unmentioned[0] as WriteFact;
    entries.push({ text: sanitizeForCell(`${n} ${noun} changed (${list})`), refs: [didRef(first.seq, 'write', window)] });
  }

  // 2. Writes into another repository.
  const otherRepo = new Map<string, WriteFact[]>();
  for (const w of okWrites) {
    if (w.scope !== 'other-repo') continue;
    const root = w.otherRoot ?? 'unknown repo';
    const list = otherRepo.get(root);
    if (list === undefined) otherRepo.set(root, [w]);
    else list.push(w);
  }
  for (const [root, writes] of otherRepo) {
    entries.push({
      text: sanitizeForCell(`worked in another repo: ${displayPath(root, homeDir)} (${plural(writes.length, 'write')})`),
      refs: [didRef((writes[0] as WriteFact).seq, 'write', window)],
    });
  }

  // 3. Temp-dir writes.
  const scratch = okWrites.filter((w) => w.scope === 'scratch');
  if (scratch.length > 0) {
    entries.push({
      text: `${plural(scratch.length, 'file')} written to temp dirs`,
      refs: [didRef((scratch[0] as WriteFact).seq, 'write', window)],
    });
  }

  // 4. Harness-config / dotfile / system writes (⚠, any status — the attempt matters).
  const configScopes: { scope: WriteFact['scope']; label: string }[] = [
    { scope: 'harness-config', label: 'harness config' },
    { scope: 'home-dotfile', label: 'home dotfiles' },
    { scope: 'system', label: 'system paths' },
  ];
  for (const { scope, label } of configScopes) {
    const writes = ledger.writes.filter((w) => window.callById.has(w.toolCallId) && w.scope === scope && w.status !== 'failed');
    if (writes.length === 0) continue;
    const shown = displayRel((writes[0] as WriteFact).path, cwd, homeDir);
    entries.push({
      text: sanitizeForCell(`${plural(writes.length, 'file')} written to ${label} (${shown}${writes.length > 1 ? ', …' : ''})`),
      warn: true,
      refs: [didRef((writes[0] as WriteFact).seq, 'write', window)],
    });
  }

  // 5. Reverted writes.
  for (const w of ledger.writes) {
    if (w.reverted === undefined || !window.callById.has(w.toolCallId)) continue;
    entries.push({
      text: sanitizeForCell(`reverted ${displayRel(w.path, cwd, homeDir)} (${w.reverted.by})`),
      refs: [didRef(w.reverted.seq, w.reverted.by, window)],
    });
  }

  // 6. Integrity signals (⚠ only for a confirmed weakening).
  for (const signal of inWindow(ledger.integrity)) {
    const entry: DidEntry = { text: sanitizeForCell(signal.detail), refs: [didRef(signal.seq, signal.kind, window)] };
    if (signal.kind === 'test-weakened') entry.warn = true;
    entries.push(entry);
  }

  // 7. Danger flags, tier `danger`, ≤ 3 + `+N` (§4.6.8).
  const danger = inWindow(ledger.danger).filter((d) => d.tier === 'danger');
  for (const flag of danger.slice(0, DANGER_MAX)) {
    entries.push({ text: sanitizeForCell(flag.detail), warn: true, refs: [didRef(flag.seq, flag.kind, window)] });
  }
  if (danger.length > DANGER_MAX) {
    entries.push({ text: `+${danger.length - DANGER_MAX} more danger flags`, warn: true, refs: [] });
  }

  // 8. Background / unknown-exit commands, and Codex interactive input.
  const commands = ledger.commands.filter((c) => window.callById.has(c.toolCallId));
  const background = commands.filter((c) => c.background);
  if (background.length > 0) {
    entries.push({
      text: `${plural(background.length, 'command')} moved to background (exit unknown)`,
      refs: [didRef((background[0] as (typeof background)[number]).seq, 'background command', window)],
    });
  }
  const unknownExit = commands.filter((c) => !c.background && !c.interrupted && c.exitCode === null);
  if (unknownExit.length > 0) {
    entries.push({
      text: `${plural(unknownExit.length, 'command')} with unknown exit`,
      refs: [didRef((unknownExit[0] as (typeof unknownExit)[number]).seq, 'command', window)],
    });
  }
  const stdinTargets = window.calls.filter((c) => (c.stdinWrites?.length ?? 0) > 0);
  for (const target of stdinTargets) {
    const writes = target.stdinWrites ?? [];
    const interrupted = target.interrupted || writes.some((w) => w.interrupted === true);
    entries.push({
      text: sanitizeForCell(
        `interactive input sent to a background command (${plural(writes.length, 'write')})${interrupted ? ' · interrupted by Ctrl-C' : ''}`,
      ),
      refs: [didRef(target.seq, 'interactive input', window)],
    });
  }

  // 9. Opaque interpreter writes ("N scripts may have written files") — §5.2 lists scripts before failed patches.
  const opaque = commands.filter((c) => c.opaqueWrite === true);
  if (opaque.length > 0) {
    const first = opaque[0] as (typeof opaque)[number];
    const seg = first.segments.find((s) => s.mayWrite === true) ?? first.segments[0];
    const how = seg === undefined ? 'script' : `${seg.heredoc?.interpreter ?? seg.program}${seg.heredoc !== undefined ? ' heredoc' : ''}`;
    const exit = first.exitCode === null ? 'exit unknown' : `exit ${first.exitCode}`;
    const detail = opaque.length === 1 ? ` (${how}, ${exit})` : '';
    entries.push({
      text: sanitizeForCell(`${plural(opaque.length, 'script')} may have written files${detail}`),
      refs: [didRef(first.seq, 'script', window)],
    });
  }

  // 10. Failed patches (§4.3.4), parsed over the masked §4.9 head so cold and warm receipts agree.
  for (const call of window.calls) {
    if (!isFailedPatch(call)) continue;
    const m = PATCH_FAIL_PATH_RE.exec(maskedHead(call.resultText));
    const path = m === null ? null : displayRel(m[1] as string, cwd, homeDir);
    entries.push({
      text: sanitizeForCell(path === null ? 'patch failed' : `patch failed: ${path}`),
      refs: [didRef(call.seq, 'apply_patch', window)],
    });
  }

  // 11. Network: contacted and attempted hosts.
  const network = inWindow(ledger.network);
  const contacted = [...new Set(network.filter((n) => n.status === 'contacted').map((n) => n.host))];
  if (contacted.length > 0) {
    const allInferred = network.filter((n) => n.status === 'contacted').every((n) => n.inferred);
    const firstSeq = (network.find((n) => n.status === 'contacted') as (typeof network)[number]).seq;
    entries.push({
      text: sanitizeForCell(`contacted: ${contacted.join(', ')}${allInferred ? ' (inferred)' : ''}`),
      refs: [didRef(firstSeq, 'network', window)],
    });
  }
  for (const n of network.filter((f) => f.status === 'attempted')) {
    const why = n.note ?? (n.exit !== null && n.exit !== undefined ? `exit ${n.exit}` : 'not reached');
    entries.push({ text: sanitizeForCell(`attempted: ${n.host} (${why})`), refs: [didRef(n.seq, 'network', window)] });
  }

  // 12. PR references (never claim evidence, §4.2.8); the ref points at an in-window prRef.
  const prsInWindow = inWindow(session.prRefs);
  const prNumbers = [...new Set(prsInWindow.map((p) => p.prNumber))];
  if (prNumbers.length > 0) {
    entries.push({
      text: `referenced PR ${prNumbers.map((n) => `#${n}`).join(', ')}`,
      refs: [didRef((prsInWindow[0] as (typeof prsInWindow)[number]).seq, 'pr-link', window)],
    });
  }

  // 13. API errors (session-scoped — they carry no seq).
  if (session.apiErrors.length > 0) {
    entries.push({ text: `${plural(session.apiErrors.length, 'API error')} during the session`, refs: [] });
  }

  // 14. Refusal fallbacks.
  for (const rf of inWindow(session.refusalFallbacks)) {
    entries.push({
      text: sanitizeForCell(`model fell back ${rf.originalModel} → ${rf.fallbackModel} (refusal)`),
      refs: [didRef(rf.seq, 'refusal fallback', window)],
    });
  }

  // 15. Interrupts inside the turn.
  const interrupts = window.turn.segments.filter((s) => s.trigger === 'interrupt').length;
  if (interrupts > 0) {
    entries.push({ text: interrupts === 1 ? 'turn interrupted by the user' : `turn interrupted by the user ×${interrupts}`, refs: [] });
  }

  return entries;
}

/** Applies the §5.2 cap: at most 6 entries plus a `+N more` tail. */
function capAlsoDid(entries: DidEntry[]): DidEntry[] {
  if (entries.length <= ALSO_DID_MAX) return entries;
  const kept = entries.slice(0, ALSO_DID_MAX);
  kept.push({ text: `+${entries.length - ALSO_DID_MAX} more`, refs: [] });
  return kept;
}

// ---------------------------------------------------------------------------
// Lines, verdict, stats
// ---------------------------------------------------------------------------

const VERDICT_RANK: Readonly<Record<Verdict, number>> = { CONTRADICTED: 0, UNVERIFIED: 1, VERIFIED: 2, NOT_SCORED: 3 };
const GLYPH: Readonly<Record<Exclude<Verdict, 'NOT_SCORED'>, ReceiptLine['glyph']>> = {
  CONTRADICTED: 'bad',
  UNVERIFIED: 'unk',
  VERIFIED: 'ok',
};

/** Worst-first CLAIMED/EVIDENCE lines (§5.2): contradicted, unverified, verified; message order within a group. */
function buildLines(session: Session, turn: Turn, claims: readonly Claim[], judgements: readonly Judgement[]): ReceiptLine[] {
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const scored = judgements.filter((j) => j.verdict !== 'NOT_SCORED');
  const positioned = scored.map((j, i) => ({ j, position: claimById.get(j.claimId)?.position ?? i }));
  positioned.sort((a, b) => VERDICT_RANK[a.j.verdict] - VERDICT_RANK[b.j.verdict] || a.position - b.position);
  const turnStartMs = parseIso(turn.startedAt);
  const fmt: EvidenceFormat = { tz: 'utc', subagents: session.subagents };
  if (turnStartMs !== null) fmt.refDayMs = turnStartMs;
  return positioned.map(({ j }) => {
    const claim = claimById.get(j.claimId);
    return {
      glyph: GLYPH[j.verdict as Exclude<Verdict, 'NOT_SCORED'>],
      claim: sanitizeForCell(claim?.clause ?? j.claimId),
      evidence: evidenceStrings(j, fmt),
      refs: j.evidence,
    };
  });
}

/** Zero-filled verdict counts. */
function countVerdicts(judgements: readonly Judgement[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 };
  for (const j of judgements) counts[j.verdict] += 1;
  return counts;
}

/** The receipt verdict (§5.2): worst scored claim; `NO_CLAIMS` when none scored. */
function receiptVerdict(counts: Record<Verdict, number>): Receipt['verdict'] {
  if (counts.CONTRADICTED > 0) return 'CONTRADICTED';
  if (counts.UNVERIFIED > 0) return 'UNVERIFIED';
  if (counts.VERIFIED > 0) return 'VERIFIED';
  return 'NO_CLAIMS';
}

function statsOf(session: Session, window: Window, sentences: number): Receipt['stats'] {
  const files = new Set(windowFilesChanged(session, window).map((w) => w.path));
  const testRuns = session.ledger.testRuns.filter((t) => window.callById.has(t.toolCallId) && t.kind === 'run').length;
  const agents = new Set<string>();
  for (const c of window.calls) if (c.agentId !== null) agents.add(c.agentId);
  return {
    toolCalls: window.calls.length,
    filesChanged: files.size,
    testRuns,
    compactions: window.turn.compactions,
    subagents: agents.size,
    apiCalls: window.turn.apiCalls,
    sentencesScanned: sentences,
  };
}

/** Post-final activity grouped per agent (§5.2 — "after this message: …, not evidence"). */
function postFinalOf(session: Session, window: Window): Receipt['postFinal'] {
  if (window.postFinal.length === 0) return undefined;
  const byAgent = new Map<string | null, ToolCall[]>();
  for (const c of window.postFinal) {
    const list = byAgent.get(c.agentId);
    if (list === undefined) byAgent.set(c.agentId, [c]);
    else list.push(c);
  }
  const out: NonNullable<Receipt['postFinal']> = [];
  for (const [agentId, calls] of byAgent) {
    const ids = new Set(calls.map((c) => c.id));
    const files = new Set(
      session.ledger.writes.filter((w) => ids.has(w.toolCallId) && w.status === 'ok' && filesChangedEligible(w)).map((w) => w.path),
    );
    const testRuns = session.ledger.testRuns.filter((t) => ids.has(t.toolCallId) && t.kind === 'run').length;
    out.push({ agentId, toolCalls: calls.length, files: files.size, testRuns });
  }
  out.sort((a, b) => ((a.agentId ?? '') < (b.agentId ?? '') ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Receipt assembly
// ---------------------------------------------------------------------------

/** `harnessVersion` for display: the single version, or `first→last` when the session saw several (§4.2.2). */
export function harnessVersionLabel(session: Session): string | null {
  const versions = session.harnessVersions;
  if (versions.length > 1) return `${versions[0]}→${versions[versions.length - 1]}`;
  return session.harnessVersion;
}

/** Shared header/base fields of every receipt kind. */
function baseReceipt(session: Session, opts: ReceiptOptions): Receipt {
  const receipt: Receipt = {
    schema: 'showreceipts.receipt/1',
    toolVersion: TOOL_VERSION,
    rulesVersion: RECEIPT_RULES_VERSION,
    pricesVersion: opts.prices.version,
    kind: 'scored',
    id: session.sessionId,
    shortId: session.shortId,
    harness: session.harness,
    harnessLabel: HARNESS_LABELS[session.harness],
    harnessVersion: harnessVersionLabel(session),
    model: session.primaryModel,
    cwd: session.cwd,
    branch: session.gitBranch,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    source: session.source,
    turnIndex: -1,
    finalTrigger: null,
    turnsWithClaims: turnsWithClaims(session),
    finalText: '',
    finalTextSource: session.source === 'ledger' ? 'stop-hook' : 'transcript',
    claims: [],
    judgements: [],
    lines: [],
    alsoSaid: [],
    alsoDid: [],
    stats: { toolCalls: 0, filesChanged: 0, testRuns: 0, compactions: 0, subagents: 0, apiCalls: 0, sentencesScanned: 0 },
    cost: sessionCost(session, opts),
    verdict: 'NO_CLAIMS',
    counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 },
    turnActiveMs: null,
    claimsRecognized: 0,
  };
  if (session.ledgerNote !== undefined) receipt.ledgerNote = session.ledgerNote;
  if (session.ledgerCoverage !== undefined) receipt.ledgerCoverage = session.ledgerCoverage;
  const startMs = parseIso(session.startedAt);
  const endMs = parseIso(session.endedAt);
  if (session.spansDays > 1 && startMs !== null && endMs !== null) {
    receipt.sessionSpan = { from: session.startedAt, to: session.endedAt, days: calendarDaysBetween(startMs, endMs, 'utc') };
  }
  return receipt;
}

/**
 * Builds the receipt of one turn (§5.2): turn selection (last done turn,
 * `--turn N`), claims and judgements, worst-first lines, ALSO SAID (≤ 3),
 * ALSO DID (≤ 6 + `+N more`), stats over the same window as the judgements,
 * session-level cost (per-turn cost stamped onto `Turn.costUsd`), verdict
 * and counts, `kind` transitions (`no-claims`, `no-final`, `no-turns`),
 * the timeline and explanations on demand, and the `--hash-paths` pass.
 */
export function buildReceipt(session: Session, opts: ReceiptOptions): Receipt {
  const receipt = baseReceipt(session, opts);
  stampTurnCosts(session, opts);

  const turn = session.kind === 'normal' ? selectTurn(session, opts.turnIndex) : null;
  if (turn === null) {
    receipt.kind = 'no-turns';
    receipt.verdict = 'NO_TURNS';
    receipt.records = session.records;
    receipt.slashCommands = session.diagnostics.localCommandPrompts;
    return finishReceipt(receipt, session, null, opts);
  }

  receipt.turnIndex = turn.index;
  receipt.finalTrigger = turn.finalTrigger;
  receipt.startedAt = turn.startedAt;
  receipt.endedAt = turn.endedAt;
  const startMs = parseIso(turn.startedAt);
  const endMs = parseIso(turn.endedAt);
  receipt.durationMs = startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0;
  receipt.turnActiveMs = turn.durationMs;
  receipt.model = turn.model ?? session.primaryModel;
  if (turn.harnessVersion !== null && session.harnessVersions.length <= 1) receipt.harnessVersion = turn.harnessVersion;
  if (turn.finalTextSource !== undefined) receipt.finalTextSource = turn.finalTextSource;

  const window = windowOf(session, turn);

  if (!turn.isDone || turn.finalText === null) {
    receipt.kind = 'no-final';
    receipt.verdict = 'NO_FINAL';
    receipt.finalStopReason = turn.finalStopReason;
    receipt.alsoDid = capAlsoDid(alsoDidEntries(session, window, [], session.cwd, opts.homeDir));
    receipt.stats = statsOf(session, window, 0);
    return finishReceipt(receipt, session, turn, opts);
  }

  const finalText = turn.finalText;
  const extracted = extractFor(session, turn) ?? { claims: [], sentences: 0, recognized: 0 };
  const claims = extracted.claims;
  const judgements = reconcile(session, turn.index, claims);
  const counts = countVerdicts(judgements);
  const scoredCount = judgements.length - counts.NOT_SCORED;
  const marker = claims.some((c) => c.kind === 'completion');

  receipt.finalText = finalText;
  receipt.claims = claims;
  receipt.judgements = judgements;
  receipt.claimsRecognized = extracted.recognized;
  receipt.counts = counts;
  receipt.kind = scoredCount > 0 || marker ? 'scored' : 'no-claims';
  receipt.verdict = receiptVerdict(counts);
  receipt.lines = buildLines(session, turn, claims, judgements);

  const claimById = new Map(claims.map((c) => [c.id, c]));
  receipt.alsoSaid = judgements
    .filter((j) => j.verdict === 'NOT_SCORED')
    .map((j) => claimById.get(j.claimId))
    .filter((c): c is Claim => c !== undefined)
    .sort((a, b) => a.position - b.position)
    .slice(0, ALSO_SAID_MAX)
    .map((c) => sanitizeForCell(c.clause));

  receipt.alsoDid = capAlsoDid(alsoDidEntries(session, window, claims, session.cwd, opts.homeDir));
  receipt.stats = statsOf(session, window, extracted.sentences);
  const postFinal = postFinalOf(session, window);
  if (postFinal !== undefined) receipt.postFinal = postFinal;

  if (opts.explain === true) {
    receipt.explanations = judgements.map((j) => {
      const claim = claimById.get(j.claimId);
      return explain(claim ?? emptyClaim(j.claimId), j, { finalText });
    });
  }
  return finishReceipt(receipt, session, turn, opts);
}

/** A minimal claim stub for an explanation whose claim went missing (defensive; never expected). */
function emptyClaim(id: string): Claim {
  return {
    id,
    kind: 'verification',
    polarity: 'positive',
    attribution: 'agent',
    rule: 'unknown',
    sentence: '',
    clause: '',
    position: 0,
    echoed: false,
  };
}

/** Minimum length of the auto-derived bare-username token (§13.4 precedent: runtime username checks apply from 6 chars, so short generic basenames like the fixtures' `/home/u` stay untouched). */
const USERNAME_MIN = 6;

/** Timeline on demand, then the `--hash-paths` pass (§11.2: paths plus bare home/username tokens) — always the last step. */
function finishReceipt(receipt: Receipt, session: Session, turn: Turn | null, opts: ReceiptOptions): Receipt {
  if (opts.timeline === true && turn !== null) {
    receipt.timeline = buildTimeline(session, turn, { table: opts.prices, asOf: opts.asOf });
  }
  if (opts.hashPaths !== undefined && opts.hashPaths !== '') {
    const user = basename(opts.homeDir);
    const extraTokens = [opts.homeDir, ...(user.length >= USERNAME_MIN ? [user] : [])].filter((t) => t.length > 1);
    const hashed = hashStrings(receipt, opts.hashPaths, session.cwd, extraTokens);
    hashed.hashPaths = true;
    return hashed;
  }
  return receipt;
}

/**
 * Receipts for every done turn of a session (turn index → receipt) — the
 * shape `reconcile/rate.ts aggregateRate` and the session cards consume.
 */
export function buildTurnReceipts(session: Session, opts: ReceiptOptions): Map<number, Receipt> {
  const receipts = new Map<number, Receipt>();
  if (session.kind !== 'normal') return receipts;
  for (const turn of session.turns) {
    if (!turn.isDone) continue;
    receipts.set(turn.index, buildReceipt(session, { ...opts, turnIndex: turn.index }));
  }
  return receipts;
}

/** The canonical JSON form of a receipt (§12.3): `stableStringify` — key-sorted, compact, deterministic. */
export function receiptToJson(receipt: Receipt): string {
  return stableStringify(receipt);
}
