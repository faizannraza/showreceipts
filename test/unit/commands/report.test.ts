/**
 * S25 — `commands/report.ts`: the report file over the real fixture tree
 * (S22 structural self-check), `--json` against the schema, `--bench`
 * (sizes without writing), the git-root default `--out`, `--hash-paths`
 * modes and the injected-spawner `--open` seam (nothing ever spawns here).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReportPayload } from '../../../src/model/types.js';
import { parse } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { main } from '../../../src/cli.js';
import { openCommandFor, openReport, run, type Spawner } from '../../../src/commands/report.js';
import { selfCheck } from '../../../src/render/html.js';
import { materializeAll } from '../../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../../helpers/schema.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const doc = loadSchemaDoc();
const tree = makeTempDir('sr-report-tree-');
const fixtures = materializeAll(tree);

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

async function runReport(argv: string[], opts: { cwd?: string; srHome?: string } = {}): Promise<RunResult> {
  const home = makeTempDir('sr-report-home-');
  const stdout = sink();
  const stderr = sink();
  const ctx = createContext(parse(argv), {
    stdout,
    stderr,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: fixtures.claudeConfigDir,
      CODEX_HOME: fixtures.codexHome,
      SHOWRECEIPTS_HOME: opts.srHome ?? makeTempDir('sr-report-srhome-'),
    },
    cwd: opts.cwd ?? makeTempDir('sr-report-cwd-'),
    now: NOW,
    isTTY: false,
  });
  const code = await run(ctx);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

// `report` renders no width-fitted screen (§12.1: no --width), but accepts
// --ascii/--unicode to pin its status-line glyphs (Pass 2 determinism).
// `--all`: the legacy fixture ends 2025-09-01, outside any 2026 window.
const BASE = ['report', '--all', '--home-dir', '/home/u', '--no-color'];

/** The `#data` block of an emitted document, parsed. */
function dataOf(html: string): { mode: string; payload: ReportPayload; hashed?: ReportPayload } {
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse((m as RegExpExecArray)[1] as string) as { mode: string; payload: ReportPayload; hashed?: ReportPayload };
}

describe('report over the fixture tree', () => {
  it('writes a self-consistent single-file report and prints the section sizes', async () => {
    const out = join(makeTempDir('sr-report-out-'), 'r.html');
    const r = await runReport([...BASE, '--out', out]);
    expect(r.code).toBe(0);
    const html = readFileSync(out, 'utf8');
    const check = selfCheck(html);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    const data = dataOf(html);
    expect(data.mode).toBe('clear');
    expect(data.payload.sessions.length).toBe(10); // DoD: Claude Code 7 · Codex 3
    expect(Object.keys(data.payload.receipts).length).toBe(10);
    for (const word of ['report', 'cards', 'receipts', 'timelines', 'template']) expect(r.stdout).toContain(word);
    expect(r.stdout).not.toContain(tree); // never the real fixture path
  });

  it('--json validates against the schema and matches the written file', async () => {
    const out = join(makeTempDir('sr-report-out-'), 'r.html');
    const r = await runReport([...BASE, '--out', out, '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(validateAgainst(doc, 'report', parsed)).toEqual([]);
    expect(parsed['out']).toBe(out);
    expect(parsed['bytes']).toBe(statSync(out).size);
    expect(parsed['sessions']).toBe(10);
    expect(parsed['hiddenRows']).toBe(0);
    const sections = parsed['bytesBySection'] as Record<string, number>;
    expect(Object.keys(sections).sort()).toEqual(['cards', 'receipts', 'template', 'timelines']);
    const html = readFileSync(out, 'utf8');
    const dataBytes = Buffer.byteLength(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '', 'utf8');
    expect((sections['template'] as number) + dataBytes).toBe(statSync(out).size);
    // Nothing but the JSON line on stdout.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('--bench prints the payload sizes and card count without writing', async () => {
    const cwd = makeTempDir('sr-report-bench-');
    const r = await runReport([...BASE, '--bench'], { cwd });
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, '.showreceipts', 'report.html'))).toBe(false);
    expect(r.stdout).toContain('report --bench');
    expect(r.stdout).toContain('10 session card(s)');
    for (const word of ['cards', 'receipts', 'timelines', 'template']) expect(r.stdout).toContain(word);
  });

  it('--bench sizes match the sizes of an actual write', async () => {
    const srHome = makeTempDir('sr-report-srhome-');
    const out = join(makeTempDir('sr-report-out-'), 'r.html');
    const bench = await runReport([...BASE, '--bench'], { srHome });
    const json = await runReport([...BASE, '--out', out, '--json'], { srHome });
    const sections = (JSON.parse(json.stdout) as { bytesBySection: Record<string, number> }).bytesBySection;
    const fmt = (bytes: number): string =>
      bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    for (const key of ['cards', 'receipts', 'timelines', 'template'] as const) {
      expect(bench.stdout).toContain(`${key} ${fmt(sections[key] as number)}`);
    }
  });

  it('default --out lands under the git root when cwd is a repo subdirectory', async () => {
    const repo = makeTempDir('sr-report-repo-');
    mkdirSync(join(repo, '.git'));
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const r = await runReport([...BASE], { cwd: sub });
    expect(r.code).toBe(0);
    expect(existsSync(join(repo, '.showreceipts', 'report.html'))).toBe(true);
    expect(existsSync(join(sub, '.showreceipts'))).toBe(false);
  });

  it('--hash-paths and --hash-paths=both switch the data-block mode', async () => {
    const dir = makeTempDir('sr-report-out-');
    const on = await runReport([...BASE, '--out', join(dir, 'on.html'), '--hash-paths']);
    expect(on.code).toBe(0);
    const onData = dataOf(readFileSync(join(dir, 'on.html'), 'utf8'));
    expect(onData.mode).toBe('hashed');
    expect(onData.payload.meta.hashPaths).toBe(true);

    const both = await runReport([...BASE, '--out', join(dir, 'both.html'), '--hash-paths=both']);
    expect(both.code).toBe(0);
    const bothData = dataOf(readFileSync(join(dir, 'both.html'), 'utf8'));
    expect(bothData.mode).toBe('both');
    expect(bothData.hashed).toBeDefined();
    expect(bothData.payload.meta.hashPaths).toBe(false);
    expect(bothData.hashed?.meta.hashPaths).toBe(true);
  });
});

describe('failure and empty-state messages (Pass 3)', () => {
  it('a nonexistent --out parent fails with a friendly message, not a raw errno', async () => {
    await expect(runReport([...BASE, '--out', '/nonexistent-showreceipts-xyz/r.html'])).rejects.toThrow(
      /report: cannot write \/nonexistent-showreceipts-xyz\/r\.html — /,
    );
  });

  it('with no sessions found the human output points at demo', async () => {
    const home = makeTempDir('sr-report-empty-');
    const stdout = sink();
    const stderr = sink();
    const out = join(makeTempDir('sr-report-out-'), 'r.html');
    const ctx = createContext(parse(['report', '--all', '--no-color', '--unicode', '--out', out]), {
      stdout,
      stderr,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, 'no-claude'),
        CODEX_HOME: join(home, 'no-codex'),
        SHOWRECEIPTS_HOME: join(home, 'sr'),
      },
      cwd: makeTempDir('sr-report-empty-cwd-'),
      now: NOW,
      isTTY: false,
    });
    const code = await run(ctx);
    expect(code).toBe(0);
    expect(stdout.text).toContain('0 session(s)');
    expect(stdout.text).toContain("no sessions found · try 'showreceipts demo' for sample receipts");
  });
});

describe('--open (injected spawner; §13.4 — never spawns in tests)', () => {
  it('builds the platform argv arrays', () => {
    expect(openCommandFor('darwin', '/x/r.html')).toEqual({ command: 'open', args: ['/x/r.html'] });
    expect(openCommandFor('linux', '/x/r.html')).toEqual({ command: 'xdg-open', args: ['/x/r.html'] });
    expect(openCommandFor('win32', 'C:\\x\\r.html')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'C:\\x\\r.html'] });
  });

  it('spawns detached with ignored stdio and unrefs the child', () => {
    const calls: { command: string; args: readonly string[]; options: { detached: true; stdio: 'ignore' } }[] = [];
    let unrefs = 0;
    const fake: Spawner = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        unref(): void {
          unrefs += 1;
        },
      };
    };
    openReport('/tmp/r.html', 'darwin', fake);
    expect(calls).toEqual([{ command: 'open', args: ['/tmp/r.html'], options: { detached: true, stdio: 'ignore' } }]);
    expect(unrefs).toBe(1);
  });

  it('a missing opener (async ENOENT) becomes a stderr hint, never an unhandled error', async () => {
    // xdg-open is routinely absent on minimal Linux: spawn() delivers ENOENT
    // asynchronously on the child, after run() returned — pre-fix this was an
    // uncaught 'error' event and a raw stack trace (exit 1).
    let listener: ((err: Error) => void) | undefined;
    let unrefs = 0;
    const fake: Spawner = () => ({
      unref(): void {
        unrefs += 1;
      },
      on(_event: 'error', l: (err: Error) => void): void {
        listener = l;
      },
    });
    const messages: string[] = [];
    openReport('/x/r.html', 'linux', fake, (m) => messages.push(m));
    expect(unrefs).toBe(1);
    expect(listener).toBeDefined();
    // The error arrives on a later tick, well after openReport returned.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    (listener as (err: Error) => void)(new Error('spawn xdg-open ENOENT'));
    expect(messages).toEqual(['showreceipts: could not open a browser (xdg-open missing or failed to start); open /x/r.html yourself\n']);
  });

  it('a handle without `on` (plain fake spawner) is tolerated', () => {
    let unrefs = 0;
    const fake: Spawner = () => ({
      unref(): void {
        unrefs += 1;
      },
    });
    expect(() => {
      openReport('/x/r.html', 'linux', fake, () => undefined);
    }).not.toThrow();
    expect(unrefs).toBe(1);
  });
});

describe('report --help (§12.4)', () => {
  it('prints the section and exits 0 with nothing else on stdout', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await main(['report', '--help'], { stdout, stderr, env: { HOME: '/tmp' }, cwd: '/tmp', now: NOW });
    expect(code).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text.startsWith('showreceipts report — ')).toBe(true);
    expect(stdout.text).toContain('Usage: showreceipts report');
    expect(stdout.text).toContain('--hash-paths');
    expect(stdout.text).toContain('Nothing leaves this machine.');
  });
});
