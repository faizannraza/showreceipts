/**
 * S24 — the `session` command (§12.1–§12.3): selector resolution over the
 * scanned set (latest, full id, prefix, ambiguous, path, missing — the exit-5
 * contract), `--json` against the schema, `--timeline`, `--explain-claim`,
 * `--turn`, plus the rewired `export` smoke and the §12.4 help-section drift
 * pins for `session` and `export`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Receipt } from '../../../src/model/types.js';
import { flagsFor, parse, type CommandName } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { commandHelp } from '../../../src/cli/help.js';
import { main } from '../../../src/cli.js';
import { HELP as EXPORT_HELP } from '../../../src/commands/export.js';
import { formatOption, type HelpSection } from '../../../src/commands/help.js';
import { HELP as SESSION_HELP, renderExplanations, run as runSession } from '../../../src/commands/session.js';
import { displayWidth } from '../../../src/util/width.js';
import { materialize } from '../../helpers/fixtures.js';
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
// A codex tree with three sessions: the two 0.98.0 rollouts (Feb 2026, ids
// sharing the `019c` prefix) and `shell_command` (Aug 2026, the newest done
// turn — `latest`).
// ---------------------------------------------------------------------------

const tree = makeTempDir('showreceipts-session-');
materialize('codex/0.98.0', tree);
const shell = materialize('codex/shell_command', tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });

const ENV: Record<string, string> = {
  HOME: home,
  CLAUDE_CONFIG_DIR: join(tree, 'claude'),
  CODEX_HOME: join(tree, 'codex'),
  SHOWRECEIPTS_HOME: join(tree, 'sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

const COMMON = ['--since', '2026-01-01', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u'];

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

/** The `session latest --json` receipt (memoised — the tree never changes). */
let latestMemo: Receipt | undefined;
async function latestReceipt(): Promise<Receipt> {
  if (latestMemo === undefined) {
    const { code, out } = await runCli(['session', 'latest', '--json', ...COMMON]);
    expect(code).toBe(0);
    latestMemo = JSON.parse(out) as Receipt;
  }
  return latestMemo;
}

// ---------------------------------------------------------------------------
// Selector resolution (§12.1/§12.2)
// ---------------------------------------------------------------------------

describe('session selector resolution', () => {
  it('latest --json is the newest done-turn session and validates against the schema', async () => {
    const receipt = await latestReceipt();
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(receipt.schema).toBe('showreceipts.receipt/1');
    expect(receipt.harness).toBe('codex');
    // shell_command is the August 2026 fixture — newer than the Feb rollouts
    expect(receipt.endedAt.startsWith('2026-08')).toBe(true);
  });

  it('latest renders the full boxed receipt with every line within the width', async () => {
    const receipt = await latestReceipt();
    const { code, out } = await runCli(['session', 'latest', ...COMMON]);
    expect(code).toBe(0);
    expect(out).toContain(`RECEIPT  #${receipt.shortId}`);
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('a full session id resolves', async () => {
    const receipt = await latestReceipt();
    const { code, out } = await runCli(['session', receipt.id, '--json', ...COMMON]);
    expect(code).toBe(0);
    expect((JSON.parse(out) as Receipt).id).toBe(receipt.id);
  });

  it('a unique short-id prefix (≥ 4 chars) resolves', async () => {
    const receipt = await latestReceipt();
    const { code, out } = await runCli(['session', receipt.shortId.slice(0, 6), '--json', ...COMMON]);
    expect(code).toBe(0);
    expect((JSON.parse(out) as Receipt).id).toBe(receipt.id);
  });

  it('an ambiguous prefix exits 5 and lists the candidates', async () => {
    // Every codex session id is a 2026 UUIDv7: all three share the 019c prefix.
    const { code, err } = await runCli(['session', '019c', ...COMMON]);
    expect(code).toBe(5);
    expect(err).toContain('ambiguous');
    const candidateLines = err.split('\n').filter((l) => l.startsWith('  '));
    expect(candidateLines.length).toBeGreaterThanOrEqual(2);
  });

  it('a transcript path resolves directly', async () => {
    const rollout = shell.paths.find((p) => /rollout-.*\.jsonl$/.test(p));
    expect(rollout).toBeDefined();
    const { code, out } = await runCli(['session', rollout as string, '--json', ...COMMON]);
    expect(code).toBe(0);
    expect(validateAgainst(doc, 'session', JSON.parse(out))).toEqual([]);
  });

  it('an unknown id exits 5', async () => {
    const { code, err } = await runCli(['session', 'deadbeef', ...COMMON]);
    expect(code).toBe(5);
    expect(err).toContain("no session matches 'deadbeef'");
  });

  it('a missing selector is a usage error (exit 2)', async () => {
    const { code, err } = await runCli(['session', ...COMMON]);
    expect(code).toBe(2);
    expect(err).toContain('missing <id|prefix|path|latest>');
  });

  it('latest over a tree with only no-turns sessions exits 5 with a message', async () => {
    const t = makeTempDir('showreceipts-session-noturns-');
    const m = materialize('claude-code/2.1.243', t);
    const env: Record<string, string> = {
      HOME: join(t, 'home'),
      CLAUDE_CONFIG_DIR: m.claudeConfigDir as string,
      CODEX_HOME: join(t, 'codex-none'),
      SHOWRECEIPTS_HOME: join(t, 'sr'),
    };
    mkdirSync(env['HOME'] as string, { recursive: true });
    const { code, err } = await runCli(['session', 'latest', ...COMMON], env);
    expect(code).toBe(5);
    expect(err).toContain('no session with a done turn');
    rmSync(t, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// --turn / --timeline / --explain-claim
// ---------------------------------------------------------------------------

describe('session receipt options', () => {
  it('--turn with an unknown index is a usage error (exit 2)', async () => {
    const { code, err } = await runCli(['session', 'latest', '--turn', '9999', ...COMMON]);
    expect(code).toBe(2);
    expect(err).toContain('--turn');
  });

  it('--timeline appends the evidence timeline (text) and embeds it (--json)', async () => {
    const text = await runCli(['session', 'latest', '--timeline', ...COMMON]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('TIME');
    expect(text.out).toContain('TOOL');
    const { code, out } = await runCli(['session', 'latest', '--timeline', '--json', ...COMMON]);
    expect(code).toBe(0);
    const receipt = JSON.parse(out) as Receipt;
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(Array.isArray(receipt.timeline)).toBe(true);
    expect((receipt.timeline as unknown[]).length).toBeGreaterThan(0);
  });

  it('--explain-claim appends the explanation block (text) and embeds it (--json)', async () => {
    const text = await runCli(['session', 'latest', '--explain-claim', ...COMMON]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('EXPLANATIONS');
    const { code, out } = await runCli(['session', 'latest', '--explain-claim', '--json', ...COMMON]);
    expect(code).toBe(0);
    const receipt = JSON.parse(out) as Receipt;
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(Array.isArray(receipt.explanations)).toBe(true);
    expect((receipt.explanations as unknown[]).length).toBe(receipt.judgements.length);
  });

  it('renderExplanations keeps every line within the width and sanitises hostile text', () => {
    const hostile = '[31mRLO‮ evil[0m claim';
    const lines = renderExplanations(
      [
        {
          claimId: 'c1',
          sentence: hostile,
          clause: hostile,
          rule: 'file-updated',
          trigger: 'Updated',
          cue: 'updated',
          polarity: 'positive',
          attribution: 'agent',
          row: 3,
          factsExamined: ['write src/x.ts → ok (12:00)', 'no test run in log'],
          why: 'VERIFIED (write-observed) — the write was seen',
        },
      ],
      { cols: 60, unicode: false },
    );
    expect(lines[0]).toBe('EXPLANATIONS');
    const text = lines.join('\n');
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text).not.toContain('‮');
    expect(text).toContain('rule file-updated');
    expect(text).toContain('reconcile row 3');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
  });

  it('renderExplanations with no claims says so', () => {
    const lines = renderExplanations([], { cols: 80, unicode: true });
    expect(lines).toEqual(['EXPLANATIONS', '  no claims to explain']);
  });
});

// ---------------------------------------------------------------------------
// The rewired export command (S24 smoke; the full e2e matrix is S26)
// ---------------------------------------------------------------------------

describe('export (rewired through commands/common.ts)', () => {
  it('export latest --json validates against the schema', async () => {
    const { code, out } = await runCli(['export', 'latest', '--json', ...COMMON]);
    expect(code).toBe(0);
    expect(validateAgainst(doc, 'export', JSON.parse(out))).toEqual([]);
  });

  it('export latest --md renders the badge line', async () => {
    const { code, out } = await runCli(['export', 'latest', '--md', ...COMMON]);
    expect(code).toBe(0);
    expect(out).toContain('**showreceipts**');
  });

  it('exactly one of --md/--json is required (exit 2, both ways)', async () => {
    const neither = await runCli(['export', 'latest', ...COMMON]);
    expect(neither.code).toBe(2);
    const both = await runCli(['export', 'latest', '--md', '--json', ...COMMON]);
    expect(both.code).toBe(2);
  });

  it('--out writes the file instead of stdout', async () => {
    const target = join(cwd, 'receipt.md');
    const { code, out } = await runCli(['export', 'latest', '--md', '--out', target, ...COMMON]);
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('**showreceipts**');
  });

  it('an ambiguous prefix exits 5 with candidates', async () => {
    const { code, err } = await runCli(['export', '019c', '--json', ...COMMON]);
    expect(code).toBe(5);
    expect(err).toContain('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// §12.4 help sections (S24: session + export)
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
  it('the session section is pinned against cli/help.ts and the flag table', () => {
    expectSectionPinned('session', SESSION_HELP);
  });

  it('the export section is pinned against cli/help.ts and the flag table', () => {
    expectSectionPinned('export', EXPORT_HELP);
  });

  it('session --help and export --help exit 0 with only the help text (cli path)', async () => {
    for (const command of ['session', 'export'] as const) {
      const { code, out, err } = await runCli([command, '--help']);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toBe(commandHelp(command));
    }
  });

  it('run() answers --help directly with the S24 section', async () => {
    const out = sink();
    const ctx = createContext(parse(['session', '--help']), { stdout: out, stderr: sink(), env: ENV, cwd, now: NOW, isTTY: false });
    expect(await runSession(ctx)).toBe(0);
    expect(out.text.startsWith('showreceipts session — ')).toBe(true);
  });
});
