/**
 * S25 — `commands/doctor.ts` + `doctor/{collect,problems}.ts`: exit 0 with
 * warnings only over the healthy fixture tree; exit 4 for each
 * `fixtures/doctor/broken-*` core-shape tree, an unreadable root, corrupt
 * cache entries and Node < 20 (injected); `--json` against the schema;
 * `--clear-cache` and `--prune-ledgers` acting exactly as asked; tolerant
 * `counters.json` reads.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorHookReport, DoctorReport } from '../../../src/model/types.js';
import { parse } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { main } from '../../../src/cli.js';
import { CLEANUP_NOTE, run } from '../../../src/commands/doctor.js';
import { collectDoctorReport, scanCorruptCache } from '../../../src/doctor/collect.js';
import { envProblems, nodeMajorOf } from '../../../src/doctor/problems.js';
import { resolveRoots } from '../../../src/discover/roots.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { materializeAll } from '../../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../../helpers/schema.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const doc = loadSchemaDoc();
const DOCTOR_FIXTURES = fileURLToPath(new URL('../../../fixtures/doctor/', import.meta.url));

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

interface Env {
  claude?: string;
  codex?: string;
  srHome?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  report: DoctorReport | undefined;
}

async function runDoctor(argv: string[], env: Env = {}): Promise<RunResult> {
  const home = makeTempDir('sr-doctor-home-');
  const stdout = sink();
  const stderr = sink();
  const ctx = createContext(parse(argv), {
    stdout,
    stderr,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: env.claude ?? join(home, 'no-claude'),
      CODEX_HOME: env.codex ?? join(home, 'no-codex'),
      SHOWRECEIPTS_HOME: env.srHome ?? makeTempDir('sr-doctor-srhome-'),
    },
    cwd: makeTempDir('sr-doctor-cwd-'),
    now: NOW,
    isTTY: false,
  });
  const code = await run(ctx);
  let report: DoctorReport | undefined;
  if (argv.includes('--json')) {
    try {
      report = JSON.parse(stdout.text) as DoctorReport;
    } catch {
      report = undefined;
    }
  }
  return { code, stdout: stdout.text, stderr: stderr.text, report };
}

const JSON_ARGV = ['doctor', '--json', '--home-dir', '/home/u'];

describe('doctor over the healthy fixture tree', () => {
  it('exits 0 with warnings only and validates against the schema', async () => {
    const tree = makeTempDir('sr-doctor-tree-');
    const fixtures = materializeAll(tree);
    const r = await runDoctor(JSON_ARGV, { claude: fixtures.claudeConfigDir, codex: fixtures.codexHome });
    expect(r.code).toBe(0);
    expect(r.report).toBeDefined();
    const report = r.report as DoctorReport;
    expect(validateAgainst(doc, 'doctor', report)).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
    const claude = report.harnesses.find((h) => h.harness === 'claude-code');
    const codex = report.harnesses.find((h) => h.harness === 'codex');
    expect(claude?.found).toBe(true);
    expect(claude?.sessions).toBe(7);
    expect(claude?.bytes).toBeGreaterThan(0);
    expect(claude?.versions.length).toBeGreaterThan(0);
    expect(codex?.found).toBe(true);
    expect(codex?.sessions).toBe(3);
    expect(report.ledgers).toEqual({ sessions: 0, partial: 0, gaps: 0, stdinOverflow: 0, stopBudgetExceeded: 0, copilotTranscriptUnparsed: 0 });
  });

  it('renders text, exits 0 on empty roots, and prints the durability note', async () => {
    const r = await runDoctor(['doctor', '--width', '80', '--no-color', '--ascii', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    for (const section of ['roots', 'harnesses', 'hooks', 'ledgers', 'prices', 'cache']) expect(r.stdout).toContain(section);
    // The durability note word-wraps to the width budget (Pass 3), so pin
    // its content rather than the single-line literal.
    expect(r.stdout).toContain('cleanupPeriodDays');
    expect(r.stdout).toContain('durable record');
    expect(r.stdout.replace(/\n/g, ' ')).toContain(CLEANUP_NOTE.slice(0, 60));
  });
});

describe('exit 4: the §12.2 core-shape fixtures', () => {
  const cases: { name: string; env: Env; problem: RegExp }[] = [
    { name: 'broken-bash', env: { claude: join(DOCTOR_FIXTURES, 'broken-bash', 'claude') }, problem: /Bash toolUseResult/ },
    { name: 'broken-edit', env: { claude: join(DOCTOR_FIXTURES, 'broken-edit', 'claude') }, problem: /Edit\/Write toolUseResult .* without filePath/ },
    { name: 'broken-assistant', env: { claude: join(DOCTOR_FIXTURES, 'broken-assistant', 'claude') }, problem: /assistant line.* without message\.model/ },
    { name: 'broken-codex-output', env: { codex: join(DOCTOR_FIXTURES, 'broken-codex-output', 'codex') }, problem: /unparseable Codex function_call_output header/ },
  ];
  for (const { name, env, problem } of cases) {
    it(`${name} exits 4 naming the problem`, async () => {
      const r = await runDoctor(JSON_ARGV, env);
      expect(r.code).toBe(4);
      const problems = (r.report as DoctorReport).problems;
      expect(problems.some((p) => problem.test(p)), problems.join(' | ')).toBe(true);
    });
  }

  it('a corrupt cache entry exits 4', async () => {
    const srHome = makeTempDir('sr-doctor-srhome-');
    mkdirSync(join(srHome, 'cache'), { recursive: true });
    const name = `${'0'.repeat(64)}.json`;
    copyFileSync(join(DOCTOR_FIXTURES, 'broken-cache', 'cache', name), join(srHome, 'cache', name));
    const r = await runDoctor(JSON_ARGV, { srHome });
    expect(r.code).toBe(4);
    expect((r.report as DoctorReport).problems.some((p) => p.includes('corrupt cache: 1 entry'))).toBe(true);
  });
});

describe('exit 4: environment problems', () => {
  const canChmod = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const chmodIt = canChmod ? it : it.skip;
  const locked: string[] = [];
  afterAll(() => {
    for (const dir of locked) chmodSync(dir, 0o700);
  });

  chmodIt('an unreadable root exits 4', async () => {
    const claude = makeTempDir('sr-doctor-locked-');
    chmodSync(claude, 0o000);
    locked.push(claude);
    const r = await runDoctor(JSON_ARGV, { claude });
    expect(r.code).toBe(4);
    expect((r.report as DoctorReport).problems.some((p) => p.startsWith(`unreadable root: ${claude}`))).toBe(true);
  });

  it('injected versions.node below 20 is a problem (collect seam)', async () => {
    const home = makeTempDir('sr-doctor-home-');
    const roots = resolveRoots({ SHOWRECEIPTS_HOME: join(home, 'sr') }, home);
    const report = await collectDoctorReport({
      roots,
      homeDir: '/home/u',
      prices: loadPriceTable(),
      priceNotes: [],
      toolVersion: 'test-tool',
      now: NOW,
      noCache: true,
      hooks: [],
      seams: { nodeVersion: '18.20.0' },
    });
    expect(report.problems).toEqual(['node 18.20.0 is below the supported minimum (>= 20)']);
    expect(report.node.version).toBe('18.20.0');
  });

  it('nodeMajorOf parses both spellings', () => {
    expect(nodeMajorOf('v26.0.0')).toBe(26);
    expect(nodeMajorOf('18.20.0')).toBe(18);
    expect(nodeMajorOf('nonsense')).toBe(0);
  });

  it('disableAllHooks masking and an unresolvable launcher are problems', () => {
    const row = (over: Partial<DoctorHookReport>): DoctorHookReport => ({
      harness: 'claude-code',
      scope: 'user',
      configPath: '/home/u/.claude/settings.json',
      installed: true,
      command: '"/home/u/.showreceipts/bin/showreceipts-hook" hook claude-code Stop',
      resolvable: true,
      resolvableNote: 'static check; the harness process PATH may differ',
      disabled: false,
      otherStopHooks: [],
      strict: false,
      trusted: true,
      ...over,
    });
    const base = { nodeVersion: 'v26.0.0', unreadableRoots: [], corruptCacheEntries: 0 };
    expect(envProblems({ ...base, hooks: [row({})] })).toEqual([]);
    expect(envProblems({ ...base, hooks: [row({ disabled: true })] })[0]).toContain('disableAllHooks is true');
    expect(envProblems({ ...base, hooks: [row({ resolvable: false })] })[0]).toContain('launcher unresolvable');
    // Not installed ⇒ neither fires (§12.2: masking *installed* hooks only).
    expect(envProblems({ ...base, hooks: [row({ installed: false, disabled: true, resolvable: false })] })).toEqual([]);
  });
});

describe('counters.json (S02 HookCounters contract)', () => {
  it('a missing file yields zeros, not a problem', async () => {
    const r = await runDoctor(JSON_ARGV);
    expect(r.code).toBe(0);
    expect((r.report as DoctorReport).ledgers.stdinOverflow).toBe(0);
  });

  it('values surface; missing keys stay 0', async () => {
    const srHome = makeTempDir('sr-doctor-srhome-');
    mkdirSync(join(srHome, 'state'), { recursive: true });
    writeFileSync(join(srHome, 'state', 'counters.json'), JSON.stringify({ stdinOverflow: 3, stopBudgetExceeded: 1 }));
    const r = await runDoctor(JSON_ARGV, { srHome });
    expect(r.code).toBe(0);
    const ledgers = (r.report as DoctorReport).ledgers;
    expect(ledgers.stdinOverflow).toBe(3);
    expect(ledgers.stopBudgetExceeded).toBe(1);
    expect(ledgers.copilotTranscriptUnparsed).toBe(0);
  });

  it('a malformed counters.json is tolerated', async () => {
    const srHome = makeTempDir('sr-doctor-srhome-');
    mkdirSync(join(srHome, 'state'), { recursive: true });
    writeFileSync(join(srHome, 'state', 'counters.json'), 'not json');
    const r = await runDoctor(JSON_ARGV, { srHome });
    expect(r.code).toBe(0);
    expect((r.report as DoctorReport).ledgers.stdinOverflow).toBe(0);
  });
});

describe('--clear-cache and --prune-ledgers', () => {
  it('--clear-cache empties only cache/ and never touches ledgers', async () => {
    const srHome = makeTempDir('sr-doctor-srhome-');
    mkdirSync(join(srHome, 'cache'), { recursive: true });
    writeFileSync(join(srHome, 'cache', `${'a'.repeat(64)}.json`), '{}');
    mkdirSync(join(srHome, 'ledger', 'cursor'), { recursive: true });
    writeFileSync(join(srHome, 'ledger', 'cursor', 'sid.jsonl'), '');
    const r = await runDoctor(['doctor', '--clear-cache', '--home-dir', '/home/u'], { srHome });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('cache cleared');
    expect(readdirSync(join(srHome, 'cache'))).toEqual([]);
    expect(existsSync(join(srHome, 'ledger', 'cursor', 'sid.jsonl'))).toBe(true);
  });

  it('--prune-ledgers removes old ledgers only when asked', async () => {
    const srHome = makeTempDir('sr-doctor-srhome-');
    const dir = join(srHome, 'ledger', 'cursor');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'old.jsonl');
    const fresh = join(dir, 'fresh.jsonl');
    writeFileSync(old, '');
    writeFileSync(fresh, '');
    utimesSync(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(fresh, new Date('2026-08-28T00:00:00Z'), new Date('2026-08-28T00:00:00Z'));

    // Without the flag nothing is pruned.
    const plain = await runDoctor(['doctor', '--home-dir', '/home/u'], { srHome });
    expect(plain.code).toBe(0);
    expect(existsSync(old)).toBe(true);

    const pruned = await runDoctor(['doctor', '--prune-ledgers', '30', '--home-dir', '/home/u'], { srHome });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain('pruned 1 ledger file(s)');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);

    // --prune-ledgers 0: everything strictly older than now.
    const zero = await runDoctor(['doctor', '--prune-ledgers', '0', '--home-dir', '/home/u'], { srHome });
    expect(zero.code).toBe(0);
    expect(existsSync(fresh)).toBe(false);
  });
});

describe('corrupt-cache static scan', () => {
  it('counts only broken entry files and tolerates a missing directory', () => {
    const dir = makeTempDir('sr-doctor-cache-');
    writeFileSync(join(dir, `${'b'.repeat(64)}.json`), 'garbage');
    writeFileSync(join(dir, `${'c'.repeat(64)}.json`), JSON.stringify({ v: 1, key: 'c'.repeat(64) }));
    writeFileSync(join(dir, 'index.json'), 'garbage'); // not an entry file
    const list = (p: string): string[] => readdirSync(p);
    expect(scanCorruptCache(dir, list)).toBe(1);
    expect(scanCorruptCache(join(dir, 'missing'), list)).toBe(0);
  });
});

describe('doctor --help (§12.4)', () => {
  it('prints the section and exits 0', async () => {
    const stdout = sink();
    const code = await main(['doctor', '--help'], { stdout, stderr: sink(), env: { HOME: '/tmp' }, cwd: '/tmp', now: NOW });
    expect(code).toBe(0);
    expect(stdout.text.startsWith('showreceipts doctor — ')).toBe(true);
    expect(stdout.text).toContain('--prune-ledgers');
    expect(stdout.text).toContain('Nothing leaves this machine.');
  });
});
