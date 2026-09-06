/**
 * S21 — Markdown export snapshots and safety battery.
 *
 * Snapshots: the S19 golden receipts of two fixtures — `claude-code/2.1.214`
 * (real transcript) and `codex/shell_command` (VERIFIED commit + a
 * CONTRADICTED test claim on turn 0) — rendered through the real pipeline
 * with the frozen golden price table, plus a `--timeline` render and a
 * fixed-salt `--hash-paths` render.
 *
 * Safety: a hand-made hostile receipt (ANSI/OSC, RLO, U+2028, NUL, CR,
 * pipes, backticks, `<script>` in every string field) renders with no raw
 * `<`, no backtick, no control or bidi character, and no `|` outside table
 * structure; `--hash-paths` removes every absolute path.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Receipt, Session } from '../../src/model/types.js';
import { parsePriceTable } from '../../src/cost/validate.js';
import { resolveRoots } from '../../src/discover/roots.js';
import { buildReceipt, type ReceiptOptions } from '../../src/pipeline/receipt.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { renderMarkdownReceipt } from '../../src/render/md.js';
import { TOOL_VERSION } from '../../src/version.js';
import { FIXTURES_ROOT, materialize } from '../helpers/fixtures.js';
import { GOLDEN_HOME } from '../helpers/goldens.js';
import { makeTempDir } from '../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const prices = parsePriceTable(readFileSync(join(FIXTURES_ROOT, 'prices', 'prices.golden.json'), 'utf8'), 'prices.golden.json');

function receiptOpts(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return { now: NOW, prices, homeDir: GOLDEN_HOME, ...over };
}

// ---------------------------------------------------------------------------
// Real-pipeline sessions for the two snapshot fixtures.
// ---------------------------------------------------------------------------

const tmp = makeTempDir('showreceipts-md-');
const bySession = new Map<string, Session>();
for (const id of ['claude-code/2.1.214', 'codex/shell_command']) {
  const into = join(tmp, id.replace(/\//g, '__'));
  materialize(id, into);
  const roots = resolveRoots(
    { CLAUDE_CONFIG_DIR: join(into, 'claude'), CODEX_HOME: join(into, 'codex'), SHOWRECEIPTS_HOME: join(into, 'sr') },
    GOLDEN_HOME,
  );
  const { sessions, diagnostics } = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now: NOW });
  if (diagnostics.problems.length > 0) throw new Error(`${id}: ${diagnostics.problems.join('; ')}`);
  for (const s of sessions) bySession.set(id, s);
  if (sessions.length !== 1) throw new Error(`${id}: expected exactly 1 session, got ${sessions.length}`);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sessionOf(id: string): Session {
  const s = bySession.get(id);
  if (s === undefined) throw new Error(`no session for ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** C0/C1 controls (not `\n`), separators, bidi embeddings/overrides/isolates, zero-width marks. */
const HAZARD_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f]/;

function assertSafe(md: string): void {
  expect(md).not.toMatch(HAZARD_RE);
  expect(md.includes('<'), 'no raw < anywhere (entities only)').toBe(false);
  expect(md.includes('`'), 'no raw backtick anywhere (entities only)').toBe(false);
  // Every `|` sits in table structure: within a contiguous run of `|`-prefixed
  // lines, every row carries exactly the header's pipe count.
  const lines = md.split('\n');
  let headerPipes: number | null = null;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      headerPipes = null;
      expect(line.includes('|'), `no pipe outside tables: ${JSON.stringify(line)}`).toBe(false);
      continue;
    }
    const pipes = (line.match(/\|/g) ?? []).length;
    if (headerPipes === null) headerPipes = pipes;
    expect(pipes, `table row keeps the header's cell count: ${JSON.stringify(line)}`).toBe(headerPipes);
  }
}

// ---------------------------------------------------------------------------
// Snapshots over the S19 goldens
// ---------------------------------------------------------------------------

describe('markdown snapshots (S19 goldens)', () => {
  it('claude-code/2.1.214 — default receipt', () => {
    const md = renderMarkdownReceipt(buildReceipt(sessionOf('claude-code/2.1.214'), receiptOpts()), { tz: 'utc' });
    assertSafe(md);
    expect(md.startsWith('**showreceipts** · ')).toBe(true);
    expect(md).toContain('Claude Code');
    expect(md).toContain('rules ');
    expect(md).toContain(`v${TOOL_VERSION}`);
    expect(md).toContain('(API-equivalent)');
    expect(md).toContain('**VERDICT: ');
    expect(md).toContain('_evidence from log only_');
    expect(md.endsWith('\n') && !md.endsWith('\n\n')).toBe(true);
    expect(md).toMatchSnapshot();
  });

  it('codex/shell_command — default receipt (VERIFIED commit)', () => {
    const md = renderMarkdownReceipt(buildReceipt(sessionOf('codex/shell_command'), receiptOpts()), { tz: 'utc' });
    assertSafe(md);
    expect(md).toContain('| VERIFIED |');
    expect(md).toContain('Codex');
    expect(md).toMatchSnapshot();
  });

  it('codex/shell_command — turn 0 (CONTRADICTED test claim), worst-first rows', () => {
    const md = renderMarkdownReceipt(buildReceipt(sessionOf('codex/shell_command'), receiptOpts({ turnIndex: 0 })), { tz: 'utc' });
    assertSafe(md);
    expect(md).toContain('**CONTRADICTED');
    const contradicted = md.indexOf('| CONTRADICTED |');
    const verified = md.indexOf('| VERIFIED |');
    expect(contradicted).toBeGreaterThan(-1);
    if (verified !== -1) expect(contradicted).toBeLessThan(verified);
    expect(md).toMatchSnapshot();
  });

  it('codex/shell_command — --timeline appends the timeline table', () => {
    const md = renderMarkdownReceipt(buildReceipt(sessionOf('codex/shell_command'), receiptOpts({ timeline: true })), { tz: 'utc' });
    assertSafe(md);
    expect(md).toContain('**TIMELINE**');
    expect(md).toContain('| time | tool | summary | exit | files | $ | agent | flags |');
    expect(md).toMatchSnapshot();
  });

  it('claude-code/2.1.214 — --hash-paths leaves no home path anywhere (fixed salt, snapshot)', () => {
    const receipt = buildReceipt(sessionOf('claude-code/2.1.214'), receiptOpts({ hashPaths: 'md-golden-salt', timeline: true }));
    expect(receipt.hashPaths).toBe(true);
    const md = renderMarkdownReceipt(receipt, { tz: 'utc' });
    assertSafe(md);
    expect(md.includes(GOLDEN_HOME), 'no absolute home path survives --hash-paths').toBe(false);
    expect(md).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Hostile receipt
// ---------------------------------------------------------------------------

const HOSTILE = '\x1b[2J\x1b]52;c;evil\x07\u202e \x00|`<script>alert(1)</script>\r\n';

function makeReceipt(over: Partial<Receipt> = {}): Receipt {
  return {
    schema: 'showreceipts.receipt/1',
    toolVersion: TOOL_VERSION,
    rulesVersion: 'claims/1+reconcile/1',
    pricesVersion: prices.version,
    kind: 'scored',
    id: '1e60d0ff-9d90-4d1c-a6cd-7a3b3f2f9df2',
    shortId: '1e60d0ff',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: `2.1.9${HOSTILE}`,
    model: `claude-x${HOSTILE}`,
    cwd: `/home/u/proj${HOSTILE}`,
    branch: `main${HOSTILE}`,
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T11:30:00.000Z',
    durationMs: 5_400_000,
    source: 'transcript',
    turnIndex: 1,
    finalTrigger: 'human',
    turnsWithClaims: [1],
    finalText: `done${HOSTILE}`,
    finalTextSource: 'transcript',
    claims: [],
    judgements: [],
    lines: [
      {
        glyph: 'bad',
        claim: `all tests pass ${HOSTILE}`,
        evidence: [`pytest -> 2 failed ${HOSTILE} (11:03)`, `edited /Users/eve/secret/place.txt ${HOSTILE}`],
        refs: [],
      },
      { glyph: 'ok', claim: 'updated src/x.ts', evidence: ['Edit src/x.ts (10:05)'], refs: [] },
      { glyph: 'unk', claim: `ran the build ${HOSTILE}`, evidence: [], refs: [] },
    ],
    alsoSaid: [`I did not touch the docs ${HOSTILE}`],
    alsoDid: [
      { text: `2 files changed (src/a.ts, ${HOSTILE})`, refs: [] },
      { text: `1 file written to home dotfiles (~/.zshrc ${HOSTILE})`, warn: true, refs: [] },
    ],
    postFinal: [{ agentId: `agent-${HOSTILE}`, toolCalls: 3, files: 2, testRuns: 1 }],
    stats: { toolCalls: 12, filesChanged: 3, testRuns: 1, compactions: 1, subagents: 2, apiCalls: 9, sentencesScanned: 7 },
    cost: {
      usd: 1.23,
      apiCalls: 9,
      input: 100,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteOther: 0,
      output: 50,
      cacheHitPct: 71,
      unverified: false,
      unpriced: [],
      apiEquivalent: true,
      pricesVersion: prices.version,
      notes: [],
    },
    verdict: 'CONTRADICTED',
    counts: { VERIFIED: 1, UNVERIFIED: 1, CONTRADICTED: 1, NOT_SCORED: 1 },
    turnActiveMs: 65_000,
    claimsRecognized: 4,
    timeline: [
      {
        seq: 10,
        at: '2026-08-01T10:05:00.000Z',
        tool: `Bash${HOSTILE}`,
        kind: 'shell',
        summary: `pytest -x ${HOSTILE}`,
        exit: 1,
        files: [`/Users/eve/secret/place.txt${HOSTILE}`],
        usd: 0.0042,
        agentId: `agent-${HOSTILE}`,
        flags: ['test', 'error'],
      },
    ],
    ...over,
  };
}

describe('hostile receipt', () => {
  it('renders with no raw <, no backtick, no control/bidi bytes, pipes only in tables', () => {
    const md = renderMarkdownReceipt(makeReceipt(), { tz: 'utc' });
    assertSafe(md);
    expect(md).toContain('&lt;script'); // the payload survives, escaped
    expect(md).toContain('&#124;');
    expect(md).toContain('&#96;');
    expect(md).toContain('**!** '); // the warn marker on the dotfile write
    expect(md).toContain('~ I did not touch the docs');
    expect(md).toContain('not evidence for the claims above');
    expect(md).toMatchSnapshot();
  });

  it('the badge and verdict summarise the worst claim', () => {
    const md = renderMarkdownReceipt(makeReceipt(), { tz: 'utc' });
    const badge = md.split('\n', 1)[0] as string;
    expect(badge).toContain('**showreceipts**');
    expect(badge).toContain('**CONTRADICTED (1 of 3 claims)**');
    expect(badge).toContain('rules claims/1+reconcile/1');
    expect(md).toContain('**VERDICT: CONTRADICTED**');
  });

  it('opts.hashPaths applies the §11.2 pass to every string field, evidence and timeline included', () => {
    const md = renderMarkdownReceipt(makeReceipt(), {
      tz: 'utc',
      hashPaths: { salt: 'test-salt', cwd: '/home/u/proj', extraTokens: ['/home/u'] },
    });
    assertSafe(md);
    expect(md.includes('/Users/eve')).toBe(false);
    expect(md.includes('/home/u')).toBe(false);
    expect(md).toContain('p:'); // hashed out-of-cwd paths keep their basename behind a hash
  });

  it('a receipt already hashed by buildReceipt is not hashed twice', () => {
    const hashed = makeReceipt({ hashPaths: true, cwd: '.' });
    const md = renderMarkdownReceipt(hashed, { tz: 'utc', hashPaths: { salt: 's', cwd: '.' } });
    // /Users/eve survives because the receipt claims it was hashed already —
    // the renderer trusts buildReceipt's pass and never re-walks.
    expect(md).toContain('/Users/eve');
  });
});

// ---------------------------------------------------------------------------
// Kind variants and the cost line
// ---------------------------------------------------------------------------

describe('post-final notes cap (shared with the terminal renderer)', () => {
  const withAgents = (n: number): Receipt =>
    makeReceipt({
      postFinal: Array.from({ length: n }, (_, i) => ({ agentId: `a${String(i).padStart(2, '0')}`, toolCalls: i + 1, files: 0, testRuns: 0 })),
    });

  it('renders every per-agent note at 3 or fewer agents', () => {
    const md = renderMarkdownReceipt(withAgents(3), { tz: 'utc' });
    expect(md.match(/after this message: agent /g)?.length).toBe(3);
    expect(md).not.toContain('more agents');
  });

  it('collapses the tail beyond 3 agents into one aggregate line (a real export carried 54)', () => {
    const md = renderMarkdownReceipt(withAgents(54), { tz: 'utc' });
    expect(md.match(/after this message: agent /g)?.length).toBe(3);
    expect(md).toContain('51 more agents ran');
    expect(md).toContain('not evidence for the claims above');
  });
});

describe('homeDir display (parity with the terminal header)', () => {
  it('maps the header cwd to ~ when homeDir is given', () => {
    const md = renderMarkdownReceipt(makeReceipt({ cwd: '/home/u/proj' }), { tz: 'utc', homeDir: '/home/u' });
    expect(md).toContain(' ~/proj ');
    expect(md).not.toContain(' /home/u/proj ');
  });

  it('leaves the cwd raw without homeDir', () => {
    const md = renderMarkdownReceipt(makeReceipt({ cwd: '/home/u/proj' }), { tz: 'utc' });
    expect(md).toContain('/home/u/proj');
  });

  it('maps timeline file cells too', () => {
    const md = renderMarkdownReceipt(makeReceipt(), { tz: 'utc', homeDir: '/Users/eve' });
    expect(md).toContain('~/secret/place.txt');
  });
});

describe('kind variants', () => {
  it('hook-captured receipts say so in the header and cost line', () => {
    const md = renderMarkdownReceipt(makeReceipt({ source: 'ledger' }), { tz: 'utc' });
    expect(md).toContain('hook-captured');
    expect(md).toContain('cost n/a (hook-captured)');
    expect(md).not.toContain('API-equivalent');
  });

  it('no-final renders its text and VERDICT: NO FINAL MESSAGE', () => {
    const md = renderMarkdownReceipt(
      makeReceipt({ kind: 'no-final', verdict: 'NO_FINAL', lines: [], alsoSaid: [], counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 } }),
      { tz: 'utc' },
    );
    assertSafe(md);
    expect(md).toContain('turn ended without a final message');
    expect(md).toContain('**VERDICT: NO FINAL MESSAGE**');
    expect(md).toContain('**NO FINAL MESSAGE**'); // badge summary
  });

  it('no-turns renders records, zero stats, no cost, verdict —', () => {
    const receipt = makeReceipt({
      kind: 'no-turns',
      verdict: 'NO_TURNS',
      turnIndex: -1,
      records: 12,
      lines: [],
      alsoSaid: [],
      alsoDid: [],
      counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 },
      stats: { toolCalls: 0, filesChanged: 0, testRuns: 0, compactions: 0, subagents: 0, apiCalls: 0, sentencesScanned: 0 },
    });
    delete receipt.postFinal;
    delete receipt.timeline;
    const md = renderMarkdownReceipt(receipt, { tz: 'utc' });
    assertSafe(md);
    expect(md).toContain('no assistant turns in this session (12 records)');
    expect(md).toContain('0 tool calls · 0 files changed');
    expect(md).not.toContain('cost ');
    expect(md).toContain('**VERDICT: —**');
  });

  it('no-claims renders the sentence count', () => {
    const md = renderMarkdownReceipt(
      makeReceipt({
        kind: 'no-claims',
        verdict: 'NO_CLAIMS',
        lines: [],
        counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 2 },
        claimsRecognized: 2,
      }),
      { tz: 'utc' },
    );
    assertSafe(md);
    expect(md).toContain('no claims recognized in the final message (0 claims · 7 sentences)');
    expect(md).toContain('claims recognized: 2 (of which 2 not scored)');
  });

  it('plan usage and prices-as-of reach the cost line; ≈ marks unverified rates', () => {
    const receipt = makeReceipt();
    receipt.cost = { ...receipt.cost, unverified: true, planUsagePct: 12, asOf: '2026-07-15' };
    const md = renderMarkdownReceipt(receipt, { tz: 'utc' });
    expect(md).toContain('cost ≈$1.23 (API-equivalent) · cache hit 71% · plan usage 12% · prices as of 2026-07-15');
  });
});
