/**
 * S30 e2e — fresh installs per harness: `node dist/cli.js setup` in a temp
 * HOME writes the exact §9 config bytes (fixtures/setup/<harness>/
 * expected-fresh.*, `__H__` substituted with the launcher path), is
 * idempotent, writes the 0600 sidecar, and `--json` validates against the
 * schema.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { SetupResult } from '../../src/model/types.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/setup/', import.meta.url));
const doc = loadSchemaDoc();

interface Home {
  root: string;
  home: string;
  sr: string;
  launcher: string;
  env: Record<string, string>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): Home {
  const root = makeTempDir('sr-setup-fresh-');
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const sr = join(home, '.showreceipts');
  return {
    root,
    home,
    sr,
    launcher: join(sr, 'bin', 'showreceipts-hook'),
    env: {
      HOME: home,
      USERPROFILE: home,
      SHOWRECEIPTS_HOME: sr,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    },
  };
}

const CASES: { harness: string; fixture: string; config: (h: Home) => string }[] = [
  { harness: 'claude-code', fixture: 'claude-code/expected-fresh.json', config: (h) => join(h.home, '.claude', 'settings.json') },
  { harness: 'codex', fixture: 'codex/expected-fresh.json', config: (h) => join(h.home, '.codex', 'hooks.json') },
  { harness: 'cursor', fixture: 'cursor/expected-fresh.json', config: (h) => join(h.home, '.cursor', 'hooks.json') },
  { harness: 'gemini', fixture: 'gemini/expected-fresh.json', config: (h) => join(h.home, '.gemini', 'settings.json') },
  { harness: 'copilot', fixture: 'copilot/expected-fresh.json', config: (h) => join(h.home, '.copilot', 'hooks', 'showreceipts.json') },
  { harness: 'hermes', fixture: 'hermes/expected-fresh.yaml', config: (h) => join(h.home, '.hermes', 'config.yaml') },
  { harness: 'dsh', fixture: 'dsh/expected-fresh.json', config: (h) => join(h.home, '.claude', 'settings.json') },
];

describe('setup — fresh install per harness (§9 exact bytes)', () => {
  for (const c of CASES) {
    it(`${c.harness}: writes the exact expected config`, () => {
      const h = makeHome();
      const r = runCli(['setup', '--harness', c.harness], { env: h.env, cwd: h.root });
      expect(r.code).toBe(0);
      const expected = readFileSync(join(FIXTURES, c.fixture), 'utf8').replaceAll('__H__', h.launcher);
      expect(readFileSync(c.config(h), 'utf8')).toBe(expected);
    });
  }
});

describe('setup — idempotency and the launcher sidecar', () => {
  it('second run is unchanged: byte-identical config, no backup ever written', () => {
    const h = makeHome();
    expect(runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root }).code).toBe(0);
    const config = join(h.home, '.claude', 'settings.json');
    const before = readFileSync(config, 'utf8');
    const r = runCli(['setup', '--harness', 'claude-code', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results[0]?.action).toBe('unchanged');
    expect(results[0]?.backup).toBeNull();
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(existsSync(join(h.sr, 'backups'))).toBe(false);
  });

  it('--strict updates the Stop command and adds SessionStart; a third run is unchanged', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    const r = runCli(['setup', '--harness', 'claude-code', '--strict', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results[0]?.action).toBe('updated');
    expect(results[0]?.diff).toContain('SessionStart');
    const text = readFileSync(join(h.home, '.claude', 'settings.json'), 'utf8');
    expect(text).toContain('hook claude-code Stop --strict');
    expect(text).toContain('startup|resume');
    const again = JSON.parse(
      runCli(['setup', '--harness', 'claude-code', '--strict', '--json'], { env: h.env, cwd: h.root }).stdout,
    ) as SetupResult[];
    expect(again[0]?.action).toBe('unchanged');
  });

  it('writes the 0600 sidecar whose node/cli/launcher paths resolve (S23c contract)', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    const sidecarPath = join(h.sr, 'bin', 'launcher.json');
    expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, string>;
    expect(sidecar['version']).toBe('0.1.0');
    expect(sidecar['cli']).toBe(join(h.sr, 'bin', '0.1.0', 'cli.js'));
    expect(statSync(sidecar['node'] as string).isFile()).toBe(true);
    expect(statSync(sidecar['cli'] as string).isFile()).toBe(true);
    const launcherStat = statSync(sidecar['launcher'] as string);
    expect(launcherStat.isFile()).toBe(true);
    expect(launcherStat.mode & 0o111).not.toBe(0);
  });

  it('setup --json validates against the schema for every harness (§12.3)', () => {
    const h = makeHome();
    const r = runCli(
      ['setup', '--harness', 'claude-code,codex,cursor,gemini,copilot,hermes,dsh,opencode,openclaw', '--json'],
      { env: h.env, cwd: h.root },
    );
    expect(r.code).toBe(3); // openclaw registration is a manual step
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(validateAgainst(doc, 'setup', results)).toEqual([]);
    expect(results).toHaveLength(9);
    for (const result of results) {
      expect(result.launcher).toBe(h.launcher);
      if (result.diff !== '') expect(result.diff).toContain(`+++ ${result.path}`);
    }
  });

  it('codex: prints the trust instruction and the originator split from discovered rollouts', () => {
    const h = makeHome();
    const sessions = join(h.home, '.codex', 'sessions', '2026', '08');
    mkdirSync(sessions, { recursive: true });
    const meta = (originator: string): string =>
      `${JSON.stringify({ type: 'session_meta', payload: { originator } })}\n`;
    writeFileSync(join(sessions, 'rollout-2026-08-01T10-00-00-aaa.jsonl'), meta('codex_vscode'));
    writeFileSync(join(sessions, 'rollout-2026-08-02T11-00-00-bbb.jsonl'), meta('codex_cli'));
    writeFileSync(join(sessions, 'rollout-2026-08-03T12-00-00-ccc.jsonl'), meta('codex_cli'));
    const r = runCli(['setup', '--harness', 'codex', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    const notes = (JSON.parse(r.stdout) as SetupResult[])[0]?.notes.join('\n') ?? '';
    expect(notes).toContain('Codex requires trusting non-managed hooks');
    expect(notes).toContain('/hooks');
    expect(notes).toContain('1 of 3 rollouts on this machine were started from VS Code (codex_vscode)');
  });

  it('roadmap writers: opencode installs the plugin template; openclaw prints the manual snippet', () => {
    const h = makeHome();
    const r = runCli(['setup', '--harness', 'opencode,openclaw', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(3);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results.find((x) => x.harness === 'opencode')?.action).toBe('installed');
    const plugin = readFileSync(join(h.home, '.config', 'opencode', 'plugins', 'showreceipts.ts'), 'utf8');
    expect(plugin).toContain(`"${h.launcher}"`);
    expect(plugin).toContain('"hook", "opencode"');
    expect(results.find((x) => x.harness === 'openclaw')?.action).toBe('manual');
    expect(r.stderr).toContain('plugins');
    expect(readFileSync(join(h.home, '.config', 'openclaw', 'plugins', 'showreceipts.mjs'), 'utf8')).toContain('"hook", "openclaw"');
  });
});
