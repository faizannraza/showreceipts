/**
 * Closing-review hardening regressions (Pass 1), spawned against dist:
 *
 *  - a `transcript_path` naming a FIFO must not hang the hook (open(2) on a
 *    writer-less FIFO blocks in the kernel, so the in-process watchdog can
 *    never fire — the stat guard answers `{}` immediately);
 *  - a repository shipping `.showreceipts` as a symlink must not redirect
 *    receipt or report writes (SECURITY.md's first in-scope bullet);
 *  - a malformed SHOWRECEIPTS_NOW must not silently disable recording.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/hooks/', import.meta.url));
const NOW = ['--now', '2026-08-29T12:00:00Z'];

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const onPosix = process.platform !== 'win32';

describe.runIf(onPosix)('FIFO transcript paths never hang the hook (§9 self-timeout)', () => {
  function mkfifo(path: string): boolean {
    return spawnSync('mkfifo', [path]).status === 0;
  }

  it('claude-code Stop with a FIFO transcript answers {} immediately', () => {
    const dir = tempDir('showreceipts-fifo-');
    const fifo = join(dir, 'f');
    if (!mkfifo(fifo)) return; // no mkfifo on this machine — nothing to test
    const payload = JSON.stringify({
      session_id: 'h-1',
      hook_event_name: 'Stop',
      transcript_path: fifo,
      cwd: dir,
      last_assistant_message: 'done',
    });
    const r = runCli(['hook', 'claude-code', 'Stop', ...NOW], { env: { SHOWRECEIPTS_HOME: join(dir, 'sr') }, stdin: payload, timeoutMs: 15_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(r.ms).toBeLessThan(10_000);
  });

  it('copilot agentStop with a FIFO transcript answers fast', () => {
    const dir = tempDir('showreceipts-fifo-cp-');
    const fifo = join(dir, 'f');
    if (!mkfifo(fifo)) return;
    const payload = JSON.stringify({ sessionId: 'cp-1', transcriptPath: fifo, stopReason: 'done' });
    const r = runCli(['hook', 'copilot', 'agentStop', ...NOW], { env: { SHOWRECEIPTS_HOME: join(dir, 'sr') }, stdin: payload, timeoutMs: 15_000 });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout) as unknown).not.toThrow();
    expect(r.ms).toBeLessThan(10_000);
  });
});

describe.runIf(onPosix)('a symlinked .showreceipts never receives writes (SECURITY.md)', () => {
  function hostileRepo(): { repo: string; victim: string; srHome: string } {
    const dir = tempDir('showreceipts-symlink-');
    const repo = join(dir, 'repo');
    const victim = join(dir, 'victim');
    const srHome = join(dir, 'sr');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(victim, { recursive: true });
    mkdirSync(srHome, { recursive: true });
    symlinkSync(victim, join(repo, '.showreceipts'));
    return { repo, victim, srHome };
  }

  it('the Stop receipt falls back to the home location', () => {
    const { repo, victim, srHome } = hostileRepo();
    const transcript = join(repo, 't.jsonl');
    copyFileSync(join(FIXTURES, 'claude-code', 'Stop', 'transcript.jsonl'), transcript);
    const payload = JSON.stringify({
      session_id: 'ab12cd34-1111-4222-8333-444455556666',
      prompt_id: 'p1',
      transcript_path: transcript,
      cwd: repo,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Tests pass.',
    });
    const r = runCli(['hook', 'claude-code', 'Stop', ...NOW], { env: { SHOWRECEIPTS_HOME: srHome }, stdin: payload, cwd: repo });
    expect(r.code).toBe(0);
    expect(readdirSync(victim)).toEqual([]);
    expect(existsSync(join(srHome, 'last', 'claude-code', 'last-receipt.md'))).toBe(true);
  });

  it('report refuses its default location through the symlink (exit 1, --out exempt)', () => {
    const { repo, victim, srHome } = hostileRepo();
    const empty = tempDir('showreceipts-symlink-roots-');
    mkdirSync(join(empty, 'claude'), { recursive: true });
    mkdirSync(join(empty, 'codex'), { recursive: true });
    const env = { SHOWRECEIPTS_HOME: srHome, CLAUDE_CONFIG_DIR: join(empty, 'claude'), CODEX_HOME: join(empty, 'codex'), HOME: empty, USERPROFILE: empty };
    const r = runCli(['report', '--since', '2026-01-01', '--no-color'], { env, cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not a real directory');
    expect(readdirSync(victim)).toEqual([]);
    const out = join(empty, 'explicit.html');
    const ok = runCli(['report', '--since', '2026-01-01', '--no-color', '--out', out], { env, cwd: repo });
    expect(ok.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});

describe('a malformed SHOWRECEIPTS_NOW no longer disables recording', () => {
  it('cursor postToolUse still appends its ledger line', () => {
    const dir = tempDir('showreceipts-badnow-');
    const srHome = join(dir, 'sr');
    const stdin = readFileSync(join(FIXTURES, 'cursor', 'postToolUse', 'stdin.json'), 'utf8');
    const r = runCli(['hook', 'cursor', 'postToolUse'], { env: { SHOWRECEIPTS_HOME: srHome, SHOWRECEIPTS_NOW: 'not-a-date' }, stdin });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    const ledger = join(srHome, 'ledger', 'cursor', 'cp-1.jsonl');
    expect(existsSync(ledger)).toBe(true);
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { t?: string; e?: string };
    expect(parsed.e).toBe('tool-post');
    expect(Number.isNaN(Date.parse(parsed.t ?? ''))).toBe(false);
  });
});
