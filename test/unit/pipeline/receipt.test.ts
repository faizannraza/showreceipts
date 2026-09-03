/**
 * S18 — `pipeline/receipt.ts`: turn selection, `turnsWithClaims`,
 * worst-first line ordering, ALSO SAID/ALSO DID composition and caps,
 * `kind` transitions, cost (session-level + `--as-of` post-cache), the
 * `--hash-paths` pass, and the stable JSON form.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt, Session } from '../../../src/model/types.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import {
  buildReceipt,
  buildTurnReceipts,
  receiptToJson,
  turnsWithClaims,
  type ReceiptOptions,
} from '../../../src/pipeline/receipt.js';
import { truncateBytes } from '../../../src/cache/cache.js';
import { stableStringify } from '../../../src/util/json.js';
import { maskSecrets } from '../../../src/util/mask.js';
import { CWD, call, computePerTurn, emptyCost, emptyLedger, session, testRun, turn, write } from '../reconcile/harness.js';

const table = loadPriceTable();

function opts(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return { now: new Date('2026-08-29T12:00:00.000Z'), prices: table, homeDir: '/home/u', ...over };
}

/** A session whose turn-1 final makes three claims with mixed outcomes. */
function mixedSession(): Session {
  const calls = [call(20, { tool: 'Write', kind: 'write' }), call(30, { command: 'pytest', exitCode: 1 })];
  const ledger = emptyLedger({
    writes: [write({ seq: 20, toolCallId: 't20', path: `${CWD}/src/new.py`, verb: 'create', created: true })],
    testRuns: [testRun({ seq: 30, toolCallId: 't30', green: false, exitCode: 1, parsed: { passed: 3, failed: 2, total: 5 } })],
    filesChanged: [`${CWD}/src/new.py`],
  });
  ledger.perTurn = computePerTurn(ledger, calls);
  const t1 = turn({
    finalText: 'Created src/new.py. Tests pass. Committed the changes. You should push the branch yourself.',
  });
  return session({ toolCalls: calls, ledger, turns: [turn({ index: 0, promptId: 'p0', seqStart: 1, seqEnd: 9, finalText: 'Earlier.', finalSeq: 8 }), t1] });
}

describe('turn selection', () => {
  it('defaults to the last done turn', () => {
    const r = buildReceipt(session(), opts());
    expect(r.turnIndex).toBe(1);
    expect(r.finalText).toBe('Done.');
  });

  it('honours --turn N', () => {
    const r = buildReceipt(session(), opts({ turnIndex: 0 }));
    expect(r.turnIndex).toBe(0);
    expect(r.finalText).toBe('Earlier.');
  });

  it('falls back to the last turn when nothing is done (no-final)', () => {
    const s = session({ turns: [turn({ index: 0, isDone: false, finalText: null, finalSeq: null, finalTrigger: null })] });
    const r = buildReceipt(s, opts());
    expect(r.kind).toBe('no-final');
    expect(r.verdict).toBe('NO_FINAL');
    expect(r.lines).toEqual([]);
  });
});

describe('claims, judgements and ordering', () => {
  it('orders lines worst-first (CONTRADICTED > UNVERIFIED > VERIFIED), stable by position', () => {
    const r = buildReceipt(mixedSession(), opts());
    expect(r.kind).toBe('scored');
    expect(r.verdict).toBe('CONTRADICTED');
    expect(r.lines.map((l) => l.glyph)).toEqual(['bad', 'unk', 'ok']);
    expect(r.lines[0]?.claim.toLowerCase()).toContain('tests pass');
    expect(r.lines[1]?.claim.toLowerCase()).toContain('committed');
    expect(r.lines[2]?.claim.toLowerCase()).toContain('src/new.py');
    expect(r.counts.CONTRADICTED).toBe(1);
    expect(r.counts.UNVERIFIED).toBe(1);
    expect(r.counts.VERIFIED).toBe(1);
    expect(r.counts.NOT_SCORED).toBeGreaterThanOrEqual(1); // the deferred "you should push…"
  });

  it('every evidence string carries a clock and lines carry refs', () => {
    const r = buildReceipt(mixedSession(), opts());
    for (const line of r.lines) {
      expect(line.evidence.join(' ')).toMatch(/\(\d\d:\d\d/);
    }
    expect(r.lines[2]?.refs[0]?.seq).toBe(20);
  });

  it('puts NOT_SCORED clauses into alsoSaid (≤ 3)', () => {
    const r = buildReceipt(mixedSession(), opts());
    expect(r.alsoSaid.length).toBeGreaterThanOrEqual(1);
    expect(r.alsoSaid.length).toBeLessThanOrEqual(3);
    expect(r.alsoSaid.join(' ').toLowerCase()).toContain('push the branch');
  });

  it('turnsWithClaims lists exactly the turns whose finals carry scored claims', () => {
    const s = mixedSession();
    expect(turnsWithClaims(s)).toEqual([1]);
    const r = buildReceipt(s, opts());
    expect(r.turnsWithClaims).toEqual([1]);
  });

  it('explanations are built on demand', () => {
    const r = buildReceipt(mixedSession(), opts({ explain: true }));
    expect(r.explanations).toBeDefined();
    expect(r.explanations?.length).toBe(r.judgements.length);
    const rows = new Set(r.explanations?.map((e) => e.row));
    expect(rows.has(1)).toBe(true); // test.pass judged by row 1
  });
});

describe('kind transitions', () => {
  it('no-claims when the final has no recognised claims', () => {
    const s = session({ turns: [session().turns[0] as ReturnType<typeof turn>, turn({ finalText: 'That was an interesting discussion.' })] });
    const r = buildReceipt(s, opts());
    expect(r.kind).toBe('no-claims');
    expect(r.verdict).toBe('NO_CLAIMS');
    expect(r.claimsRecognized).toBe(0);
    expect(r.stats.sentencesScanned).toBeGreaterThanOrEqual(1);
  });

  it('a marker-only final stays kind scored with verdict NO_CLAIMS (rate: markerOnly)', () => {
    const r = buildReceipt(session(), opts()); // final "Done."
    expect(r.kind).toBe('scored');
    expect(r.verdict).toBe('NO_CLAIMS');
    expect(r.counts.NOT_SCORED).toBe(1);
  });

  it('no-final when the selected turn is interrupted', () => {
    const s = session();
    (s.turns[1] as ReturnType<typeof turn>).isDone = false;
    (s.turns[1] as ReturnType<typeof turn>).finalText = null;
    (s.turns[1] as ReturnType<typeof turn>).interrupted = true;
    const r = buildReceipt(s, opts({ turnIndex: 1 }));
    expect(r.kind).toBe('no-final');
    expect(r.verdict).toBe('NO_FINAL');
  });

  it('no-turns for sessions without assistant turns', () => {
    const s = session({ turns: [], kind: 'no-turns', records: 12, toolCalls: [] });
    const r = buildReceipt(s, opts());
    expect(r.kind).toBe('no-turns');
    expect(r.verdict).toBe('NO_TURNS');
    expect(r.records).toBe(12);
    expect(r.turnIndex).toBe(-1);
  });
});

describe('ALSO DID', () => {
  it('groups unmentioned files by directory when more than 6 changed', () => {
    const paths = [1, 2, 3, 4].flatMap((i) => [`${CWD}/src/a/f${i}.py`, `${CWD}/src/b/g${i}.py`]);
    const calls = paths.map((_, i) => call(20 + i, { tool: 'Edit', kind: 'edit' }));
    const ledger = emptyLedger({ writes: paths.map((p, i) => write({ seq: 20 + i, toolCallId: `t${20 + i}`, path: p })) });
    ledger.perTurn = computePerTurn(ledger, calls);
    const s = session({ toolCalls: calls, ledger });
    const r = buildReceipt(s, opts());
    const files = r.alsoDid.find((d) => d.text.includes('files changed'));
    expect(files?.text).toBe('8 files changed (src/a/, src/b/)');
  });

  it('caps at 6 entries plus +N more, danger at 3 plus its own tail', () => {
    const calls = [call(20, { tool: 'Edit', kind: 'edit' })];
    const ledger = emptyLedger({
      writes: [write({ seq: 20, toolCallId: 't20', path: `${CWD}/src/x.py` })],
      integrity: [
        { seq: 22, kind: 'test-file-edited-after-green', path: 'tests/a.py', detail: 'edited tests/a.py after last green run (not re-run)' },
        { seq: 23, kind: 'assertion-removed', path: 'tests/b.py', detail: '2 assertions removed in tests/b.py' },
      ],
      danger: [21, 22, 23, 24, 25].map((seq) => ({ seq, tier: 'danger' as const, kind: 'rm-rf' as const, detail: `rm -rf / (#${seq})` })),
    });
    ledger.perTurn = computePerTurn(ledger, calls);
    const s = session({ toolCalls: calls, ledger });
    const r = buildReceipt(s, opts());
    expect(r.alsoDid).toHaveLength(7); // 6 + "+N more"
    expect(r.alsoDid[6]?.text).toBe('+1 more');
    const dangerLines = r.alsoDid.filter((d) => d.text.startsWith('rm -rf'));
    expect(dangerLines).toHaveLength(3);
    expect(dangerLines.every((d) => d.warn === true)).toBe(true);
  });

  it('reports temp-dir writes and opaque scripts', () => {
    const calls = [call(20, { command: "python3 - <<'EOF'\nEOF" }), call(21, { tool: 'Write', kind: 'write' })];
    const ledger = emptyLedger({
      writes: [write({ seq: 21, toolCallId: 't21', path: '/tmp/scratch.txt', scope: 'scratch' })],
      commands: [
        {
          seq: 20,
          toolCallId: 't20',
          agentId: null,
          raw: "python3 - <<'EOF'",
          segments: [],
          exitCode: 0,
          exitCodeSource: 'harness',
          chained: false,
          background: false,
          interrupted: false,
          opaqueWrite: true,
        },
      ],
    });
    ledger.perTurn = computePerTurn(ledger, calls);
    const s = session({ toolCalls: calls, ledger });
    const r = buildReceipt(s, opts());
    const texts = r.alsoDid.map((d) => d.text);
    expect(texts).toContain('1 file written to temp dirs');
    expect(texts.some((t) => t.startsWith('1 script may have written files'))).toBe(true);
  });

  /** A result head whose failure path sits beyond the raw 512-char head but inside the masked §4.9 head. */
  const patchFailure = `Bearer ${'a'.repeat(700)} apply_patch verification failed: Failed to find expected lines in ${CWD}/src/x.py:`;

  /** A turn window holding one opaque script and one failed patch (§5.2 entries 9/10). */
  function scriptAndPatchSession(resultText: string): Session {
    const calls = [
      call(20, { command: "python3 - <<'EOF'\nEOF" }),
      call(21, { tool: 'apply_patch', kind: 'other', isError: true, exitCode: 1, resultText }),
    ];
    const ledger = emptyLedger({
      commands: [
        {
          seq: 20,
          toolCallId: 't20',
          agentId: null,
          raw: "python3 - <<'EOF'",
          segments: [],
          exitCode: 0,
          exitCodeSource: 'harness',
          chained: false,
          background: false,
          interrupted: false,
          opaqueWrite: true,
        },
      ],
    });
    ledger.perTurn = computePerTurn(ledger, calls);
    return session({ toolCalls: calls, ledger });
  }

  it('lists opaque scripts before failed patches (§5.2 order) and parses the patch path from the masked head', () => {
    const r = buildReceipt(scriptAndPatchSession(patchFailure), opts());
    const texts = r.alsoDid.map((d) => d.text);
    const script = texts.findIndex((t) => t.startsWith('1 script may have written files'));
    const patch = texts.indexOf('patch failed: src/x.py');
    expect(script).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(script);
  });

  it('failed-patch parsing is identical cold and warm (§4.9 masked 512-byte head)', () => {
    const cold = buildReceipt(scriptAndPatchSession(patchFailure), opts());
    const warm = buildReceipt(scriptAndPatchSession(truncateBytes(maskSecrets(patchFailure), 512)), opts());
    expect(warm.alsoDid.map((d) => d.text)).toEqual(cold.alsoDid.map((d) => d.text));
    expect(cold.alsoDid.some((d) => d.text === 'patch failed: src/x.py')).toBe(true);
  });

  it('the PR-reference ref points at an in-window prRef, not the session-wide first', () => {
    const s = session({
      prRefs: [
        { seq: 5, prNumber: 4, prUrl: 'https://github.com/u/proj/pull/4', prRepository: 'u/proj', time: '2026-03-01T16:10:00.000Z' },
        { seq: 40, prNumber: 7, prUrl: 'https://github.com/u/proj/pull/7', prRepository: 'u/proj', time: '2026-03-01T18:00:00.000Z' },
      ],
    });
    const r = buildReceipt(s, opts());
    const pr = r.alsoDid.find((d) => d.text.startsWith('referenced PR'));
    expect(pr?.text).toBe('referenced PR #7');
    expect(pr?.refs[0]?.seq).toBe(40);
  });
});

describe('cost (post-cache)', () => {
  const codexSession = (): Session =>
    session({
      harness: 'codex',
      tokenDeltas: [
        { seq: 40, ts: '2026-07-15T10:00:00.000Z', model: 'gpt-5.6-terra', input: 1000, cached: 0, output: 100, reasoning: 0, turnIndex: 1, lastInput: null },
      ],
      cost: emptyCost({ planUsagePct: 63 }),
    });

  it('--as-of changes the receipt cost without any re-parse input', () => {
    const july = buildReceipt(codexSession(), opts({ asOf: '2026-07-15' }));
    const august = buildReceipt(codexSession(), opts({ asOf: '2026-08-10' }));
    expect(july.cost.usd).toBe(0.004);
    expect(august.cost.usd).toBe(0.0032);
    expect(august.cost.asOf).toBe('2026-08-10');
  });

  it('carries planUsagePct and stamps Turn.costUsd', () => {
    const s = codexSession();
    const r = buildReceipt(s, opts());
    expect(r.cost.planUsagePct).toBe(63);
    expect(s.turns[1]?.costUsd).toBe(0.004);
    expect(s.turns[0]?.costUsd).toBeNull();
  });

  it('hook-captured sessions get usd null', () => {
    const s = session({ source: 'ledger' });
    const r = buildReceipt(s, opts());
    expect(r.cost.usd).toBeNull();
    expect(r.cost.apiCalls).toBe(0);
  });
});

describe('hash-paths pass and JSON form', () => {
  it('rewrites every absolute path, evidence and timeline included; relative paths stay', () => {
    const s = mixedSession();
    (s.toolCalls[1] as ReturnType<typeof call>).command = 'pytest /home/u/elsewhere/conftest.py';
    const r = buildReceipt(s, opts({ hashPaths: 'test-salt', timeline: true }));
    expect(r.hashPaths).toBe(true);
    expect(r.cwd).toBe('.');
    const json = receiptToJson(r);
    expect(json).not.toContain('/home/u');
    expect(json).not.toContain('test-salt');
    expect(json).toContain('src/new.py');
    expect(json).toMatch(/p:[0-9a-f]{8}\/conftest\.py/);
  });

  it('rewrites bare username/home tokens when the home basename names one (§11.2)', () => {
    const s = mixedSession();
    (s.turns[1] as ReturnType<typeof turn>).finalText = 'Ran the audit as casey123x. Tests pass.';
    const r = buildReceipt(s, opts({ homeDir: '/Users/casey123x', hashPaths: 'test-salt' }));
    const json = receiptToJson(r);
    expect(json).not.toContain('casey123x');
    expect(json).toMatch(/u:[0-9a-f]{8}/);
  });

  it('receipt JSON is key-sorted and round-trips', () => {
    const r = buildReceipt(mixedSession(), opts({ timeline: true }));
    expect(r.schema).toBe('showreceipts.receipt/1');
    const json = receiptToJson(r);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(stableStringify(parsed)).toBe(json);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});

describe('buildTurnReceipts', () => {
  it('returns one receipt per done turn, keyed by turn index', () => {
    const receipts = buildTurnReceipts(session(), opts());
    expect([...receipts.keys()]).toEqual([0, 1]);
    expect((receipts.get(1) as Receipt).turnIndex).toBe(1);
  });

  it('is empty for no-turns sessions', () => {
    expect(buildTurnReceipts(session({ turns: [], kind: 'no-turns' }), opts()).size).toBe(0);
  });
});
