/**
 * The `--publish` whitelist validator (ARCHITECTURE Appendix D, §13.3): no
 * key outside the schema; every string value matches the publishable charset
 * and only `schema`/`generator.rulesVersion` may contain a `/`; months,
 * enums, finite non-negative numbers, the recomputed `contentHash`; a
 * day-precision (`YYYY-MM-DD`) scan over every string value except the
 * single `generator.pricesVersion` (which must itself be exactly a date);
 * and forbidden-substring scans over the serialised bytes (home path,
 * hostname, e-mail, session/short ids, the username on token boundaries).
 *
 * `bench.ts` runs this before every write and refuses to write on any
 * violation (§12.2 exit 1, the first rule named). Pure: no fs, no env, no
 * clock — the caller supplies the built-in model keys and machine facts.
 */
import type { ClaimKind, PublishPayload, Reason } from '../model/types.js';
import { HARNESSES } from '../model/types.js';
import { sha256 } from '../util/hash.js';
import { isRecord, stableStringify } from '../util/json.js';

/** Appendix D string charset (1–64 chars). */
export const PUBLISH_STRING_RE = /^[A-Za-z0-9.\-_/ ]{1,64}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_PRECISION_RE = /\d{4}-\d{2}-\d{2}/;
const HASH_RE = /^[0-9a-f]{16}$/;
const NODE_MAJOR_RE = /^\d+$/;
const HARNESS_VERSION_RE = /^\d+(\.\d+){1,3}$|^unknown$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The exact §13.3 key sets, per object. */
const TOP_KEYS = ['schema', 'generator', 'period', 'platform', 'contentHash', 'rows'] as const;
const GENERATOR_KEYS = ['name', 'version', 'rulesVersion', 'pricesVersion'] as const;
const PERIOD_KEYS = ['from', 'to', 'partial'] as const;
const PLATFORM_KEYS = ['os', 'node'] as const;
const ROW_KEYS = [
  'harness',
  'harnessVersion',
  'model',
  'sessions',
  'turns',
  'doneTurns',
  'contradictedTurns',
  'unverifiedTurns',
  'cleanTurns',
  'claims',
  'testRunRate',
  'integritySignals',
  'ledgerIncompleteSessions',
  'costPerDoneTurnUsd',
  'cacheHitPct',
  'contradictionReasons',
] as const;
const CLAIMS_KEYS = ['total', 'verified', 'unverified', 'contradicted', 'notScored', 'byKind'] as const;

/** Paths whose string value may contain a `/` (Appendix D). */
/** The two Appendix D paths whose value may contain a slash — exactly one. */
const SLASH_ALLOWED = new Set(['schema', 'generator.rulesVersion']);

const CLAIM_KINDS: readonly ClaimKind[] = [
  'file',
  'file-count',
  'test',
  'test-added',
  'test-ran',
  'check',
  'command',
  'install',
  'git',
  'verification',
  'completion',
  'no-change',
];

const REASONS: readonly Reason[] = [
  'ok',
  'ok-deleted-later',
  'no-evidence',
  'no-test-run',
  'last-run-red',
  'stale-run',
  'exit-unknown',
  'run-in-background',
  'count-short',
  'check-red',
  'no-check-run',
  'no-write-to-path',
  'write-failed',
  'ambiguous-path',
  'file-not-deleted',
  'no-git-op',
  'git-op-failed',
  'sha-mismatch',
  'commit-precedes-edits',
  'push-precedes-commit',
  'no-command',
  'command-failed',
  'no-run-after-write',
  'writes-despite-no-change',
  'echoed',
  'partial',
  'not-scored',
  'ledger-incomplete',
  'write-not-observable',
];

/** The machine facts and scanned ids the forbidden-substring rules test against. */
export interface PublishContext {
  /** Keys of the built-in price table (`model` must be one of them or `other`). */
  builtinModelKeys: ReadonlySet<string>;
  /** Absolute home paths that must never appear in the file. */
  homePaths: readonly string[];
  /** The machine hostname (skipped when shorter than 2 chars). */
  hostname?: string | undefined;
  /** Usernames ≥ 6 chars, matched on token boundaries. */
  usernames: readonly string[];
  /** Every scanned full session id. */
  sessionIds: readonly string[];
  /** Every scanned short id (matched on hex-token boundaries). */
  shortIds: readonly string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Flags keys outside `allowed` on one object. */
function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push(`unknown-key: ${path}.${key}`);
  }
}

function checkString(value: unknown, path: string, out: string[]): value is string {
  if (typeof value !== 'string') {
    out.push(`type: ${path} must be a string`);
    return false;
  }
  if (!PUBLISH_STRING_RE.test(value)) {
    out.push(`string-charset: ${path} '${value.slice(0, 64)}'`);
    return false;
  }
  if (value.includes('/') && (!SLASH_ALLOWED.has(path) || value.indexOf('/') !== value.lastIndexOf('/'))) {
    out.push(`slash: ${path} '${value}'`);
    return false;
  }
  return true;
}

function checkCount(value: unknown, path: string, out: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    out.push(`number: ${path} must be a finite number >= 0`);
  }
}

function checkNullableCount(value: unknown, path: string, out: string[]): void {
  if (value === null) return;
  checkCount(value, path, out);
}

function checkRow(row: unknown, path: string, ctx: PublishContext, out: string[]): void {
  if (!isRecord(row)) {
    out.push(`type: ${path} must be an object`);
    return;
  }
  checkKeys(row, ROW_KEYS, path, out);
  if (checkString(row['harness'], `${path}.harness`, out) && !(HARNESSES as readonly string[]).includes(row['harness'] as string)) {
    out.push(`harness-enum: ${path}.harness '${String(row['harness'])}'`);
  }
  if (checkString(row['harnessVersion'], `${path}.harnessVersion`, out) && !HARNESS_VERSION_RE.test(row['harnessVersion'] as string)) {
    out.push(`harness-version: ${path}.harnessVersion '${String(row['harnessVersion'])}'`);
  }
  if (checkString(row['model'], `${path}.model`, out)) {
    const model = row['model'] as string;
    if (model !== 'other' && !ctx.builtinModelKeys.has(model)) out.push(`model-key: ${path}.model '${model}'`);
  }
  for (const key of ['sessions', 'turns', 'doneTurns', 'contradictedTurns', 'unverifiedTurns', 'cleanTurns', 'integritySignals', 'ledgerIncompleteSessions'] as const) {
    checkCount(row[key], `${path}.${key}`, out);
  }
  for (const key of ['testRunRate', 'costPerDoneTurnUsd', 'cacheHitPct'] as const) {
    checkNullableCount(row[key], `${path}.${key}`, out);
  }
  const claims = row['claims'];
  if (!isRecord(claims)) {
    out.push(`type: ${path}.claims must be an object`);
  } else {
    checkKeys(claims, CLAIMS_KEYS, `${path}.claims`, out);
    for (const key of ['total', 'verified', 'unverified', 'contradicted', 'notScored'] as const) {
      checkCount(claims[key], `${path}.claims.${key}`, out);
    }
    const byKind = claims['byKind'];
    if (!isRecord(byKind)) {
      out.push(`type: ${path}.claims.byKind must be an object`);
    } else {
      for (const [kind, count] of Object.entries(byKind)) {
        if (!(CLAIM_KINDS as readonly string[]).includes(kind)) out.push(`claim-kind: ${path}.claims.byKind.${kind}`);
        checkCount(count, `${path}.claims.byKind.${kind}`, out);
      }
    }
  }
  const reasons = row['contradictionReasons'];
  if (!isRecord(reasons)) {
    out.push(`type: ${path}.contradictionReasons must be an object`);
  } else {
    for (const [reason, count] of Object.entries(reasons)) {
      if (!(REASONS as readonly string[]).includes(reason)) out.push(`reason-enum: ${path}.contradictionReasons.${reason}`);
      checkCount(count, `${path}.contradictionReasons.${reason}`, out);
    }
  }
}

/** Every string value of the payload with its dotted path. */
function stringValues(value: unknown, path: string, out: [string, string][]): void {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      stringValues(v, `${path}[${i}]`, out);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) stringValues(v, path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * Validates a payload plus its exact serialised bytes against every
 * Appendix D rule. Returns `[]` when publishable, else one
 * `rule: detail` line per violation — the caller refuses to write and names
 * the first rule (§12.2 exit 1).
 */
export function validatePublish(payload: PublishPayload, serialized: string, ctx: PublishContext): string[] {
  const out: string[] = [];
  const p = payload as unknown as Record<string, unknown>;
  checkKeys(p, TOP_KEYS, 'payload', out);
  if (p['schema'] !== 'showreceipts.bench-publish/1') out.push(`schema: expected showreceipts.bench-publish/1`);

  const generator = p['generator'];
  if (!isRecord(generator)) {
    out.push('type: generator must be an object');
  } else {
    checkKeys(generator, GENERATOR_KEYS, 'generator', out);
    if (generator['name'] !== 'showreceipts') out.push(`schema: generator.name must be showreceipts`);
    checkString(generator['version'], 'generator.version', out);
    checkString(generator['rulesVersion'], 'generator.rulesVersion', out);
    if (checkString(generator['pricesVersion'], 'generator.pricesVersion', out) && !DATE_RE.test(generator['pricesVersion'] as string)) {
      out.push(`prices-version: generator.pricesVersion '${String(generator['pricesVersion'])}' must be YYYY-MM-DD`);
    }
  }

  const period = p['period'];
  if (!isRecord(period)) {
    out.push('type: period must be an object');
  } else {
    checkKeys(period, PERIOD_KEYS, 'period', out);
    for (const key of ['from', 'to'] as const) {
      if (checkString(period[key], `period.${key}`, out) && !MONTH_RE.test(period[key] as string)) {
        out.push(`month-format: period.${key} '${String(period[key])}'`);
      }
    }
    if (typeof period['partial'] !== 'boolean') out.push('type: period.partial must be a boolean');
  }

  const platform = p['platform'];
  if (!isRecord(platform)) {
    out.push('type: platform must be an object');
  } else {
    checkKeys(platform, PLATFORM_KEYS, 'platform', out);
    checkString(platform['os'], 'platform.os', out);
    if (checkString(platform['node'], 'platform.node', out) && !NODE_MAJOR_RE.test(platform['node'] as string)) {
      out.push(`node-major: platform.node '${String(platform['node'])}'`);
    }
  }

  const rows = p['rows'];
  if (!Array.isArray(rows)) {
    out.push('type: rows must be an array');
  } else {
    rows.forEach((row, i) => {
      checkRow(row, `rows[${i}]`, ctx, out);
    });
    const hash = p['contentHash'];
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      out.push(`content-hash: contentHash must be 16 hex chars`);
    } else if (hash !== sha256(stableStringify(rows)).slice(0, 16)) {
      out.push(`content-hash: contentHash does not match the rows`);
    }
  }

  // Day-precision scan over every string value except generator.pricesVersion.
  const strings: [string, string][] = [];
  stringValues(p, '', strings);
  for (const [path, value] of strings) {
    if (path === 'generator.pricesVersion') continue;
    if (DAY_PRECISION_RE.test(value)) out.push(`day-precision: ${path} '${value}'`);
  }

  // Forbidden substrings over the exact serialised bytes.
  for (const home of ctx.homePaths) {
    if (home.length > 1 && serialized.includes(home)) out.push(`home-path: the file contains '${home}'`);
  }
  if (ctx.hostname !== undefined && ctx.hostname.length >= 2 && serialized.includes(ctx.hostname)) {
    out.push(`hostname: the file contains the machine hostname`);
  }
  if (EMAIL_RE.test(serialized)) out.push('email: the file contains an e-mail address');
  for (const id of ctx.sessionIds) {
    if (id.length >= 8 && serialized.includes(id)) out.push(`session-id: the file contains session id ${id.slice(0, 8)}…`);
  }
  for (const shortId of ctx.shortIds) {
    if (shortId.length < 6) continue;
    if (new RegExp(`(?<![0-9a-fA-F])${escapeRegExp(shortId)}(?![0-9a-fA-F])`).test(serialized)) {
      out.push(`short-id: the file contains short id ${shortId}`);
    }
  }
  for (const user of ctx.usernames) {
    if (user.length < 6) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`).test(serialized)) {
      out.push(`username: the file contains '${user}'`);
    }
  }
  return out;
}
