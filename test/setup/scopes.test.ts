/**
 * S30 e2e — scopes and orchestration: `--dry-run` writes nothing at all,
 * `--project`/`--shared` paths with the absolute-path warning, harness
 * auto-detection, `--remove` leaving the launcher unless `--remove --all`,
 * and `doctor` reporting installed + resolvable hooks after `setup`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorReport, SetupResult } from '../../src/model/types.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

interface Home {
  root: string;
  home: string;
  sr: string;
  env: Record<string, string>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): Home {
  const root = makeTempDir('sr-setup-scopes-');
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const sr = join(home, '.showreceipts');
  return {
    root,
    home,
    sr,
    env: {
      HOME: home,
      USERPROFILE: home,
      SHOWRECEIPTS_HOME: sr,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    },
  };
}

/** A git repository root under the temp tree (a bare `.git` dir marks it). */
function makeRepo(h: Home): string {
  const repo = join(h.root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

describe('setup — --dry-run (§12.1)', () => {
  it('prints the diff and writes nothing: no config, no launcher, no sidecar, no state', () => {
    const h = makeHome();
    const r = runCli(['setup', '--harness', 'claude-code,hermes', '--dry-run', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results.map((x) => x.action)).toEqual(['dry-run', 'dry-run']);
    // absolute config paths label the diff verbatim (Pass 3: no `a//`)
    expect(results[0]?.diff).toContain(`+++ ${join(h.home, '.claude', 'settings.json')}`);
    expect(existsSync(join(h.home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(h.home, '.hermes', 'config.yaml'))).toBe(false);
    expect(existsSync(h.sr)).toBe(false); // not even the launcher or the sidecar
  });
});

describe('setup — --project and --shared scopes (§9)', () => {
  it('--project writes project-level files in the repo root with the absolute-path warning', () => {
    const h = makeHome();
    const repo = makeRepo(h);
    const r = runCli(['setup', '--harness', 'claude-code,codex,cursor,gemini,copilot', '--project', '--json'], {
      env: h.env,
      cwd: repo,
    });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    const byHarness = new Map(results.map((x) => [x.harness, x]));
    expect(byHarness.get('claude-code')?.path).toBe(join(repo, '.claude', 'settings.local.json'));
    expect(byHarness.get('codex')?.path).toBe(join(repo, '.codex', 'hooks.json'));
    expect(byHarness.get('cursor')?.path).toBe(join(repo, '.cursor', 'hooks.json'));
    expect(byHarness.get('gemini')?.path).toBe(join(repo, '.gemini', 'settings.json'));
    expect(byHarness.get('copilot')?.path).toBe(join(repo, '.github', 'hooks', 'showreceipts.json'));
    for (const result of results) {
      expect(result.scope).toBe('project');
      expect(result.action).toBe('installed');
      expect(result.notes.join(' ')).toContain('absolute path');
      expect(existsSync(result.path)).toBe(true);
    }
  });

  it('--shared writes the shared Claude Code settings with the warning', () => {
    const h = makeHome();
    const repo = makeRepo(h);
    const r = runCli(['setup', '--harness', 'claude-code', '--shared', '--json'], { env: h.env, cwd: repo });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results[0]?.path).toBe(join(repo, '.claude', 'settings.json'));
    expect(results[0]?.scope).toBe('shared');
    expect(results[0]?.notes.join(' ')).toContain('absolute path');
  });

  it('--project with --shared is a usage error (exit 2)', () => {
    const h = makeHome();
    const r = runCli(['setup', '--project', '--shared'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(2);
  });
});

describe('setup — auto-detection and removal', () => {
  it('auto-detects exactly the harnesses whose config directories exist', () => {
    const h = makeHome();
    mkdirSync(join(h.home, '.cursor'), { recursive: true });
    mkdirSync(join(h.home, '.gemini'), { recursive: true });
    const r = runCli(['setup', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results.map((x) => x.harness)).toEqual(['cursor', 'gemini']);
  });

  it('finds nothing on a bare machine and exits 0 with an empty result list', () => {
    const h = makeHome();
    const r = runCli(['setup', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
    expect(existsSync(h.sr)).toBe(false);
  });

  it('--remove leaves the launcher in place; --remove --all deletes it', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    const binDir = join(h.sr, 'bin');
    expect(existsSync(binDir)).toBe(true);
    const removed = runCli(['setup', '--harness', 'claude-code', '--remove'], { env: h.env, cwd: h.root });
    expect(removed.code).toBe(0);
    expect(existsSync(binDir)).toBe(true);
    expect(removed.stdout).toContain('--remove --all');
    const all = runCli(['setup', '--harness', 'claude-code', '--remove', '--all'], { env: h.env, cwd: h.root });
    expect(all.code).toBe(0);
    expect(existsSync(binDir)).toBe(false);
  });
});

describe('setup → doctor (§12.3)', () => {
  it('doctor reports installed:true and resolvable:true for every harness after setup', () => {
    const h = makeHome();
    for (const dir of ['.claude', '.codex', '.cursor', '.gemini', '.copilot', '.hermes']) {
      mkdirSync(join(h.home, dir), { recursive: true });
    }
    const setup = runCli(['setup', '--json'], { env: h.env, cwd: h.root });
    expect(setup.code).toBe(0);
    const results = JSON.parse(setup.stdout) as SetupResult[];
    expect(results.map((x) => x.harness)).toEqual(['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes']);

    const doctor = runCli(['doctor', '--json'], { env: h.env, cwd: h.root });
    expect(doctor.code).toBe(0);
    const report = JSON.parse(doctor.stdout) as DoctorReport;
    for (const harness of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes']) {
      const row = report.hooks.find((x) => x.harness === harness && x.installed);
      expect(row, `expected an installed hooks row for ${harness}`).toBeDefined();
      expect(row?.resolvable).toBe(true);
      expect(row?.resolvableNote).toContain('static check');
      expect(row?.command).toContain('showreceipts-hook');
    }
  });

  it('setup output mentions the .gitignore hint and the global-install tip', () => {
    const h = makeHome();
    const r = runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('.showreceipts/');
    expect(r.stdout).toContain('npm i -g showreceipts');
    const text = readFileSync(join(h.home, '.claude', 'settings.json'), 'utf8');
    expect(text).toContain('showreceipts-hook');
  });
});
