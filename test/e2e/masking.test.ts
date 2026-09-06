/**
 * Closing-review blocker regression (Pass 1, §4.9 / SECURITY.md): the COLD
 * path (first run, and --no-cache) used to embed transcript secrets verbatim
 * in `report` and `export --json` — masking only happened as a side effect of
 * a warm cache. Masking now applies at the parse seam, so:
 *
 *  - a fresh SHOWRECEIPTS_HOME run leaks nothing into report.html or either
 *    export shape;
 *  - --no-cache leaks nothing;
 *  - cold and warm `export --json` are byte-identical.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const SID = '77777777-7777-4777-8777-777777777777';
const SECRETS = ['SECRETVALUE123456', 'sk-abcdefghijklmnopqrstuvwxyz123456', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234'];

const tree = makeTempDir('showreceipts-e2e-masking-');
const claude = join(tree, 'claude');
const proj = join(claude, 'projects', '-home-u-proj');
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
mkdirSync(proj, { recursive: true });
for (const d of [home, cwd, join(tree, 'codex')]) mkdirSync(d, { recursive: true });

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

function writeHostileTranscript(): void {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50, service_tier: 'standard' };
  const base = { isSidechain: false, userType: 'external', cwd: '/home/u/proj', sessionId: SID, version: '2.1.251', gitBranch: 'main' };
  let n = 0;
  let prev: string | null = null;
  const lines: string[] = [];
  const push = (rec: Record<string, unknown>): void => {
    const uuid = `77777777-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    lines.push(
      JSON.stringify({ parentUuid: prev, ...base, ...rec, uuid, timestamp: new Date(Date.parse('2026-03-01T17:00:00Z') + n * 20000).toISOString() }),
    );
    prev = uuid;
  };
  push({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'Please deploy.' } });
  push({
    type: 'assistant',
    requestId: 'req_1',
    message: {
      model: 'claude-sonnet-4-5',
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: `curl -H 'x: token=${SECRETS[0]}' https://x.test`, description: 'deploy' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage,
    },
  });
  push({
    type: 'user',
    promptId: 'p1',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'ok', is_error: false }] },
    toolUseResult: { stdout: 'ok', stderr: '', interrupted: false, isImage: false },
  });
  push({
    type: 'assistant',
    requestId: 'req_2',
    message: {
      model: 'claude-sonnet-4-5',
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: `Deployed with token=${SECRETS[0]} key ${SECRETS[1]} ${SECRETS[2]}. All done.` }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    },
  });
  writeFileSync(join(proj, `${SID}.jsonl`), lines.join('\n') + '\n');
}
writeHostileTranscript();

const COMMON = ['--since', '2026-01-01', '--width', '100', '--no-color', '--tz', 'utc', '--home-dir', '/home/u'];

function envFor(srHome: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(tree, 'codex'), SHOWRECEIPTS_HOME: srHome };
}

function expectNoSecrets(text: string, what: string): void {
  for (const secret of SECRETS) {
    expect(text, `${what} must not contain ${secret.slice(0, 12)}…`).not.toContain(secret);
  }
}

describe('cold-path masking (fresh cache)', () => {
  it('export --json leaks nothing cold and is byte-identical warm', () => {
    const srHome = join(tree, 'sr-cold-warm');
    mkdirSync(srHome, { recursive: true });
    const cold = runCli(['export', SID, '--json', ...COMMON], { env: envFor(srHome), cwd });
    expect(cold.code).toBe(0);
    expectNoSecrets(cold.stdout, 'cold export --json');
    expect(cold.stdout).toContain('«masked»');
    const warm = runCli(['export', SID, '--json', ...COMMON], { env: envFor(srHome), cwd });
    expect(warm.code).toBe(0);
    expect(warm.stdout).toBe(cold.stdout);
  });

  it('export --md and --no-cache leak nothing', () => {
    const srHome = join(tree, 'sr-md');
    mkdirSync(srHome, { recursive: true });
    const md = runCli(['export', SID, '--md', '--no-cache', ...COMMON], { env: envFor(srHome), cwd });
    expect(md.code).toBe(0);
    expectNoSecrets(md.stdout, 'export --md --no-cache');
    const json = runCli(['export', SID, '--json', '--no-cache', ...COMMON], { env: envFor(srHome), cwd });
    expectNoSecrets(json.stdout, 'export --json --no-cache');
  });

  it('the first-run HTML report leaks nothing', () => {
    const srHome = join(tree, 'sr-report');
    mkdirSync(srHome, { recursive: true });
    const out = join(tree, 'report.html');
    const r = runCli(['report', '--out', out, '--since', '2026-01-01', '--no-color'], { env: envFor(srHome), cwd });
    expect(r.code).toBe(0);
    expectNoSecrets(readFileSync(out, 'utf8'), 'cold report.html');
  });
});
