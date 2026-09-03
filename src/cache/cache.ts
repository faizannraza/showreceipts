/**
 * The per-file parse cache (ARCHITECTURE §4.9). The cache holds the output of
 * read+timeline+ledger; claims, reconcile, rate and cost run post-cache over
 * the stored rows, which is why `rulesVersion` and `pricesVersion` are
 * deliberately absent from the key: `--as-of`, price overrides and rule bumps
 * must never force a re-parse. Entries are trimmed (`trimForCache`), masked
 * (`util/mask.ts`), written atomically with mode `0600` under a `0700`
 * directory, and validated on read — corrupt JSON or a foreign version is a
 * miss, counted for `Diagnostics.corruptCache`.
 *
 * This module never reads `process.env`: `SHOWRECEIPTS_NO_CACHE=1` and
 * `--no-cache` are resolved by the caller and arrive as `disabled: true`.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { Cost, Session, SessionRef } from '../model/types.js';
import { atomicWriteFile, ensureDir, statOrNull } from '../util/fs.js';
import { sha256 } from '../util/hash.js';
import { isRecord, parseJsonSafe, stableStringify } from '../util/json.js';
import { maskDeep, maskSecrets } from '../util/mask.js';

/** `resultText` cap per tool call inside a cache entry (§4.9). */
export const RESULT_TEXT_CAP = 512;
/** `finalText` cap per turn inside a cache entry (§4.9). */
const FINAL_TEXT_CAP = 64 * 1024;
/** The per-path index the Stop hook uses (`lookupByPath`), beside the entries. */
const INDEX_NAME = 'index.json';
const KEY_RE = /^[0-9a-f]{64}$/;
/** The `Input` keys a cache entry keeps; every other input body is dropped (§4.9). */
const KEPT_INPUT_KEYS: readonly string[] = ['file_path', 'command', 'description', 'pattern', 'url'];

/** One stored parse: the trimmed session plus the incremental-tail state (§4.9, S27b). */
export interface CacheEntry {
  v: 1;
  /** The `cacheKey` this entry was stored under. */
  key: string;
  /** The `trimForCache`d session (never prompt text, patch bodies or dollars). */
  session: Session;
  /** Bytes of the main transcript consumed by the parse — always a line boundary. */
  bytesParsed: number;
  /** `sha256` of the 4 KiB preceding `bytesParsed` (resume guard). */
  tailHash: string;
  /** Serialised reader state for the Stop hook's incremental tail parse. */
  builderState?: string;
}

export interface CacheStats {
  /** Entry files currently stored (the path index is not an entry). */
  entries: number;
  /** Total bytes of those entry files. */
  bytes: number;
  /** Corrupt or foreign-version entries seen by this cache instance (→ `Diagnostics.corruptCache`). */
  corrupt: number;
}

export interface ParseCache {
  /** The stored entry for `key`, or `null` (miss). Corruption is a miss and is counted. */
  get(key: string): CacheEntry | null;
  /** Stores `entry` under `key` (atomic, `0600`, masked) and points the path index at it. */
  put(key: string, entry: CacheEntry): void;
  /** Removes every file in the cache directory (`doctor --clear-cache`). */
  clear(): void;
  /** Entry count, bytes and the corrupt-entry counter. */
  stats(): CacheStats;
  /** The newest entry stored for a transcript path, without re-keying by size/mtime (Stop hook, S27b). */
  lookupByPath(path: string): CacheEntry | null;
  /** True when `SHOWRECEIPTS_NO_CACHE=1` / `--no-cache` disabled this instance (resolved by the caller). */
  readonly disabled: boolean;
}

export interface CacheOptions {
  /** The cache directory (`<showreceiptsHome>/cache`). */
  dir: string;
  /** Part of every key and of the path index hash: a new tool version re-parses everything. */
  toolVersion: string;
  /** `SHOWRECEIPTS_NO_CACHE=1` / `--no-cache`, resolved by the caller — never read from `process.env` here. */
  disabled?: boolean;
}

/**
 * The cache key (§4.9): `sha256(realpath · size · mtimeMs · toolVersion ·
 * subagentManifest)`. `ref.path` is already under a realpath-resolved root
 * (discovery resolves roots exactly once) and the manifest arrives sorted, so
 * the key is pure over the ref. `rulesVersion` and `pricesVersion` are
 * deliberately not parameters: claims, reconcile, rate and cost run
 * post-cache, so nothing they depend on may invalidate an entry.
 */
export function cacheKey(ref: SessionRef, toolVersion: string): string {
  const manifest = ref.subagentManifest.map((entry) => `${entry.rel}\u0000${entry.size}\u0000${entry.mtimeMs}`).join('\u0001');
  return sha256([ref.path, String(ref.size), String(ref.mtimeMs), toolVersion, manifest].join('\u0000'));
}

/** The path-index hash (§4.9): `sha256(realpath · toolVersion)` — the Stop hook's stable per-file handle. */
export function pathKey(realpath: string, toolVersion: string): string {
  return sha256(`${realpath}\u0000${toolVersion}`);
}

/** Truncates a string to at most `maxBytes` of UTF-8, cutting on a code-point boundary (also used by `pipeline/receipt.ts` for warm/cold result-head parity). */
export function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** The empty `Cost` shape a cached session carries — cost is always recomputed post-cache. */
function emptyCost(): Cost {
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
    pricesVersion: '',
    notes: [],
  };
}

/**
 * Returns a copy of `session` trimmed to what a cache entry may hold (§4.9);
 * the input is never mutated (S18 keeps using the full session in memory).
 * Per tool call: `resultText` masked and capped at 512 bytes; `patch`,
 * `attempted` and the `input` body dropped (`input` keeps only `file_path`,
 * `command`, `description`, `pattern`, `url`). Per turn: `userText: null`
 * (only `echoHashes` survive — never prompt text), `finalText` capped at
 * 64 KiB, `costUsd: null`. `UsageRow[]`/`TokenDelta[]` are kept minus
 * `inherited` (it depends on the scanned set), and `Session.cost` is reset to
 * its empty shape — a cache entry never carries dollars.
 */
export function trimForCache(session: Session): Session {
  const out = structuredClone(session);
  for (const turn of out.turns) {
    turn.userText = null;
    if (turn.finalText !== null) turn.finalText = truncateBytes(turn.finalText, FINAL_TEXT_CAP);
    turn.costUsd = null;
  }
  for (const call of out.toolCalls) {
    call.resultText = truncateBytes(maskSecrets(call.resultText), RESULT_TEXT_CAP);
    delete call.patch;
    delete call.attempted;
    const input: Record<string, unknown> = {};
    for (const key of KEPT_INPUT_KEYS) {
      if (key in call.input) input[key] = call.input[key];
    }
    call.input = input;
  }
  for (const row of out.usageRows) delete row.inherited;
  // `planUsagePct` is a logged rate-limit fact (§4.3.5), not a computed
  // dollar amount, and it cannot be re-derived from `TokenDelta[]` — carry it
  // across the reset so warm receipts match cold ones (S18).
  const planUsagePct = session.cost.planUsagePct;
  out.cost = emptyCost();
  if (planUsagePct !== undefined) out.cost.planUsagePct = planUsagePct;
  return out;
}

/** Validates a parsed entry file; `null` for anything that is not a `v: 1` entry stored under `key`. */
function validateEntry(parsed: unknown, key: string): CacheEntry | null {
  if (!isRecord(parsed)) return null;
  if (parsed['v'] !== 1) return null;
  if (parsed['key'] !== key) return null;
  if (!isRecord(parsed['session'])) return null;
  if (typeof parsed['bytesParsed'] !== 'number') return null;
  if (typeof parsed['tailHash'] !== 'string') return null;
  if ('builderState' in parsed && typeof parsed['builderState'] !== 'string') return null;
  return parsed as unknown as CacheEntry;
}

/**
 * Opens (lazily) the parse cache at `options.dir`. Nothing is created until
 * the first `put`; reads of a missing directory are plain misses. A disabled
 * cache never reads or writes and `get`/`lookupByPath` always miss.
 */
export function createCache(options: CacheOptions): ParseCache {
  const { dir, toolVersion } = options;
  const disabled = options.disabled === true;
  const indexPath = join(dir, INDEX_NAME);
  let corrupt = 0;

  /** The tolerant path index: `{ v: 1, byPath: { sha256(path·toolVersion): key } }`. */
  function readIndex(): Record<string, string> {
    const parsed = parseJsonSafe(readFileOrNull(indexPath) ?? '');
    if (!isRecord(parsed) || parsed['v'] !== 1 || !isRecord(parsed['byPath'])) return {};
    const byPath: Record<string, string> = {};
    for (const [hash, key] of Object.entries(parsed['byPath'])) {
      if (typeof key === 'string' && KEY_RE.test(key)) byPath[hash] = key;
    }
    return byPath;
  }

  function get(key: string): CacheEntry | null {
    if (disabled || !KEY_RE.test(key)) return null;
    const text = readFileOrNull(join(dir, `${key}.json`));
    if (text === null) return null;
    const entry = validateEntry(parseJsonSafe(text), key);
    if (entry === null) {
      corrupt += 1;
      return null;
    }
    return entry;
  }

  function put(key: string, entry: CacheEntry): void {
    if (disabled) return;
    if (!KEY_RE.test(key)) throw new TypeError(`cache.put: not a cache key: ${key}`);
    if (entry.key !== key) throw new TypeError('cache.put: entry.key does not match the key it is stored under');
    ensureDir(dir, 0o700);
    atomicWriteFile(join(dir, `${key}.json`), stableStringify(maskDeep(entry)), { mode: 0o600 });
    const path = entry.session.transcriptPath;
    if (typeof path === 'string' && path !== '') {
      const byPath = readIndex();
      byPath[pathKey(path, toolVersion)] = key;
      atomicWriteFile(indexPath, stableStringify({ v: 1, byPath }), { mode: 0o600 });
    }
  }

  function clear(): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        fs.unlinkSync(join(dir, name));
      } catch {
        // a concurrent clear already removed it
      }
    }
  }

  function stats(): CacheStats {
    let entries = 0;
    let bytes = 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // missing directory: zero entries
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const stat = statOrNull(join(dir, name));
      if (stat === null || !stat.isFile()) continue;
      entries += 1;
      bytes += stat.size;
    }
    return { entries, bytes, corrupt };
  }

  function lookupByPath(path: string): CacheEntry | null {
    if (disabled) return null;
    const key = readIndex()[pathKey(path, toolVersion)];
    return key === undefined ? null : get(key);
  }

  return { get, put, clear, stats, lookupByPath, disabled };
}

/** `readFileSync` as UTF-8, or `null` when the file is missing or unreadable. */
function readFileOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
