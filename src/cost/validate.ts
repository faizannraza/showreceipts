/**
 * Strict validator and merger for price-table overrides (§8.1):
 * `~/.showreceipts/prices.json` and `--prices <file>`. Every failure throws
 * {@link PriceTableError} with the exact §8.1 message; commands map it to a
 * report-once-and-ignore (home override) or exit 1 (`--prices`). The
 * bundled table passes this validator too (asserted by tests).
 */
import { sha256 } from '../util/hash.js';
import { isRecord, stableStringify } from '../util/json.js';
import { parseIso } from '../util/time.js';
import {
  PriceTableError,
  type Confidence,
  type PriceRow,
  type PriceTable,
  type Provider,
  type ProviderDefaults,
} from './resolve.js';

const UNIT = 'usd_per_million_tokens';
const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'mistral'];
const CONFIDENCES: readonly Confidence[] = ['verified', 'inferred', 'estimate'];
const MATCHES = ['exact', 'prefix', 'regex'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ALIAS_DEPTH = 3;

function fail(message: string): never {
  throw new PriceTableError(message);
}

/** 1-based line of a `JSON.parse` failure, from the error message or position. */
function jsonErrorLine(text: string, err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const line = /line (\d+)/.exec(msg);
  if (line !== null) return Number(line[1]);
  const pos = /position (\d+)/.exec(msg);
  if (pos !== null) return text.slice(0, Math.min(Number(pos[1]), text.length)).split('\n').length;
  return 1;
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** `field` must be a finite number ≥ 0 when present (`required` forces presence). */
function checkNumber(obj: Record<string, unknown>, field: string, at: string, required: boolean): void {
  const v = obj[field];
  if (v === undefined && !required) return;
  if (!isFiniteNonNegative(v)) fail(`prices: ${at}.${field} must be a finite number ≥ 0`);
}

function checkDate(v: unknown, at: string): void {
  if (v === null) return;
  if (typeof v !== 'string' || !DATE_RE.test(v) || parseIso(v) === null) fail(`prices: ${at} must be YYYY-MM-DD or null`);
}

function validateWindowFields(w: Record<string, unknown>, at: string): void {
  checkDate(w['from'] ?? null, `${at}.from`);
  checkDate(w['until'] ?? null, `${at}.until`);
  checkNumber(w, 'input', at, true);
  checkNumber(w, 'output', at, true);
  for (const field of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteMult', 'reasoning']) checkNumber(w, field, at, false);
}

function validateRow(id: string, raw: unknown): PriceRow {
  const at = `models["${id}"]`;
  if (!isRecord(raw)) fail(`prices: ${at} must be an object`);
  const provider = raw['provider'];
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
    fail(`prices: ${at}.provider must be one of ${PROVIDERS.join('|')}`);
  }
  const match = raw['match'];
  if (match !== undefined && !(MATCHES as readonly unknown[]).includes(match)) {
    fail(`prices: ${at}.match must be one of ${MATCHES.join('|')}`);
  }
  if (match === 'regex') {
    try {
      new RegExp(id);
    } catch (err) {
      fail(`prices: ${at}: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const confidence = raw['confidence'];
  if (confidence !== undefined && !(CONFIDENCES as readonly unknown[]).includes(confidence)) {
    fail(`prices: ${at}.confidence must be one of ${CONFIDENCES.join('|')}`);
  }
  const aliasOf = raw['aliasOf'];
  if (aliasOf !== undefined && (typeof aliasOf !== 'string' || aliasOf.length === 0)) fail(`prices: ${at}.aliasOf must be a non-empty string`);
  const rates = raw['rates'];
  if (rates !== undefined) {
    if (!Array.isArray(rates)) fail(`prices: ${at}.rates must be an array`);
    for (let i = 0; i < rates.length; i++) {
      const w: unknown = rates[i];
      if (!isRecord(w)) fail(`prices: ${at}.rates[${i}] must be an object`);
      validateWindowFields(w, `${at}.rates[${i}]`);
    }
  }
  const tiers = raw['tiers'];
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) fail(`prices: ${at}.tiers must be an array`);
    for (let i = 0; i < tiers.length; i++) {
      const t: unknown = tiers[i];
      if (!isRecord(t)) fail(`prices: ${at}.tiers[${i}] must be an object`);
      const above = t['aboveInputTokens'];
      if (typeof above !== 'number' || !Number.isFinite(above) || above <= 0) {
        fail(`prices: ${at}.tiers[${i}].aboveInputTokens must be a finite number > 0`);
      }
      checkNumber(t, 'input', `${at}.tiers[${i}]`, true);
      checkNumber(t, 'output', `${at}.tiers[${i}]`, true);
      checkNumber(t, 'cacheRead', `${at}.tiers[${i}]`, false);
    }
  }
  const speeds = raw['speeds'];
  if (speeds !== undefined) {
    if (!isRecord(speeds)) fail(`prices: ${at}.speeds must be an object`);
    for (const [name, sp] of Object.entries(speeds)) {
      if (!isRecord(sp)) fail(`prices: ${at}.speeds["${name}"] must be an object`);
      checkNumber(sp, 'input', `${at}.speeds["${name}"]`, true);
      checkNumber(sp, 'output', `${at}.speeds["${name}"]`, true);
      checkNumber(sp, 'cacheRead', `${at}.speeds["${name}"]`, false);
    }
  }
  const windows = raw['windows'];
  if (windows !== undefined) {
    if (!Array.isArray(windows)) fail(`prices: ${at}.windows must be an array`);
    for (let i = 0; i < windows.length; i++) {
      const w: unknown = windows[i];
      if (!isRecord(w)) fail(`prices: ${at}.windows[${i}] must be an object`);
      if (typeof w['utc'] !== 'string' || !UTC_RANGE_RE.test(w['utc'])) fail(`prices: ${at}.windows[${i}].utc must be HH:MM-HH:MM`);
      checkNumber(w, 'input', `${at}.windows[${i}]`, true);
      checkNumber(w, 'output', `${at}.windows[${i}]`, true);
      checkNumber(w, 'cacheRead', `${at}.windows[${i}]`, false);
    }
  }
  const hasRates = Array.isArray(rates) && rates.length > 0;
  if (!hasRates && aliasOf === undefined && raw['unpriced'] !== true) fail(`prices: ${at} must have rates, aliasOf or unpriced`);
  return raw as unknown as PriceRow;
}

/**
 * Static alias targets (no `$` substitution) must exist and neither cycle
 * nor chain deeper than {@link MAX_ALIAS_DEPTH}. `extra` supplies base-table
 * keys when validating a standalone override.
 */
function checkAliases(models: Record<string, PriceRow>, extra?: Record<string, PriceRow>): void {
  const lookup = (key: string): PriceRow | undefined => models[key] ?? extra?.[key];
  for (const [id, row] of Object.entries(models)) {
    if (row.aliasOf === undefined || row.aliasOf.includes('$')) continue;
    const chain = [id];
    let current: PriceRow | undefined = row;
    while (current !== undefined && current.aliasOf !== undefined && !current.aliasOf.includes('$')) {
      const target: string = current.aliasOf;
      if (chain.includes(target)) fail(`prices: alias cycle ${[...chain, target].join(' → ')}`);
      chain.push(target);
      if (chain.length - 1 > MAX_ALIAS_DEPTH) fail(`prices: models["${id}"]: alias chain exceeds depth ${MAX_ALIAS_DEPTH}`);
      const next = lookup(target);
      if (next === undefined) fail(`prices: models["${chain[chain.length - 2]}"].aliasOf "${target}" not found`);
      current = next;
    }
  }
}

function validateDefaults(raw: unknown): Partial<Record<Provider, ProviderDefaults>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(`prices: "defaults" must be an object`);
  for (const [provider, d] of Object.entries(raw)) {
    if (!(PROVIDERS as readonly string[]).includes(provider)) fail(`prices: defaults["${provider}"] is not a known provider`);
    if (!isRecord(d)) fail(`prices: defaults["${provider}"] must be an object`);
    for (const field of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteMult']) checkNumber(d, field, `defaults["${provider}"]`, false);
  }
  return raw as Partial<Record<Provider, ProviderDefaults>>;
}

/**
 * Validates a parsed price table (a full table or an override). `base`
 * supplies the bundled table so an override may alias base rows. Throws
 * {@link PriceTableError} with the exact §8.1 message on the first problem.
 */
export function validateTable(raw: unknown, file: string, base?: PriceTable): PriceTable {
  if (!isRecord(raw)) fail(`prices: ${file}: expected an object`);
  const unit = raw['unit'];
  if (unit !== undefined && unit !== UNIT) fail(`prices: unsupported unit "${String(unit)}" (expected ${UNIT})`);
  const version = raw['version'];
  if (version !== undefined && (typeof version !== 'string' || version.length === 0)) fail(`prices: "version" must be a non-empty string`);
  const defaults = validateDefaults(raw['defaults']);
  const rawModels = raw['models'];
  if (!isRecord(rawModels)) fail(`prices: ${file}: "models" must be an object`);
  const models: Record<string, PriceRow> = {};
  for (const [id, row] of Object.entries(rawModels)) models[id] = validateRow(id, row);
  checkAliases(models, base?.models);
  return { version: typeof version === 'string' ? version : 'override', unit: UNIT, defaults, models };
}

/**
 * Parses and validates an override file's text. A JSON syntax error becomes
 * `prices: <file>: not valid JSON (line N)`; every schema problem carries
 * its §8.1 message. Callers decide the exit code (§8.1: `--prices` ⇒ 1,
 * the home override ⇒ reported once and ignored).
 */
export function parsePriceTable(text: string, file: string, base?: PriceTable): PriceTable {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`prices: ${file}: not valid JSON (line ${jsonErrorLine(text, err)})`);
  }
  return validateTable(raw, file, base);
}

/**
 * Merges an override into the base table: override rows replace base rows
 * by model key, provider defaults merge per field, and the version becomes
 * `<base.version>+<sha256(override)[:8]>` with `overrideHash` set (§8.1:
 * receipts print the suffix). Alias targets and cycles are re-checked over
 * the merged model set.
 */
export function mergeTables(base: PriceTable, override: PriceTable): PriceTable {
  const models: Record<string, PriceRow> = { ...base.models, ...override.models };
  const defaults: Partial<Record<Provider, ProviderDefaults>> = { ...base.defaults };
  for (const [provider, d] of Object.entries(override.defaults) as [Provider, ProviderDefaults][]) {
    defaults[provider] = { ...defaults[provider], ...d };
  }
  checkAliases(models);
  const hash = sha256(stableStringify({ defaults: override.defaults, models: override.models })).slice(0, 8);
  return { version: `${base.version}+${hash}`, unit: base.unit, defaults, models, overrideHash: hash };
}
