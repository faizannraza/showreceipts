/**
 * S25 — `commands/bench.ts`: the rate table over the fixture tree, the
 * `--json` envelope, the 30-day default window, `--month` calendar snapping
 * (the two February Codex rollouts included) and `--publish` end-to-end —
 * Appendix D validation, byte-identical consecutive runs, month snapping and
 * `partial:true` for the current month.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublishPayload, RateRow } from '../../../src/model/types.js';
import { parse } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { main } from '../../../src/cli.js';
import { CLEANUP_NOTE } from '../../../src/commands/doctor.js';
import { run } from '../../../src/commands/bench.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { materializeAll } from '../../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../../helpers/schema.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const DAY = 86_400_000;
const doc = loadSchemaDoc();
const tree = makeTempDir('sr-bench-tree-');
const fixtures = materializeAll(tree);
const srHome = makeTempDir('sr-bench-srhome-');

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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runBench(argv: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const home = makeTempDir('sr-bench-home-');
  const stdout = sink();
  const stderr = sink();
  const ctx = createContext(parse(argv), {
    stdout,
    stderr,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: fixtures.claudeConfigDir,
      CODEX_HOME: fixtures.codexHome,
      SHOWRECEIPTS_HOME: srHome,
    },
    cwd: opts.cwd ?? makeTempDir('sr-bench-cwd-'),
    now: NOW,
    isTTY: false,
  });
  const code = await run(ctx);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const BASE = ['bench', '--home-dir', '/home/u', '--width', '80', '--no-color', '--unicode'];

describe('bench text and --json', () => {
  it('prints the rate table and the durability note', async () => {
    const r = await runBench([...BASE, '--since', '2026-01-01']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('bench');
    expect(r.stdout).toContain(CLEANUP_NOTE);
  });

  it('--json validates against the schema with the window', async () => {
    const r = await runBench([...BASE, '--since', '2026-01-01', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { schema: string; window: { from: string; to: string }; rows: RateRow[] };
    expect(validateAgainst(doc, 'bench', parsed)).toEqual([]);
    expect(parsed.schema).toBe('showreceipts.bench/1');
    expect(parsed.window.from).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.window.to).toBe(NOW.toISOString());
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it('defaults the window to 30d (not the shared 90d)', async () => {
    const r = await runBench([...BASE, '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { window: { from: string } };
    expect(parsed.window.from).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
  });

  it('--month 2026-02 includes the two February Codex rollouts', async () => {
    const r = await runBench([...BASE, '--month', '2026-02', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { window: { from: string; to: string }; rows: RateRow[] };
    expect(parsed.window.from).toBe('2026-02-01T00:00:00.000Z');
    expect(parsed.window.to).toBe('2026-03-01T00:00:00.000Z');
    const codex = parsed.rows.filter((row) => row.harness === 'codex');
    expect(codex.length).toBeGreaterThan(0);
    expect(codex.reduce((sum, row) => sum + row.sessions, 0)).toBe(2);
    expect(codex.reduce((sum, row) => sum + row.turns, 0)).toBeGreaterThan(0);
    // The August shell_command fixture contributes no turn to February.
    const augustModels = parsed.rows.filter((row) => row.model === 'gpt-5.6-terra' && row.turns > 0);
    expect(augustModels).toEqual([]);
  });
});

describe('--publish refusal wiring (Appendix D → stderr rule + exit 1)', () => {
  it('refuses before writing when the payload carries a forbidden token', async () => {
    // A home directory literally named `showreceipts` puts a ≥ 6-char
    // username into the validator context that is a guaranteed
    // token-boundary substring of the payload's own `schema` string — so
    // the command-level refusal (validate → stderr rule name → exit 1,
    // nothing written) is exercised without any fixture surgery.
    const base = makeTempDir('sr-bench-refuse-');
    const home = join(base, 'showreceipts');
    mkdirSync(home, { recursive: true });
    const outFile = join(base, 'publish.json');
    const stdout = sink();
    const stderr = sink();
    const ctx = createContext(parse(['bench', '--month', '2026-02', '--publish', outFile, '--home-dir', '/home/u']), {
      stdout,
      stderr,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: fixtures.claudeConfigDir,
        CODEX_HOME: fixtures.codexHome,
        SHOWRECEIPTS_HOME: srHome,
      },
      cwd: makeTempDir('sr-bench-cwd-'),
      now: NOW,
      isTTY: false,
    });
    const code = await run(ctx);
    expect(code).toBe(1);
    expect(stderr.text).toContain("bench --publish refused: username: the file contains 'showreceipts'");
    expect(existsSync(outFile)).toBe(false);
  });
});

describe('bench --publish (§13.3, Appendix D)', () => {
  it('writes a validating file under the git root and is byte-identical across runs', async () => {
    const repo = makeTempDir('sr-bench-repo-');
    mkdirSync(join(repo, '.git'));
    const first = await runBench(['bench', '--month', '2026-02', '--publish', '--home-dir', '/home/u'], { cwd: repo });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('publish');
    expect(first.stdout).toContain(CLEANUP_NOTE);
    const dir = join(repo, '.showreceipts');
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name).toMatch(/^2026-02-[0-9a-f]{16}\.json$/);
    const bytes = readFileSync(join(dir, name), 'utf8');
    const payload = JSON.parse(bytes) as PublishPayload;
    expect(validateAgainst(doc, 'bench-publish', payload)).toEqual([]);
    expect(payload.period).toEqual({ from: '2026-02', to: '2026-02', partial: false });
    expect(payload.rows.length).toBeGreaterThan(0);

    // Models are built-in price keys (gpt-5.2-codex resolves to gpt-5.2) or `other`.
    const builtin = new Set(Object.keys(loadPriceTable().models));
    for (const row of payload.rows) {
      expect(row.model === 'other' || builtin.has(row.model), row.model).toBe(true);
    }
    expect(payload.rows.some((row) => row.model === 'gpt-5.2')).toBe(true);

    // No fixture path, session id or day-precision date in the file.
    expect(bytes).not.toContain(tree);
    expect(/\d{4}-\d{2}-\d{2}/.test(bytes.replace(payload.generator.pricesVersion, ''))).toBe(false);

    const second = await runBench(['bench', '--month', '2026-02', '--publish', '--home-dir', '/home/u'], { cwd: repo });
    expect(second.code).toBe(0);
    expect(readFileSync(join(dir, name), 'utf8')).toBe(bytes);
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });

  it('snaps to the previous complete month by default and flags the current month partial', async () => {
    const repo = makeTempDir('sr-bench-repo-');
    mkdirSync(join(repo, '.git'));
    const byDefault = await runBench(['bench', '--publish', '--home-dir', '/home/u'], { cwd: repo });
    expect(byDefault.code).toBe(0);
    const defaultFile = readdirSync(join(repo, '.showreceipts')).find((n) => n.startsWith('2026-07-'));
    expect(defaultFile).toBeDefined();
    const defaultPayload = JSON.parse(readFileSync(join(repo, '.showreceipts', defaultFile as string), 'utf8')) as PublishPayload;
    expect(defaultPayload.period).toEqual({ from: '2026-07', to: '2026-07', partial: false });

    const current = await runBench(['bench', '--month', '2026-08', '--publish', '--home-dir', '/home/u'], { cwd: repo });
    expect(current.code).toBe(0);
    const currentFile = readdirSync(join(repo, '.showreceipts')).find((n) => n.startsWith('2026-08-'));
    const currentPayload = JSON.parse(readFileSync(join(repo, '.showreceipts', currentFile as string), 'utf8')) as PublishPayload;
    expect(currentPayload.period.partial).toBe(true);
  });

  it('--publish FILE writes to the named file; outside a repo the default is ~/.showreceipts/publish/', async () => {
    const cwd = makeTempDir('sr-bench-norepo-');
    const named = await runBench(['bench', '--month', '2026-02', '--publish', 'out.json', '--home-dir', '/home/u'], { cwd });
    expect(named.code).toBe(0);
    expect(existsSync(join(cwd, 'out.json'))).toBe(true);

    const bare = await runBench(['bench', '--month', '2026-02', '--publish', '--home-dir', '/home/u'], { cwd });
    expect(bare.code).toBe(0);
    const publishDir = join(srHome, 'publish');
    expect(readdirSync(publishDir).some((n) => /^2026-02-[0-9a-f]{16}\.json$/.test(n))).toBe(true);
  });
});

describe('bench --help (§12.4)', () => {
  it('prints the section and exits 0', async () => {
    const stdout = sink();
    const code = await main(['bench', '--help'], { stdout, stderr: sink(), env: { HOME: '/tmp' }, cwd: '/tmp', now: NOW });
    expect(code).toBe(0);
    expect(stdout.text.startsWith('showreceipts bench — ')).toBe(true);
    expect(stdout.text).toContain('--publish');
    expect(stdout.text).toContain('Nothing leaves this machine.');
  });
});
