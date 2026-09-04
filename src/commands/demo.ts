/**
 * `showreceipts demo` (§12.1, §14.1, S23b): renders every built-in synthetic
 * scenario as a receipt — the §10.2 sample receipts among them — without
 * touching any real transcript, the cache or the network.
 *
 * Fixed by design (§14.1 / S23b): cache disabled (sessions are generated in
 * memory), built-in prices only, `homeDir = '/home/u'` and `--tz` defaulting
 * to `utc`, so the output is byte-identical everywhere (`docs/samples/*.txt`
 * pins it). `--json` emits the receipts as one JSON array; the hidden
 * `--svg FILE` writes the first scenario's SVG (S33's screenshot script).
 *
 * S24 rewired the render-option resolution through the shared preparation
 * (`commands/common.ts prepare` — width, unicode, colour, and the platform
 * seam for the unicode default). The preparation's roots and price table are
 * deliberately unused: demo receipts price with the built-in table and never
 * read a session root, an override or the cache (§12.1).
 */
import { writeFileSync } from 'node:fs';
import type { CommandContext } from '../cli/context.js';
import type { Receipt, Session, SessionRef } from '../model/types.js';
import { echoHashes } from '../claims/text.js';
import { loadPriceTable } from '../cost/resolve.js';
import type { Scenario } from '../demo/dsl.js';
import { generate } from '../demo/gen.js';
import { SCENARIOS } from '../demo/scenarios.js';
import { buildLedger } from '../ledger/index.js';
import { buildReceipt } from '../pipeline/receipt.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions } from '../readers/claude-code/reader.js';
import { readCodexSession } from '../readers/codex/reader.js';
import { readLedgerSession } from '../readers/ledger/reader.js';
import { renderReceiptSvg } from '../render/svg.js';
import { renderReceipt, type TermOptions } from '../render/term.js';
import { stableStringify } from '../util/json.js';
import type { Tz } from '../util/time.js';
import { prepare } from './common.js';
import { sharedOptions, usage, type HelpSection } from './help.js';

/** The synthetic home every demo path lives under (scenario cwds are `/home/u/proj/<name>`). */
export const DEMO_HOME = '/home/u';

/** The §12.4 help section of `demo` (S24; pinned against `cli/help.ts` by the drift tests). */
export const HELP: HelpSection = {
  summary: 'Render bundled synthetic receipts (no data needed)',
  synopsis: 'showreceipts demo [--json] [--width N] [--ascii] [--tz …]',
  detail:
    'Renders bundled synthetic receipts so you can see the output without any session data. Ignores every root on disk, the parse cache and every price override.',
  options: [
    ...sharedOptions(['json', 'width', 'ascii', 'unicode', 'no-color', 'tz', 'now']),
    { flag: 'verbose', text: 'Print unknown-shape counts and other diagnostics' },
    ...sharedOptions(['debug']),
  ],
};

/**
 * Builds the `Session` of one scenario the way the real pipeline would:
 * generator → harness reader (in-memory line sources) → ledger → echo hashes.
 */
async function sessionOf(scenario: Scenario): Promise<Session> {
  const g = generate(scenario);
  let session: Session;
  if (scenario.harness === 'claude-code') {
    const ref: SessionRef = {
      harness: 'claude-code',
      sessionId: scenario.sessionId,
      path: '',
      size: 0,
      mtimeMs: 0,
      subagentManifest: [],
    };
    const opts: ClaudeCodeReadOptions = { lines: g.lines, home: DEMO_HOME };
    if (g.subagents !== undefined) opts.subagents = { kind: 'memory', files: g.subagents };
    session = (await readClaudeCodeSession(ref, opts)).session;
  } else if (scenario.harness === 'codex') {
    const ref: SessionRef = {
      harness: 'codex',
      sessionId: scenario.sessionId,
      path: `${DEMO_HOME}/.codex/sessions/${g.lines.kind === 'text' ? g.lines.name : ''}`,
      size: 0,
      mtimeMs: 0,
      subagentManifest: [],
    };
    session = (await readCodexSession(ref, { lines: g.lines, home: DEMO_HOME })).session;
  } else {
    const ref: SessionRef = {
      harness: scenario.ledgerHarness ?? 'cursor',
      sessionId: scenario.sessionId,
      path: '',
      size: 0,
      mtimeMs: 0,
      subagentManifest: [],
      ledger: true,
    };
    session = readLedgerSession(ref, { lines: g.ledger ?? g.lines, home: `${DEMO_HOME}/.showreceipts` });
  }
  session.ledger = buildLedger(session);
  for (const turn of session.turns) {
    turn.echoHashes = turn.userText === null || turn.userText === '' ? [] : echoHashes(turn.userText);
  }
  return session;
}

/**
 * The receipts of every built-in scenario, in `SCENARIOS` order, priced with
 * the bundled table. Deterministic: `now` only keeps the `buildReceipt` call
 * uniform (receipts carry no generated-at field).
 */
export async function demoReceipts(now: Date): Promise<Receipt[]> {
  const prices = loadPriceTable();
  const receipts: Receipt[] = [];
  for (const scenario of SCENARIOS) {
    const session = await sessionOf(scenario);
    receipts.push(buildReceipt(session, { now, prices, homeDir: DEMO_HOME }));
  }
  return receipts;
}

/**
 * Runs the command; returns the exit code (§12.2). Render options resolve
 * through the shared preparation (S24: `commands/common.ts prepare`, which
 * wraps the S20 primitives and the platform seam); everything else about the
 * preparation — roots, window, prices — is unused by design (§14.1).
 */
export async function run(ctx: CommandContext): Promise<number> {
  const flags = ctx.args.flags;
  if (flags['help'] === true) {
    ctx.stdout.write(usage('demo', HELP));
    return 0;
  }
  const { cols, unicode, color } = prepare(ctx).render;
  const tz: Tz = flags['tz'] === 'local' ? 'local' : 'utc'; // demo defaults to utc (S23b)

  const receipts = await demoReceipts(ctx.now);

  if (flags['json'] === true) {
    ctx.stdout.write(`${stableStringify(receipts)}\n`);
  } else {
    const opts: TermOptions = { cols, unicode, color, tz, homeDir: DEMO_HOME };
    ctx.stdout.write(receipts.map((r) => renderReceipt(r, opts)).join('\n'));
  }

  const svgPath = flags['svg'];
  if (typeof svgPath === 'string' && svgPath !== '') {
    const first = receipts[0];
    if (first !== undefined) {
      writeFileSync(svgPath, renderReceiptSvg(first, { cols, unicode, tz, homeDir: DEMO_HOME }));
    }
  }
  return 0;
}
