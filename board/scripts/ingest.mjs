// board/scripts/ingest.mjs
//
// Pure Node, zero dependencies. Parses a `bench --publish` JSON payload that
// a submitter pasted into a board-submission issue, validates it against the
// published-fields whitelist (mirroring src/bench/validate.ts and the schema
// in docs/privacy.md "The bench --publish payload"), and merges its rows into
// board/data/rows.json.
//
// SECURITY: submission issue bodies are untrusted input. This script never
// executes the submitted text, never touches the network, never reads a
// filesystem path out of the
// payload. It whitelists every key, caps sizes, and rejects anything carrying
// a filesystem path, an e-mail, a day-precision date, or a key outside the
// schema. The workflow that calls it opens a PR for a human to review; nothing
// here auto-merges to main.

import { createHash } from 'node:crypto';

// --------------------------------------------------------------------------
// Size caps (untrusted input)
// --------------------------------------------------------------------------
export const MAX_ISSUE_BODY_BYTES = 64 * 1024; // 64 KB of issue text
export const MAX_PAYLOAD_BYTES = 48 * 1024; // 48 KB of pasted JSON
export const MAX_ROWS = 200; // per submission

// --------------------------------------------------------------------------
// Publication threshold (a render concern for the board, mirrored here so the
// ingest tests can assert the shape; a below-threshold row still ingests).
// --------------------------------------------------------------------------
export const MIN_DONE_TURNS = 50;
export const MIN_SUBMITTERS = 5;

// --------------------------------------------------------------------------
// Whitelist mirror of src/bench/validate.ts
// --------------------------------------------------------------------------
const PUBLISH_STRING_RE = /^[A-Za-z0-9.\-_/ ]{1,64}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_PRECISION_RE = /\d{4}-\d{2}-\d{2}/;
const HASH_RE = /^[0-9a-f]{16}$/;
const NODE_MAJOR_RE = /^\d+$/;
const HARNESS_VERSION_RE = /^\d+(\.\d+){1,3}$|^unknown$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const TOP_KEYS = ['schema', 'generator', 'period', 'platform', 'contentHash', 'rows'];
const GENERATOR_KEYS = ['name', 'version', 'rulesVersion', 'pricesVersion'];
const PERIOD_KEYS = ['from', 'to', 'partial'];
const PLATFORM_KEYS = ['os', 'node'];
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
];
const CLAIMS_KEYS = ['total', 'verified', 'unverified', 'contradicted', 'notScored', 'byKind'];

// Exactly the two paths whose string value may carry a single '/'.
const SLASH_ALLOWED = new Set(['schema', 'generator.rulesVersion']);

export const HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'hermes',
  'dsh',
  'opencode',
  'openclaw',
];

const CLAIM_KINDS = [
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

const REASONS = [
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

// Built-in price-table keys mirrored from docs/prices.md. `model` must be one
// of these or the literal `other`; anything else is rejected. The set is a
// snapshot; the maintainer reviews every PR, so an unlisted-but-real key just
// fails closed here and can be added on review.
export const BUILTIN_MODEL_KEYS = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-2025',
  'claude-opus-4-0',
  'claude-3-opus',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet',
  'claude-haiku-4-5',
  'claude-3-5-haiku',
  'claude-3-haiku',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]);

// --------------------------------------------------------------------------
// Deterministic JSON (mirror of src/util/json.ts stableStringify)
// --------------------------------------------------------------------------
export function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringifyValue(value, seen) {
  const v = value;
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) return 'null';
      return Object.is(v, -0) ? '0' : String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (v === null) return 'null';
  if (seen.has(v)) throw new TypeError('stableStringify: circular structure');
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = `[${v.map((item) => stringifyValue(item, seen) ?? 'null').join(',')}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(v).sort()) {
      const encoded = stringifyValue(v[key], seen);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    out = `{${parts.join(',')}}`;
  }
  seen.delete(v);
  return out;
}

export function stableStringify(v) {
  const out = stringifyValue(v, new Set());
  if (out === undefined) throw new TypeError('stableStringify: top-level value is not serialisable');
  return out;
}

function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------
function checkKeys(value, allowed, path, out) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push(`unknown-key: ${path}.${key}`);
  }
}

function checkString(value, path, out) {
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

function checkCount(value, path, out) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    out.push(`number: ${path} must be a finite number >= 0`);
  }
}

function checkNullableCount(value, path, out) {
  if (value === null) return;
  checkCount(value, path, out);
}

function checkRow(row, path, out) {
  if (!isRecord(row)) {
    out.push(`type: ${path} must be an object`);
    return;
  }
  checkKeys(row, ROW_KEYS, path, out);
  if (checkString(row.harness, `${path}.harness`, out) && !HARNESSES.includes(row.harness)) {
    out.push(`harness-enum: ${path}.harness '${String(row.harness)}'`);
  }
  if (checkString(row.harnessVersion, `${path}.harnessVersion`, out) && !HARNESS_VERSION_RE.test(row.harnessVersion)) {
    out.push(`harness-version: ${path}.harnessVersion '${String(row.harnessVersion)}'`);
  }
  if (checkString(row.model, `${path}.model`, out)) {
    if (row.model !== 'other' && !BUILTIN_MODEL_KEYS.has(row.model)) out.push(`model-key: ${path}.model '${row.model}'`);
  }
  for (const key of ['sessions', 'turns', 'doneTurns', 'contradictedTurns', 'unverifiedTurns', 'cleanTurns', 'integritySignals', 'ledgerIncompleteSessions']) {
    checkCount(row[key], `${path}.${key}`, out);
  }
  for (const key of ['testRunRate', 'costPerDoneTurnUsd', 'cacheHitPct']) {
    checkNullableCount(row[key], `${path}.${key}`, out);
  }
  const claims = row.claims;
  if (!isRecord(claims)) {
    out.push(`type: ${path}.claims must be an object`);
  } else {
    checkKeys(claims, CLAIMS_KEYS, `${path}.claims`, out);
    for (const key of ['total', 'verified', 'unverified', 'contradicted', 'notScored']) {
      checkCount(claims[key], `${path}.claims.${key}`, out);
    }
    const byKind = claims.byKind;
    if (!isRecord(byKind)) {
      out.push(`type: ${path}.claims.byKind must be an object`);
    } else {
      for (const [kind, count] of Object.entries(byKind)) {
        if (!CLAIM_KINDS.includes(kind)) out.push(`claim-kind: ${path}.claims.byKind.${kind}`);
        checkCount(count, `${path}.claims.byKind.${kind}`, out);
      }
    }
  }
  const reasons = row.contradictionReasons;
  if (!isRecord(reasons)) {
    out.push(`type: ${path}.contradictionReasons must be an object`);
  } else {
    for (const [reason, count] of Object.entries(reasons)) {
      if (!REASONS.includes(reason)) out.push(`reason-enum: ${path}.contradictionReasons.${reason}`);
      checkCount(count, `${path}.contradictionReasons.${reason}`, out);
    }
  }
}

function stringValues(value, path, out) {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => stringValues(v, `${path}[${i}]`, out));
    return;
  }
  if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) stringValues(v, path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * Validates a parsed payload against every whitelist rule. Returns [] when
 * publishable, else one `rule: detail` line per violation. `serialized` is the
 * exact JSON text the payload was parsed from (used for the e-mail scan).
 */
export function validatePublishPayload(payload, serialized) {
  const out = [];
  if (!isRecord(payload)) {
    return ['type: payload must be an object'];
  }
  const p = payload;
  checkKeys(p, TOP_KEYS, 'payload', out);
  if (p.schema !== 'showreceipts.bench-publish/1') out.push('schema: expected showreceipts.bench-publish/1');

  const generator = p.generator;
  if (!isRecord(generator)) {
    out.push('type: generator must be an object');
  } else {
    checkKeys(generator, GENERATOR_KEYS, 'generator', out);
    if (generator.name !== 'showreceipts') out.push('schema: generator.name must be showreceipts');
    checkString(generator.version, 'generator.version', out);
    checkString(generator.rulesVersion, 'generator.rulesVersion', out);
    if (checkString(generator.pricesVersion, 'generator.pricesVersion', out) && !DATE_RE.test(generator.pricesVersion)) {
      out.push(`prices-version: generator.pricesVersion '${String(generator.pricesVersion)}' must be YYYY-MM-DD`);
    }
  }

  const period = p.period;
  if (!isRecord(period)) {
    out.push('type: period must be an object');
  } else {
    checkKeys(period, PERIOD_KEYS, 'period', out);
    for (const key of ['from', 'to']) {
      if (checkString(period[key], `period.${key}`, out) && !MONTH_RE.test(period[key])) {
        out.push(`month-format: period.${key} '${String(period[key])}'`);
      }
    }
    if (typeof period.partial !== 'boolean') out.push('type: period.partial must be a boolean');
  }

  const platform = p.platform;
  if (!isRecord(platform)) {
    out.push('type: platform must be an object');
  } else {
    checkKeys(platform, PLATFORM_KEYS, 'platform', out);
    checkString(platform.os, 'platform.os', out);
    if (checkString(platform.node, 'platform.node', out) && !NODE_MAJOR_RE.test(platform.node)) {
      out.push(`node-major: platform.node '${String(platform.node)}'`);
    }
  }

  const rows = p.rows;
  if (!Array.isArray(rows)) {
    out.push('type: rows must be an array');
  } else if (rows.length > MAX_ROWS) {
    out.push(`too-many-rows: ${rows.length} > ${MAX_ROWS}`);
  } else {
    rows.forEach((row, i) => checkRow(row, `rows[${i}]`, out));
    const hash = p.contentHash;
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      out.push('content-hash: contentHash must be 16 hex chars');
    } else if (hash !== sha256hex(stableStringify(rows)).slice(0, 16)) {
      out.push('content-hash: contentHash does not match the rows');
    }
  }

  // Day-precision scan over every string value except generator.pricesVersion.
  const strings = [];
  stringValues(p, '', strings);
  for (const [path, value] of strings) {
    if (path === 'generator.pricesVersion') continue;
    if (DAY_PRECISION_RE.test(value)) out.push(`day-precision: ${path} '${value}'`);
  }

  // E-mail scan over the exact serialised bytes.
  if (typeof serialized === 'string' && EMAIL_RE.test(serialized)) {
    out.push('email: the file contains an e-mail address');
  }

  return out;
}

// --------------------------------------------------------------------------
// Extract the pasted JSON from a GitHub issue-form body
// --------------------------------------------------------------------------
/**
 * The issue form (see .github/ISSUE_TEMPLATE/board-submission.yml) renders the
 * pasted JSON under a "### Publish payload" heading, usually inside a fenced
 * code block. This pulls the first balanced JSON object out of the body without
 * ever executing it. Returns { json, text } or throws on size/shape.
 */
export function extractPayloadText(issueBody) {
  if (typeof issueBody !== 'string') throw new Error('issue body must be a string');
  if (Buffer.byteLength(issueBody, 'utf8') > MAX_ISSUE_BODY_BYTES) {
    throw new Error(`issue body exceeds ${MAX_ISSUE_BODY_BYTES} bytes`);
  }
  // Prefer a fenced ```json ... ``` (or plain ``` ... ```) block.
  let candidate = null;
  const fence = issueBody.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1];
  if (candidate === null || candidate.indexOf('{') === -1) {
    // Fall back to the first balanced {...} span in the whole body.
    candidate = issueBody;
  }
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in issue body');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('unbalanced JSON object in issue body');
  const text = candidate.slice(start, end + 1);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`pasted JSON exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const json = JSON.parse(text); // JSON.parse only; the text is never executed
  return { json, text };
}

// --------------------------------------------------------------------------
// Merge into the board
// --------------------------------------------------------------------------
/** Collapse a full harness version (2.1.214) to its display form (2.1.x). */
export function collapseVersion(v) {
  if (typeof v !== 'string' || v === 'unknown') return 'unknown';
  const m = v.match(/^(\d+)\.(\d+)(?:\.\d+)*$/);
  return m ? `${m[1]}.${m[2]}.x` : v;
}

/** The board row a publish row maps to. */
function boardKey(harness, versionDisplay, model, rulesVersion) {
  return [harness, versionDisplay, model, rulesVersion].join(' ');
}

export function emptyBoard() {
  return {
    schema: 'showreceipts.board/1',
    note: 'Aggregated board rows. Every row is merged from bench --publish submissions reviewed by a human. See board/README.md.',
    thresholds: { minDoneTurns: MIN_DONE_TURNS, minSubmitters: MIN_SUBMITTERS },
    rows: [],
  };
}

/**
 * Merges a validated payload into a board object, returning a NEW board object
 * (does not mutate the input). `submitter` is a stable token for the source
 * submission (e.g. "issue-42"); it is added to each touched row's submitter set
 * so re-running the same issue never double-counts. `handle` is an optional
 * public handle recorded alongside the submitter token.
 */
export function mergePayloadIntoBoard(board, payload, submitter, handle) {
  const next = board && isRecord(board) && Array.isArray(board.rows) ? structuredCloneSafe(board) : emptyBoard();
  const rulesVersion = payload.generator.rulesVersion;
  const index = new Map();
  for (const row of next.rows) {
    index.set(boardKey(row.harness, row.harnessVersion, row.model, row.rulesVersion), row);
  }
  const submitterToken = String(submitter || 'unknown');
  for (const r of payload.rows) {
    const versionDisplay = collapseVersion(r.harnessVersion);
    const key = boardKey(r.harness, versionDisplay, r.model, rulesVersion);
    let row = index.get(key);
    if (!row) {
      row = {
        harness: r.harness,
        harnessVersion: versionDisplay,
        model: r.model,
        rulesVersion,
        sessions: 0,
        turns: 0,
        doneTurns: 0,
        contradictedTurns: 0,
        unverifiedTurns: 0,
        cleanTurns: 0,
        submitters: [],
        exemplar: false,
      };
      next.rows.push(row);
      index.set(key, row);
    }
    row.sessions += r.sessions;
    row.turns += r.turns;
    row.doneTurns += r.doneTurns;
    row.contradictedTurns += r.contradictedTurns;
    row.unverifiedTurns += r.unverifiedTurns;
    row.cleanTurns += r.cleanTurns;
    if (!row.submitters.some((s) => s.id === submitterToken)) {
      row.submitters.push(handle ? { id: submitterToken, handle: String(handle).slice(0, 64) } : { id: submitterToken });
    }
    // A real submission overrides an exemplar seed of the same key.
    row.exemplar = false;
  }
  next.rows.sort((a, b) => b.doneTurns - a.doneTurns || a.model.localeCompare(b.model));
  return next;
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

// --------------------------------------------------------------------------
// One-shot orchestration: text in, board out
// --------------------------------------------------------------------------
/**
 * Parse + validate + merge. Returns { ok, errors, board, payload }.
 * `boardText` is the current board/data/rows.json contents (or "").
 * `issueBody` is the untrusted issue body. Never throws on invalid input:
 * a bad payload comes back as { ok: false, errors }.
 */
export function ingest(boardText, issueBody, opts = {}) {
  let board;
  try {
    board = boardText && boardText.trim() ? JSON.parse(boardText) : emptyBoard();
  } catch {
    return { ok: false, errors: ['board-file: existing rows.json is not valid JSON'], board: null, payload: null };
  }
  let extracted;
  try {
    extracted = extractPayloadText(issueBody);
  } catch (e) {
    return { ok: false, errors: [`parse: ${e.message}`], board, payload: null };
  }
  const errors = validatePublishPayload(extracted.json, extracted.text);
  if (errors.length) return { ok: false, errors, board, payload: null };
  const merged = mergePayloadIntoBoard(board, extracted.json, opts.submitter, opts.handle);
  return { ok: true, errors: [], board: merged, payload: extracted.json };
}

// --------------------------------------------------------------------------
// CLI: node board/scripts/ingest.mjs --board <path> --issue-body-file <path> \
//        --out <path> --submitter issue-42 --handle someone
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

async function mainCli() {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const args = parseArgs(process.argv.slice(2));
  const boardPath = args.board || 'board/data/rows.json';
  let boardText = '';
  try {
    boardText = readFileSync(boardPath, 'utf8');
  } catch {
    boardText = '';
  }
  let issueBody = '';
  if (args['issue-body-file']) issueBody = readFileSync(args['issue-body-file'], 'utf8');
  else if (args['issue-body']) issueBody = args['issue-body'];
  else {
    process.stderr.write('ingest: provide --issue-body-file <path> or --issue-body <text>\n');
    process.exit(2);
  }
  const result = ingest(boardText, issueBody, { submitter: args.submitter, handle: args.handle });
  if (!result.ok) {
    process.stderr.write('ingest: rejected\n');
    for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  const outPath = args.out || boardPath;
  writeFileSync(outPath, JSON.stringify(result.board, null, 2) + '\n');
  process.stderr.write(`ingest: merged into ${outPath}\n`);
}

// Run the CLI only when invoked directly, not when imported by the tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    process.stderr.write(`ingest: ${e.message}\n`);
    process.exit(1);
  });
}
