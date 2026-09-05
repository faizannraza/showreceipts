/**
 * Price-table types, model-id normalisation and rate resolution
 * (ARCHITECTURE §8.1, §8.2). The bundled table is read from the JSON file
 * next to this module — never via an import attribute — and the S12b build
 * rule copies it byte-identical to `dist/cost/prices.json`.
 *
 * Semantics implemented here:
 * - id lookup is exact → longest prefix → regex in file order (§8.1);
 * - `aliasOf` chains are followed to depth 3 with cycle detection (regex
 *   rows may substitute `$1`… from their match into the target);
 * - dated windows are chosen by the UTC calendar day of the call, or by
 *   `--as-of`; bounds are inclusive and an on-boundary day belongs to the
 *   new window; a call earlier than every window prices with the earliest
 *   window at confidence `estimate` with a note;
 * - `windows` (time-of-day, e.g. DeepSeek off-peak) always use the call's
 *   own UTC time, even under `--as-of`, and may wrap past midnight;
 * - `speeds` and `tiers` reprice the whole attempt; provider defaults turn
 *   cache multipliers into absolute rates. A provider without a cache-read
 *   default yields `cacheRead: null` and the cost engine prices reads at
 *   the input rate with `≈` and a note (§8.3, Mistral rule).
 */
import { readFileSync } from 'node:fs';

import { isoDay } from '../util/time.js';

/** Raised for an invalid price table, alias cycle or over-deep alias chain. */
export class PriceTableError extends Error {
  override name = 'PriceTableError';
}

export type Provider = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'mistral';
export type Confidence = 'verified' | 'inferred' | 'estimate';
export type MatchKind = 'exact' | 'prefix' | 'regex';

/** One dated rate window (§8.1); `from: null` = open start, `until: null` = open end. */
export interface RateWindow {
  from: string | null;
  until: string | null;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWriteMult?: number;
  reasoning?: number;
}

/** Whole-request repricing by prompt size (§8.1). */
export interface TierRow {
  aboveInputTokens: number;
  input: number;
  output: number;
  cacheRead?: number;
  confidence?: Confidence;
}

/** A named speed's rates (e.g. `fast`); cache rates derive from its input. */
export interface SpeedRates {
  input: number;
  output: number;
  cacheRead?: number;
  confidence?: Confidence;
  note?: string;
}

/** Time-of-day rates keyed by a UTC `HH:MM-HH:MM` range (may wrap midnight). */
export interface TimeWindow {
  utc: string;
  input: number;
  output: number;
  cacheRead?: number;
}

/** One model row of the price table (§8.1). */
export interface PriceRow {
  provider: Provider;
  match?: MatchKind;
  aliasOf?: string;
  rates?: RateWindow[];
  tiers?: TierRow[];
  speeds?: Record<string, SpeedRates>;
  windows?: TimeWindow[];
  contextWindow?: number;
  verified?: boolean;
  confidence?: Confidence;
  source?: string;
  checkedAt?: string;
  note?: string;
  unpriced?: boolean;
}

/** Provider-level defaults: cache multipliers of `input` (§8.1). */
export interface ProviderDefaults {
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWriteMult?: number;
}

/** The whole price table; `overrideHash` is set by `mergeTables`. */
export interface PriceTable {
  version: string;
  unit: string;
  defaults: Partial<Record<Provider, ProviderDefaults>>;
  models: Record<string, PriceRow>;
  overrideHash?: string;
}

/** Absolute $/M rates effective for one attempt after all repricing. */
export interface EffectiveRates {
  input: number;
  output: number;
  reasoning: number;
  /** `null` = the model has no cache-read price (Mistral rule, §8.3). */
  cacheRead: number | null;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Provenance of one resolution (S16: verified/confidence/window/tier/aliasOf/unpriced). */
export interface RateMeta {
  /** The normalised model id the lookup used. */
  id: string;
  verified: boolean;
  confidence: Confidence;
  window: { from: string | null; until: string | null } | null;
  /** The `aboveInputTokens` threshold that repriced the attempt. */
  tier?: number;
  /** Final alias target key when an `aliasOf` chain was followed. */
  aliasOf?: string;
  /** Reason the model is unpriced; `rates` are zeros when set. */
  unpriced?: string;
  /** This resolution contributes the `≈` flag. */
  approx: boolean;
  notes: string[];
  offPeak?: boolean;
  /** The speed whose rates were applied. */
  speed?: string;
}

export interface ResolvedRates {
  rates: EffectiveRates;
  meta: RateMeta;
}

export interface ResolveOpts {
  table: PriceTable;
  /** `--as-of YYYY-MM-DD`: overrides the dated-window day (never the time-of-day windows). */
  asOf?: string | undefined;
  /** `usage.speed`; anything other than `standard` looks up `speeds`. */
  speed?: string | undefined;
  /** `usage.service_tier`; anything other than `standard` adds a note + `≈`. */
  serviceTier?: string | undefined;
  /** Prompt-side token count for tier repricing (`in+w5+w1+wX+wU+rd`, or Codex `lastInput`). */
  promptTokens?: number | undefined;
}

const MAX_ALIAS_DEPTH = 3;
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { verified: 0, inferred: 1, estimate: 2 };

let bundled: PriceTable | null = null;

/**
 * Loads the bundled `cost/prices.json` (cached after the first read). The
 * file sits next to this module in both `src/` and `dist/` (build-assets
 * copies every non-TS file under `src/`).
 */
export function loadPriceTable(): PriceTable {
  if (bundled === null) {
    bundled = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8')) as PriceTable;
  }
  return bundled;
}

/**
 * Normalises a transcript model id for lookup (§8.1): lowercase; Bedrock
 * markers (`us.`/`eu.`/`global.`/`anthropic.`/`bedrock`) and the Vertex
 * `@YYYYMMDD` suffix mark the id unpriced ("partner pricing differs …");
 * a trailing `[1m]`/`-1m` context marker is stripped. First-party dated
 * ids (`…-YYYYMMDD`) are matched by the prefix rows, so the date is kept
 * here and only stripped as a lookup fallback by {@link resolveRates}.
 */
export function normalizeModelId(id: string): { id: string; unpriced?: string } {
  let s = id.trim().toLowerCase();
  if (/^(us|eu|global|apac)\./.test(s) || /(^|\.)anthropic\./.test(s) || s.includes('bedrock')) {
    return { id: s, unpriced: 'partner pricing differs (Bedrock)' };
  }
  const vertex = /@\d{8}$/.exec(s);
  if (vertex !== null) {
    return { id: s.slice(0, vertex.index), unpriced: 'partner pricing differs (Vertex AI)' };
  }
  if (s.endsWith('[1m]')) s = s.slice(0, -'[1m]'.length);
  else if (s.endsWith('-1m')) s = s.slice(0, -'-1m'.length);
  return { id: s };
}

interface Matched {
  key: string;
  row: PriceRow;
  regexMatch: RegExpExecArray | null;
}

/** Exact → longest prefix → regex in file order (§8.1). */
function matchRow(id: string, table: PriceTable): Matched | null {
  const direct = table.models[id];
  if (direct !== undefined && (direct.match ?? 'exact') !== 'regex') return { key: id, row: direct, regexMatch: null };
  let best: Matched | null = null;
  for (const [key, row] of Object.entries(table.models)) {
    if (row.match !== 'prefix') continue;
    if (id.startsWith(key) && (best === null || key.length > best.key.length)) best = { key, row, regexMatch: null };
  }
  if (best !== null) return best;
  for (const [key, row] of Object.entries(table.models)) {
    if (row.match !== 'regex') continue;
    const m = new RegExp(key).exec(id);
    if (m !== null) return { key, row, regexMatch: m };
  }
  return null;
}

interface AliasResult {
  key: string;
  row: PriceRow;
  aliasTarget: string | null;
  aliased: boolean;
}

/** One memoised row lookup: the normalised id plus the alias-followed row (`null` = not in the table). */
interface LookupHit {
  norm: { id: string; unpriced?: string };
  followed: AliasResult | null;
}

/**
 * Per-table memo of the §8.1 row scan (S36): exact → prefix → regex → alias
 * chain is pure over the table, and `matchRow` walks every row (regex rows
 * recompiled per probe), so repeating it per usage attempt dominated the
 * warm `audit` profile. Keyed by table object identity — a different
 * `--prices` table is a different key — and holding only rows/ids, never
 * dollars.
 */
const LOOKUPS = new WeakMap<PriceTable, Map<string, LookupHit>>();

/** The memoised normalise + match + alias-follow of one raw model id against one table. */
function lookupModel(model: string, table: PriceTable): LookupHit {
  let memo = LOOKUPS.get(table);
  if (memo === undefined) {
    memo = new Map();
    LOOKUPS.set(table, memo);
  }
  const cached = memo.get(model);
  if (cached !== undefined) return cached;
  const norm = normalizeModelId(model);
  let followed: AliasResult | null = null;
  if (norm.unpriced === undefined) {
    let matched = matchRow(norm.id, table);
    if (matched === null) {
      // Fallback for exact-match rows with first-party dated variants (§8.1).
      const dated = /-\d{8}$/.exec(norm.id);
      if (dated !== null) matched = matchRow(norm.id.slice(0, dated.index), table);
    }
    if (matched !== null) followed = followAlias(matched, table);
  }
  const hit: LookupHit = { norm, followed };
  memo.set(model, hit);
  return hit;
}

/**
 * Follows an `aliasOf` chain (max depth 3, cycles rejected). A regex row's
 * target may substitute `$1`… from the id match. Returns `null` when a
 * target key does not exist (the id stays unpriced, listed by `doctor`).
 */
function followAlias(start: Matched, table: PriceTable): AliasResult | null {
  let key = start.key;
  let row = start.row;
  let regexMatch = start.regexMatch;
  const visited = [key];
  let hops = 0;
  while (row.aliasOf !== undefined) {
    if (hops >= MAX_ALIAS_DEPTH) throw new PriceTableError(`prices: alias chain exceeds depth ${MAX_ALIAS_DEPTH} at "${start.key}"`);
    const m = regexMatch;
    const target = m === null ? row.aliasOf : row.aliasOf.replace(/\$(\d)/g, (_, g: string) => m[Number(g)] ?? '');
    if (visited.includes(target)) throw new PriceTableError(`prices: alias cycle ${[...visited, target].join(' → ')}`);
    const next = table.models[target];
    if (next === undefined) return null;
    visited.push(target);
    key = target;
    row = next;
    regexMatch = null;
    hops += 1;
  }
  return { key, row, aliasTarget: key === start.key ? null : key, aliased: key !== start.key };
}

interface PickedWindow {
  w: RateWindow;
  beforeFirst: boolean;
}

/**
 * Chooses the dated window containing `day` (inclusive bounds; lexicographic
 * ISO comparison). `day: null` (no timestamp) picks the open-ended current
 * window. A day earlier than every window falls back to the earliest window
 * (`beforeFirst`, priced at confidence `estimate` with a note).
 */
function pickWindow(rates: readonly RateWindow[], day: string | null): PickedWindow {
  if (day !== null) {
    for (const w of rates) {
      if ((w.from === null || day >= w.from) && (w.until === null || day <= w.until)) return { w, beforeFirst: false };
    }
  } else {
    for (const w of rates) {
      if (w.until === null) return { w, beforeFirst: false };
    }
  }
  let earliest = rates[0] as RateWindow;
  for (const w of rates) {
    if (w.from === null || (earliest.from !== null && w.from < earliest.from)) earliest = w;
  }
  return { w: earliest, beforeFirst: day !== null };
}

/** Absolute per-window fields a repricing source may carry. */
interface AbsoluteRates {
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWriteMult?: number;
  reasoning?: number;
}

/** Turns input/output + absolute overrides + provider defaults into effective rates. */
function effective(input: number, output: number, abs: AbsoluteRates, defs: ProviderDefaults): EffectiveRates {
  const mult = abs.cacheWriteMult ?? defs.cacheWriteMult ?? 1;
  return {
    input,
    output,
    reasoning: abs.reasoning ?? output,
    cacheRead: abs.cacheRead ?? (defs.cacheRead !== undefined ? defs.cacheRead * input : null),
    cacheWrite5m: abs.cacheWrite5m ?? (defs.cacheWrite5m !== undefined ? defs.cacheWrite5m * input : mult * input),
    cacheWrite1h: abs.cacheWrite1h ?? (defs.cacheWrite1h !== undefined ? defs.cacheWrite1h * input : mult * input),
  };
}

/** `HH:MM-HH:MM` containment for minute-of-day `m`; start inclusive, end exclusive; wraps past midnight. */
function inUtcWindow(spec: string, minuteOfDay: number): boolean {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (m === null) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start <= end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

const ZERO_RATES: EffectiveRates = { input: 0, output: 0, reasoning: 0, cacheRead: null, cacheWrite5m: 0, cacheWrite1h: 0 };

function unpricedResult(id: string, reason: string, aliasOf?: string): ResolvedRates {
  const meta: RateMeta = { id, verified: false, confidence: 'estimate', window: null, unpriced: reason, approx: true, notes: [] };
  if (aliasOf !== undefined) meta.aliasOf = aliasOf;
  return { rates: { ...ZERO_RATES }, meta };
}

function worse(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Resolves the effective $/M rates for one attempt (§8.1 lookup + §8.3
 * repricing): normalise the id, match a row, follow aliases, choose the
 * dated window by call day (or `--as-of`), apply time-of-day windows by the
 * call's own UTC time, then speed, service-tier and tier rules. Throws
 * {@link PriceTableError} on an alias cycle or over-deep chain; every other
 * failure returns an `unpriced` meta (never a throw — `doctor` lists them).
 * The row lookup is memoised per table object ({@link lookupModel}); the
 * window/speed/tier arithmetic still runs per call.
 */
export function resolveRates(model: string, tsMs: number | null, opts: ResolveOpts): ResolvedRates {
  const table = opts.table;
  const { norm, followed } = lookupModel(model, table);
  if (norm.unpriced !== undefined) return unpricedResult(norm.id, norm.unpriced);
  if (followed === null) return unpricedResult(norm.id, 'not in the price table');
  const row = followed.row;
  const aliasOf = followed.aliasTarget ?? undefined;
  if (row.unpriced === true || row.rates === undefined || row.rates.length === 0) {
    return unpricedResult(norm.id, row.note ?? 'not priced', aliasOf);
  }

  const notes: string[] = [];
  let approx = false;
  let confidence: Confidence = row.confidence ?? 'estimate';
  if (followed.aliased) confidence = worse('inferred', confidence);

  const day = opts.asOf ?? (tsMs !== null ? isoDay(tsMs) : null);
  const picked = pickWindow(row.rates, day);
  if (picked.beforeFirst) {
    confidence = 'estimate';
    notes.push(`priced with the earliest known window (from ${picked.w.from})`);
  }
  const defs = table.defaults[row.provider] ?? {};
  let rates = effective(picked.w.input, picked.w.output, picked.w, defs);
  const meta: RateMeta = {
    id: norm.id,
    verified: false,
    confidence,
    window: { from: picked.w.from, until: picked.w.until },
    approx: false,
    notes,
  };
  if (aliasOf !== undefined) meta.aliasOf = aliasOf;

  // Time-of-day windows: the call's own UTC time, even under --as-of (§8.1).
  if (row.windows !== undefined && tsMs !== null) {
    const d = new Date(tsMs);
    const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (const tw of row.windows) {
      if (inUtcWindow(tw.utc, minute)) {
        rates = effective(tw.input, tw.output, tw, defs);
        meta.offPeak = true;
        break;
      }
    }
  }

  // Speed (§8.3): priced when the row lists it, else standard + note + ≈.
  if (opts.speed !== undefined && opts.speed !== 'standard') {
    const sp = row.speeds?.[opts.speed];
    if (sp !== undefined) {
      rates = effective(sp.input, sp.output, sp, defs);
      meta.speed = opts.speed;
      if (sp.confidence !== undefined && sp.confidence !== 'verified') {
        approx = true;
        confidence = worse(confidence, sp.confidence);
        if (sp.note !== undefined) notes.push(sp.note);
      }
    } else {
      approx = true;
      notes.push(`speed '${opts.speed}' not priced`);
    }
  }

  // Service tier (§8.3): standard rates + note + ≈.
  if (opts.serviceTier !== undefined && opts.serviceTier !== 'standard') {
    approx = true;
    notes.push(`service tier ${opts.serviceTier} not priced`);
  }

  // Tier repricing by prompt size (§8.3): the whole attempt at the tier.
  if (row.tiers !== undefined && opts.promptTokens !== undefined) {
    let best: TierRow | null = null;
    for (const t of row.tiers) {
      if (opts.promptTokens > t.aboveInputTokens && (best === null || t.aboveInputTokens > best.aboveInputTokens)) best = t;
    }
    if (best !== null) {
      rates = effective(best.input, best.output, best, defs);
      meta.tier = best.aboveInputTokens;
      if (best.confidence !== undefined && best.confidence !== 'verified') {
        approx = true;
        confidence = worse(confidence, best.confidence);
      }
    }
  }

  if (confidence !== 'verified') approx = true;
  meta.confidence = confidence;
  meta.verified = confidence === 'verified' && row.verified === true;
  meta.approx = approx;
  return { rates, meta };
}
