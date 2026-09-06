/**
 * S24 — the `audit` command (§12.1–§12.3, §10.1–§10.2): the audit screen
 * over the materialised fixture tree, the `showreceipts.audit/1` envelope,
 * filters, exit codes, the warm-cache `--as-of` recompute (§4.9: prices
 * never invalidate a parse), failure containment (one bad file never aborts
 * the scan) and the §12.4 help-section drift pins for `audit` and `demo`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { flagsFor, parse, type CommandName } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { commandHelp } from '../../../src/cli/help.js';
import { main } from '../../../src/cli.js';
import type { Receipt, SessionCard } from '../../../src/model/types.js';
import { HELP as AUDIT_HELP, noClaimsHintOf, run as runAudit, type AuditJson } from '../../../src/commands/audit.js';
import { HELP as DEMO_HELP } from '../../../src/commands/demo.js';
import { formatOption, type HelpSection } from '../../../src/commands/help.js';
import { displayWidth } from '../../../src/util/width.js';
import { materialize, materializeAll } from '../../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../../helpers/schema.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const doc = loadSchemaDoc();

interface Sink extends NodeJS.WritableStream {
  text: string;
}

function sink(): Sink {
  const s = {
    text: '',
    write(chunk: unknown): boolean {
      s.text += String(chunk);
      return true;
    },
  };
  return s as unknown as Sink;
}

// ---------------------------------------------------------------------------
// One materialised fixture tree, shared by every test in this file. The
// SHOWRECEIPTS_HOME is shared too, so later invocations exercise the warm
// cache exactly like a second real run would.
// ---------------------------------------------------------------------------

const tree = makeTempDir('showreceipts-audit-');
const materialized = materializeAll(tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
for (const dir of [home, cwd, join(tree, 'sr')]) mkdirSync(dir, { recursive: true });

const ENV: Record<string, string> = {
  HOME: home,
  CLAUDE_CONFIG_DIR: materialized.claudeConfigDir,
  CODEX_HOME: materialized.codexHome,
  SHOWRECEIPTS_HOME: join(tree, 'sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

/** The §0.4 base invocation over the fixture tree (Feb–Aug 2026 sessions need `--since 2026-01-01`). */
const BASE = ['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u'];

async function runCli(
  argv: readonly string[],
  env: Record<string, string> = ENV,
  cwdDir: string = cwd,
): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await main(argv, { stdout: out, stderr: err, env, cwd: cwdDir, now: NOW, isTTY: false });
  return { code, out: out.text, err: err.text };
}

async function auditJson(extra: readonly string[] = [], env?: Record<string, string>): Promise<AuditJson> {
  const { code, out } = await runCli([...BASE, '--json', ...extra], env);
  expect(code).toBe(0);
  return JSON.parse(out) as AuditJson;
}

// ---------------------------------------------------------------------------
// The audit screen (text)
// ---------------------------------------------------------------------------

describe('audit over the fixture tree (text)', () => {
  it('prints header, table, latest receipt, rate table and footer at width 80', async () => {
    const { code, out, err } = await runCli(BASE);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('showreceipts 0.1.0');
    expect(out).toMatch(/scanned \d+ sessions/);
    // the 2026 window: the 2025-dated `legacy` fixture is outside `--since 2026-01-01`
    expect(out).toContain('Claude Code 6');
    expect(out).toContain('Codex 3');
    // summary table headers, the latest receipt box and the footer
    expect(out).toContain('ID');
    expect(out).toContain('VERDICT');
    expect(out).toContain('RECEIPT');
    expect(out).toContain('report → .showreceipts/report.html');
    // temp homes carry no hook configs ⇒ the setup hint shows (§10.2)
    expect(out).toContain('setup → npx showreceipts setup');
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('renders every line within --width 60 (narrow mode)', async () => {
    const { code, out } = await runCli(['audit', '--since', '2026-01-01', '--width', '60', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u']);
    expect(code).toBe(0);
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });

  it('--ascii output carries no unicode frame or separator glyphs', async () => {
    const { code, out } = await runCli(['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--ascii', '--tz', 'utc', '--home-dir', '/home/u']);
    expect(code).toBe(0);
    expect(out).not.toContain('┌');
    expect(out).not.toContain('·');
    expect(out).toContain('report -> .showreceipts/report.html');
  });

  it('--limit 1 shortens the session table', async () => {
    const one = await runCli([...BASE, '--limit', '1']);
    const twenty = await runCli(BASE);
    expect(one.code).toBe(0);
    expect(one.out.split('\n').length).toBeLessThan(twenty.out.split('\n').length);
  });

  it('--all-claims never renders the +N-more cap line', async () => {
    const capped = await runCli(BASE);
    const all = await runCli([...BASE, '--all-claims']);
    expect(all.code).toBe(0);
    expect(all.out).not.toContain('more claims');
    expect(all.out.split('\n').length).toBeGreaterThanOrEqual(capped.out.split('\n').length);
  });
});

// ---------------------------------------------------------------------------
// audit --json (§12.3)
// ---------------------------------------------------------------------------

describe('audit --json', () => {
  it('validates against the audit schema, with the DoD fixture counts', async () => {
    const { code, out } = await runCli([...BASE, '--json']);
    expect(code).toBe(0);
    // stableStringify'd, one line, trailing newline, nothing else on stdout
    expect(out.endsWith('\n')).toBe(true);
    expect(out.indexOf('\n')).toBe(out.length - 1);
    const parsed = JSON.parse(out) as AuditJson;
    expect(validateAgainst(doc, 'audit', parsed)).toEqual([]);
    expect(parsed.schema).toBe('showreceipts.audit/1');
    expect(parsed.generatedAt).toBe('2026-08-29T12:00:00.000Z');
    expect(parsed.scanned.byHarness['claude-code']).toBe(6);
    expect(parsed.scanned.byHarness['codex']).toBe(3);
    expect(parsed.sessions).toHaveLength(9);
    expect(parsed.scanned.sessions).toBe(9);
    expect(parsed.latest).not.toBeNull();
    // the no-turns fixture (2.1.243) shows as `—` in the table (§10.1)
    expect(parsed.sessions.some((c) => c.kind === 'no-turns' && c.verdict === '—')).toBe(true);
    expect(parsed.rate.length).toBeGreaterThan(0);
  });

  it('warm cache reproduces the cold receipts exactly (§4.9)', async () => {
    const cold = await auditJson();
    const warm = await auditJson();
    expect(warm.scanned.cacheHits).toBe(warm.scanned.sessions);
    expect(warm.sessions).toEqual(cold.sessions);
    expect(warm.rate).toEqual(cold.rate);
    expect(warm.latest).toEqual(cold.latest);
  });

  it('--all lifts the window and picks up the 2025 legacy fixture (the full DoD list)', async () => {
    const { code, out } = await runCli(['audit', '--all', '--json', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as AuditJson;
    expect(parsed.scanned.byHarness['claude-code']).toBe(7);
    expect(parsed.scanned.byHarness['codex']).toBe(3);
    expect(parsed.sessions).toHaveLength(10);
  });

  it('--harness codex keeps only the codex sessions', async () => {
    const parsed = await auditJson(['--harness', 'codex']);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions.every((c) => c.harness === 'codex')).toBe(true);
  });

  it('--project matches the session cwd as a substring', async () => {
    const parsed = await auditJson(['--project', 'proj1']);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions.every((c) => c.harness === 'codex' && c.cwd.includes('proj1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Warm-cache `--as-of` recompute (the S24 assertion; §4.9/§8.3 pins)
// ---------------------------------------------------------------------------

describe('warm --as-of recompute (codex/shell_command)', () => {
  const t2 = makeTempDir('showreceipts-audit-asof-');
  const m2 = materialize('codex/shell_command', t2);
  const env2: Record<string, string> = {
    HOME: join(t2, 'home'),
    CLAUDE_CONFIG_DIR: join(t2, 'claude-none'),
    CODEX_HOME: m2.codexHome as string,
    SHOWRECEIPTS_HOME: join(t2, 'sr'),
  };
  mkdirSync(env2['HOME'] as string, { recursive: true });

  afterAll(() => {
    rmSync(t2, { recursive: true, force: true });
  });

  it('cold run prices the from-2026-07-30 window; warm --as-of switches windows without re-parsing', async () => {
    const cold = await auditJson([], env2);
    expect(cold.scanned.sessions).toBe(1);
    expect(cold.scanned.cacheHits).toBe(0);
    expect(cold.latest?.cost.usd).toBeCloseTo(0.020749, 6);

    const warm = await auditJson(['--as-of', '2026-07-15'], env2);
    expect(warm.scanned.sessions).toBe(1);
    expect(warm.scanned.cacheHits).toBe(1); // === sessions: the parse came from the cache
    expect(warm.latest?.cost.usd).toBeCloseTo(0.025936, 6);
    expect(warm.latest?.cost.asOf).toBe('2026-07-15');
  });

  it('the receipt cost line reads `prices as of 2026-07-15`', async () => {
    const { code, out } = await runCli([...BASE, '--as-of', '2026-07-15'], env2);
    expect(code).toBe(0);
    expect(out).toContain('prices as of 2026-07-15');
  });
});

// ---------------------------------------------------------------------------
// Failure containment and exit codes (§12.2)
// ---------------------------------------------------------------------------

describe('failure containment and exit codes', () => {
  it('empty roots exit 0 with the demo hint', async () => {
    const t = makeTempDir('showreceipts-audit-empty-');
    const env: Record<string, string> = {
      HOME: join(t, 'home'),
      CLAUDE_CONFIG_DIR: join(t, 'claude'),
      CODEX_HOME: join(t, 'codex'),
      SHOWRECEIPTS_HOME: join(t, 'sr'),
    };
    mkdirSync(env['HOME'] as string, { recursive: true });
    const text = await runCli(BASE, env);
    expect(text.code).toBe(0);
    expect(text.out).toContain('no sessions found');
    expect(text.out).toContain('showreceipts demo');
    const { code, out } = await runCli([...BASE, '--json'], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as AuditJson;
    expect(validateAgainst(doc, 'audit', parsed)).toEqual([]);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.latest).toBeNull();
    rmSync(t, { recursive: true, force: true });
  });

  it('a garbage .jsonl in the tree never aborts the scan', async () => {
    const t = makeTempDir('showreceipts-audit-garbage-');
    const m = materialize('codex/shell_command', t);
    const badDir = join(m.codexHome as string, 'sessions', '2026', '08', '20');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'rollout-2026-08-20T10-00-00-01999999-aaaa-7aaa-8aaa-aaaaaaaaaaaa.jsonl'), 'not json\n{{{\n');
    const env: Record<string, string> = {
      HOME: join(t, 'home'),
      CLAUDE_CONFIG_DIR: join(t, 'claude-none'),
      CODEX_HOME: m.codexHome as string,
      SHOWRECEIPTS_HOME: join(t, 'sr'),
    };
    mkdirSync(env['HOME'] as string, { recursive: true });
    const { code, out } = await runCli([...BASE, '--json'], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as AuditJson;
    expect(parsed.sessions.length).toBeGreaterThanOrEqual(1);
    rmSync(t, { recursive: true, force: true });
  });

  it('--width 39 is a usage error (exit 2)', async () => {
    const { code, err } = await runCli(['audit', '--width', '39']);
    expect(code).toBe(2);
    expect(err).toContain('--width');
  });

  it('malformed --as-of is a usage error (exit 2)', async () => {
    const { code, err } = await runCli(['audit', '--as-of', 'nope']);
    expect(code).toBe(2);
    expect(err).toContain('--as-of');
  });

  it('an unknown --harness is a usage error (exit 2)', async () => {
    const { code, err } = await runCli(['audit', '--harness', 'clippy']);
    expect(code).toBe(2);
    expect(err).toContain('clippy');
  });

  it('an invalid --prices file is a runtime failure (exit 1)', async () => {
    const bad = join(tree, 'bad-prices.json');
    writeFileSync(bad, '{not json');
    const { code, err } = await runCli([...BASE, '--prices', bad]);
    expect(code).toBe(1);
    expect(err).toContain('prices');
  });

  it('a missing --prices file is a runtime failure (exit 1)', async () => {
    const { code, err } = await runCli([...BASE, '--prices', join(tree, 'no-such-prices.json')]);
    expect(code).toBe(1);
    expect(err).toContain('cannot read file');
  });
});

// ---------------------------------------------------------------------------
// §12.4 help sections (S24: audit + demo; the session/export pins live in
// session.test.ts)
// ---------------------------------------------------------------------------

/** Pins one command's S24 `HelpSection` against the S01 renderer (`cli/help.ts`) and the flag table. */
function expectSectionPinned(command: CommandName, section: HelpSection): void {
  const rendered = commandHelp(command);
  expect(rendered).toContain(`showreceipts ${command} — ${section.summary}`);
  const expected = flagsFor(command)
    .filter((s) => !s.hidden && s.name !== 'help' && s.name !== 'version')
    .map((s) => s.name);
  expect(section.options.map((r) => r.flag)).toEqual(expected);
  for (const row of section.options) {
    expect(rendered, `${command}: --${row.flag}`).toContain(`\n${formatOption(row)}\n`);
  }
}

describe('§12.4 help sections', () => {
  it('the audit section is pinned against cli/help.ts and the flag table', () => {
    expectSectionPinned('audit', AUDIT_HELP);
  });

  it('the demo section is pinned against cli/help.ts and the flag table', () => {
    expectSectionPinned('demo', DEMO_HELP);
  });

  it('audit --help exits 0 with only the help text (cli path)', async () => {
    const { code, out, err } = await runCli(['audit', '--help']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe(commandHelp('audit'));
  });

  it('run() answers --help directly with the S24 section', async () => {
    const out = sink();
    const ctx = createContext(parse(['audit', '--help']), { stdout: out, stderr: sink(), env: ENV, cwd, now: NOW, isTTY: false });
    expect(await runAudit(ctx)).toBe(0);
    expect(out.text.startsWith('showreceipts audit — ')).toBe(true);
    expect(out.text).toContain('Nothing leaves this machine.');
  });
});

// ---------------------------------------------------------------------------
// noClaimsHintOf (Pass 3: the audit-only CLAIMS-column cross-reference)
// ---------------------------------------------------------------------------

describe('noClaimsHintOf', () => {
  const receiptOf = (over: Partial<Receipt> = {}): Receipt =>
    ({ kind: 'no-claims', shortId: '1e2c0d07', claimsRecognized: 0, turnIndex: 6, turnsWithClaims: [2, 4], ...over }) as Receipt;
  const cardOf = (claims: number): SessionCard => ({ claims }) as SessionCard;

  it('points at the newest earlier turn with scored claims', () => {
    expect(noClaimsHintOf(receiptOf(), cardOf(4))).toEqual({ claims: 4, sessionShortId: '1e2c0d07', turn: 4 });
  });

  it("subtracts the final turn's own recognized count and omits --turn without earlier scored turns", () => {
    expect(noClaimsHintOf(receiptOf({ claimsRecognized: 1, turnsWithClaims: [] }), cardOf(3))).toEqual({
      claims: 2,
      sessionShortId: '1e2c0d07',
    });
  });

  it('returns undefined for scored receipts, missing cards and zero earlier claims', () => {
    expect(noClaimsHintOf(receiptOf({ kind: 'scored' }), cardOf(4))).toBeUndefined();
    expect(noClaimsHintOf(receiptOf(), undefined)).toBeUndefined();
    expect(noClaimsHintOf(receiptOf(), cardOf(0))).toBeUndefined();
  });
});
