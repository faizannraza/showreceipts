/**
 * S36 — `report` build budget (§11.1, §14.2): 500 session cards with 50
 * embedded timelines must serialise to a data block ≤ 5 MB and build (turn
 * receipts → cards → rate rows → payload → budget → HTML) in < 2 s
 * (× tolerance). The sessions are generated on disk and loaded through the
 * real pipeline so the numbers cover the same path `showreceipts report`
 * runs after its scan.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPriceTable } from '../../src/cost/resolve.js';
import { resolveRoots } from '../../src/discover/roots.js';
import type { RateRow, Receipt, Roots } from '../../src/model/types.js';
import { buildRateRows, buildSessionCard, sessionKey, type ReceiptIndex } from '../../src/pipeline/cards.js';
import { buildReceipt, buildTurnReceipts, type ReceiptOptions } from '../../src/pipeline/receipt.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { buildTimeline } from '../../src/pipeline/timeline.js';
import { applyBudget } from '../../src/render/budget.js';
import { renderHtml, selfCheck } from '../../src/render/html.js';
import { buildReportPayload, type ReportSessionInput } from '../../src/render/payload.js';
import { TOOL_VERSION } from '../../src/version.js';
import { PINNED_NOW } from '../helpers/env.js';
import { makeTempDir } from '../helpers/tmp.js';
import { PERF, tolerance } from './util.js';

const NOW = new Date(PINNED_NOW);
const SESSIONS = 500;
const TIMELINES = 50;
const CYCLES = 6;
const DATA_CAP_BYTES = 5 * 1024 * 1024;
const BUILD_CAP_MS = 2000;

const DATA_BLOCK_RE = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One parseable session: prompt, {@link CYCLES} Bash test cycles, a claiming final. Hour `i` sets recency. */
function sessionLines(sid: string, i: number): string {
  const base = Date.UTC(2026, 6, 1, 0, 0, 0) + i * 3_600_000;
  let n = 0;
  const common = (extra: object): string => {
    const line = {
      parentUuid: n === 0 ? null : `u-${sid.slice(0, 8)}-${n - 1}`,
      isSidechain: false,
      uuid: `u-${sid.slice(0, 8)}-${n}`,
      timestamp: new Date(base + n * 1000).toISOString(),
      userType: 'external',
      cwd: '/home/u/proj',
      sessionId: sid,
      version: '2.1.251',
      gitBranch: 'main',
      ...extra,
    };
    n += 1;
    return JSON.stringify(line);
  };
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' };
  const lines: string[] = [
    common({ type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: `run suite ${i}` }] } }),
  ];
  for (let c = 0; c < CYCLES; c++) {
    const toolUseId = `toolu_${sid.slice(0, 8)}_${c}`;
    lines.push(
      common({
        type: 'assistant',
        message: {
          id: `msg_${sid.slice(0, 8)}_${c}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `npm test -- --run suite-${c}` } }],
          usage,
        },
      }),
    );
    lines.push(
      common({
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: '12 passed' }] }] },
        toolUseResult: { stdout: '12 passed', stderr: '', interrupted: false, isImage: false },
      }),
    );
  }
  lines.push(
    common({
      type: 'assistant',
      message: {
        id: `msg_${sid.slice(0, 8)}_final`,
        type: 'message',
        role: 'assistant',
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `All 12 tests pass. Updated \`src/area-${i % 37}.ts\` along the way.` }],
        usage,
      },
    }),
  );
  return `${lines.join('\n')}\n`;
}

describe.skipIf(!PERF)('report build (§11.1)', () => {
  it(`${SESSIONS} cards + ${TIMELINES} timelines: data block <= 5 MB, build < 2 s`, async () => {
    const tol = tolerance();
    const root = makeTempDir('showreceipts-perf-report-');
    dirs.push(root);
    const claude = join(root, 'claude');
    const project = join(claude, 'projects', '-home-u-proj');
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < SESSIONS; i++) {
      const sid = `${String(i).padStart(8, '0')}-2222-4333-8444-555566667777`;
      writeFileSync(join(project, `${sid}.jsonl`), sessionLines(sid, i));
    }
    for (const name of ['home', 'codex', 'sr']) mkdirSync(join(root, name), { recursive: true });
    const roots: Roots = resolveRoots(
      { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'), SHOWRECEIPTS_HOME: join(root, 'sr') },
      join(root, 'home'),
    );

    const load = await loadSessions({ roots, all: true, versions: { tool: TOOL_VERSION }, now: NOW });
    expect(load.sessions.length).toBe(SESSIONS);

    // The report build proper (what `commands/report.ts` runs after its scan).
    const prices = loadPriceTable();
    const receiptOpts: ReceiptOptions = { now: NOW, prices, homeDir: roots.userHome };
    const t0 = performance.now();
    const receiptIndexMap = new Map<string, Map<number, Receipt>>();
    const inputs: ReportSessionInput[] = [];
    for (const session of load.sessions) {
      const turnReceipts = buildTurnReceipts(session, receiptOpts);
      receiptIndexMap.set(sessionKey(session), turnReceipts);
      const receipt = buildReceipt(session, receiptOpts);
      const card = buildSessionCard(session, turnReceipts);
      const input: ReportSessionInput = { card, receipt };
      // Timelines for the --full set only (the 50 most recent; sessions are
      // sorted by recency) — the §11.1 shape the report embeds.
      if (inputs.length < TIMELINES) {
        const turn = session.turns.find((t) => t.index === receipt.turnIndex);
        if (turn !== undefined) input.timeline = buildTimeline(session, turn, { table: prices });
      }
      inputs.push(input);
    }
    const index: ReceiptIndex = receiptIndexMap;
    const rows: RateRow[] = buildRateRows(load.sessions, index);
    const built = buildReportPayload(inputs, {
      now: NOW,
      full: TIMELINES,
      rows,
      toolVersion: TOOL_VERSION,
      rulesVersion: 'perf',
      pricesVersion: prices.version,
    });
    const { payload } = applyBudget(built.payload, built.fullKeys);
    const html = renderHtml(payload);
    const ms = performance.now() - t0;

    const data = DATA_BLOCK_RE.exec(html);
    expect(data).not.toBeNull();
    const dataBytes = Buffer.byteLength((data as RegExpExecArray)[1] as string, 'utf8');
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    process.stdout.write(
      `report: ${payload.sessions.length} cards + ${Object.keys(payload.timelines).length} timelines, ` +
        `data ${(dataBytes / 1048576).toFixed(2)} MB, html ${(htmlBytes / 1048576).toFixed(2)} MB, build ${ms.toFixed(0)} ms\n`,
    );

    expect(payload.sessions.length).toBe(SESSIONS);
    expect(Object.keys(payload.timelines).length).toBe(TIMELINES);
    expect(selfCheck(html).ok).toBe(true);
    expect(dataBytes).toBeLessThanOrEqual(DATA_CAP_BYTES);
    expect(ms).toBeLessThan(BUILD_CAP_MS * tol);
  }, 300_000);
});
