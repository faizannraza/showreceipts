// board/scripts/ingest.test.mjs
//
// Zero-dependency tests for ingest.mjs, runnable with:
//   node board/scripts/ingest.test.mjs
//
// Covers: a valid payload merges; a payload carrying a filesystem path is
// rejected; a payload carrying a day-precision date is rejected; a
// below-threshold row still ingests (the threshold is a render concern).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ingest,
  validatePublishPayload,
  mergePayloadIntoBoard,
  emptyBoard,
  stableStringify,
  extractPayloadText,
  collapseVersion,
  MIN_DONE_TURNS,
} from './ingest.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  FAIL ${name}\n         ${e.message}\n`);
  }
}

// --- helpers ---------------------------------------------------------------
function makeRow(over = {}) {
  return {
    harness: 'claude-code',
    harnessVersion: '2.1.214',
    model: 'claude-opus-5',
    sessions: 4,
    turns: 20,
    doneTurns: 12,
    contradictedTurns: 1,
    unverifiedTurns: 3,
    cleanTurns: 8,
    claims: { total: 20, verified: 15, unverified: 3, contradicted: 1, notScored: 1, byKind: { file: 5, test: 4, git: 3 } },
    testRunRate: 1,
    integritySignals: 0,
    ledgerIncompleteSessions: 0,
    costPerDoneTurnUsd: 12.5,
    cacheHitPct: 70,
    contradictionReasons: { 'last-run-red': 1 },
    ...over,
  };
}

function makePayload(rows, over = {}) {
  const contentHash = createHash('sha256').update(stableStringify(rows)).digest('hex').slice(0, 16);
  return {
    schema: 'showreceipts.bench-publish/1',
    generator: { name: 'showreceipts', version: '0.1.0', rulesVersion: 'claims/2', pricesVersion: '2026-08-29' },
    period: { from: '2026-08', to: '2026-08', partial: false },
    platform: { os: 'linux', node: '20' },
    contentHash,
    rows,
    ...over,
  };
}

function wrapIssue(payload, handle) {
  const json = JSON.stringify(payload, null, 2);
  return [
    '### Publish payload',
    '',
    '```json',
    json,
    '```',
    '',
    '### Confirmation',
    '',
    '- [X] These numbers are aggregates only, produced by `bench --publish`, and they are mine to share.',
    '',
    '### Handle (optional)',
    '',
    handle || '_No response_',
    '',
  ].join('\n');
}

// --- tests -----------------------------------------------------------------

test('a valid payload merges into the board', () => {
  const payload = makePayload([makeRow({ doneTurns: 60, harnessVersion: '2.1.214' })]);
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.deepEqual(errors, [], 'valid payload should have no validation errors');

  const body = wrapIssue(payload, 'tester');
  const result = ingest('', body, { submitter: 'issue-1', handle: 'tester' });
  assert.equal(result.ok, true, 'ingest should succeed');
  assert.equal(result.board.rows.length, 1);
  const row = result.board.rows[0];
  assert.equal(row.model, 'claude-opus-5');
  assert.equal(row.harnessVersion, '2.1.x', 'version collapses to 2.1.x');
  assert.equal(row.doneTurns, 60);
  assert.equal(row.exemplar, false);
  assert.equal(row.submitters.length, 1);
  assert.equal(row.submitters[0].id, 'issue-1');
  assert.equal(row.submitters[0].handle, 'tester');
});

test('merging two submissions accumulates and counts distinct submitters', () => {
  const p1 = makePayload([makeRow({ doneTurns: 30 })]);
  const p2 = makePayload([makeRow({ doneTurns: 25 })]);
  let board = emptyBoard();
  board = mergePayloadIntoBoard(board, p1, 'issue-1', 'a');
  board = mergePayloadIntoBoard(board, p2, 'issue-2', 'b');
  assert.equal(board.rows.length, 1, 'same key merges to one row');
  assert.equal(board.rows[0].doneTurns, 55);
  assert.equal(board.rows[0].submitters.length, 2);
  // Re-running the same issue must not double count.
  board = mergePayloadIntoBoard(board, p1, 'issue-1', 'a');
  assert.equal(board.rows[0].submitters.length, 2, 're-run of issue-1 does not add a submitter');
  assert.equal(board.rows[0].doneTurns, 85, 'counts still accumulate on re-run');
});

test('a payload carrying a filesystem path is rejected', () => {
  // A path leaks into platform.os; the slash rule (more than one "/") fires.
  const payload = makePayload([makeRow()], { platform: { os: 'darwin/Users/bob', node: '20' } });
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.ok(errors.some((e) => e.startsWith('slash:')), 'expected a slash/path rejection, got: ' + errors.join('; '));

  const result = ingest('', wrapIssue(payload), { submitter: 'issue-2' });
  assert.equal(result.ok, false, 'ingest must reject a payload with a path');
  assert.ok(result.errors.some((e) => e.startsWith('slash:')));
});

test('a payload carrying a day-precision date is rejected', () => {
  // A day-precision date leaks into platform.os (a free string that is scanned).
  const payload = makePayload([makeRow()], { platform: { os: '2026-08-15', node: '20' } });
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.ok(errors.some((e) => e.startsWith('day-precision:')), 'expected a day-precision rejection, got: ' + errors.join('; '));

  const result = ingest('', wrapIssue(payload), { submitter: 'issue-3' });
  assert.equal(result.ok, false, 'ingest must reject a payload with a day-precision date');
});

test('generator.pricesVersion is the one allowed date and does not trip the scan', () => {
  const payload = makePayload([makeRow()]);
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.deepEqual(errors, [], 'pricesVersion 2026-08-29 is allowed; no day-precision error');
});

test('a below-threshold row still ingests (threshold is a render concern)', () => {
  const payload = makePayload([makeRow({ doneTurns: 3, sessions: 1 })]);
  assert.ok(3 < MIN_DONE_TURNS, 'sanity: 3 is below the publication threshold');
  const result = ingest('', wrapIssue(payload), { submitter: 'issue-4' });
  assert.equal(result.ok, true, 'a below-threshold row must still ingest');
  assert.equal(result.board.rows[0].doneTurns, 3);
  assert.equal(result.board.rows[0].exemplar, false);
});

test('an unknown top-level key is rejected', () => {
  const payload = makePayload([makeRow()]);
  payload.leak = { path: '/home/alice/.ssh/id_rsa' };
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.ok(errors.some((e) => e.startsWith('unknown-key:')), 'unknown key must be flagged');
});

test('an e-mail anywhere in the bytes is rejected', () => {
  const payload = makePayload([makeRow()]);
  // Even valid-looking structure is rejected if the serialised bytes hold an e-mail.
  const serialized = JSON.stringify(payload).replace('linux', 'linux');
  const withEmail = serialized.slice(0, -1) + ',"x":"a@b.com"}';
  const errors = validatePublishPayload(JSON.parse('{"schema":"showreceipts.bench-publish/1"}'), withEmail);
  assert.ok(errors.some((e) => e.startsWith('email:')), 'e-mail in bytes must be flagged');
});

test('a mismatched contentHash is rejected', () => {
  const payload = makePayload([makeRow()]);
  payload.contentHash = '0000000000000000';
  const errors = validatePublishPayload(payload, JSON.stringify(payload));
  assert.ok(errors.some((e) => e.startsWith('content-hash:')), 'a wrong contentHash must be flagged');
});

test('an out-of-enum model is rejected but "other" is allowed', () => {
  const bad = makePayload([makeRow({ model: 'totally-made-up-model' })]);
  assert.ok(validatePublishPayload(bad, JSON.stringify(bad)).some((e) => e.startsWith('model-key:')));
  const ok = makePayload([makeRow({ model: 'other' })]);
  assert.deepEqual(validatePublishPayload(ok, JSON.stringify(ok)), []);
});

test('extractPayloadText pulls JSON from a fenced issue body', () => {
  const payload = makePayload([makeRow()]);
  const { json } = extractPayloadText(wrapIssue(payload));
  assert.equal(json.schema, 'showreceipts.bench-publish/1');
});

test('extractPayloadText caps oversized bodies', () => {
  const huge = 'x'.repeat(70 * 1024);
  assert.throws(() => extractPayloadText(huge), /exceeds/);
});

test('collapseVersion collapses patch versions', () => {
  assert.equal(collapseVersion('2.1.214'), '2.1.x');
  assert.equal(collapseVersion('0.5.3'), '0.5.x');
  assert.equal(collapseVersion('unknown'), 'unknown');
});

// --- summary ---------------------------------------------------------------
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
