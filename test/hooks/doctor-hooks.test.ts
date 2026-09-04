/**
 * S31 — `doctor`'s hook reporting (§12.3 `doctor --json.hooks`): after
 * `setup --all` in a temp HOME every harness row shows `installed: true`
 * with the launcher in its command and a `resolvable: true` static sidecar
 * check; foreign Stop hooks surface in `otherStopHooks`; `disableAllHooks`
 * masks installed hooks (exit 4); Hermes trust follows the shell-hooks
 * allowlist; Codex trust is `'unknown'`; deleting the launcher or its
 * sidecar flips `resolvable` to false and exits 4.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorHookReport, DoctorReport } from '../../src/model/types.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();
const V1_HARNESSES = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes'] as const;

interface Home {
  root: string;
  home: string;
  sr: string;
  launcher: string;
  cwd: string;
  env: Record<string, string>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp HOME with every v1 harness config directory present (so `--all` detects them). */
function makeHome(): Home {
  const root = makeTempDir('sr-doctor-hooks-');
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  for (const dir of ['.claude', '.codex', '.cursor', '.gemini', '.copilot', '.hermes']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  mkdirSync(cwd, { recursive: true });
  const sr = join(home, '.showreceipts');
  return {
    root,
    home,
    sr,
    launcher: join(sr, 'bin', 'showreceipts-hook'),
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      SHOWRECEIPTS_HOME: sr,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    },
  };
}

function setupAll(h: Home): void {
  const r = runCli(['setup', '--all'], { env: h.env, cwd: h.cwd });
  expect(r.code).toBe(0);
}

function doctorReport(h: Home): { report: DoctorReport; code: number } {
  const r = runCli(['doctor', '--json', '--home-dir', '/home/u'], { env: h.env, cwd: h.cwd });
  return { report: JSON.parse(r.stdout) as DoctorReport, code: r.code };
}

/** The user-scope row of one harness. */
function userRow(report: DoctorReport, harness: string): DoctorHookReport {
  const row = report.hooks.find((r) => r.harness === harness && r.scope === 'user');
  expect(row, `no user-scope hook row for ${harness}`).toBeDefined();
  return row as DoctorHookReport;
}

describe('doctor --json.hooks after setup --all (§12.3)', () => {
  it('reports installed:true, the launcher command and resolvable:true for every v1 harness', () => {
    const h = makeHome();
    setupAll(h);
    const { report, code } = doctorReport(h);
    expect(code).toBe(0);
    expect(validateAgainst(doc, 'doctor', report)).toEqual([]);
    for (const harness of V1_HARNESSES) {
      const row = userRow(report, harness);
      expect(row.installed, `${harness} installed`).toBe(true);
      expect(row.command, `${harness} command`).toContain(h.launcher);
      expect(row.resolvable, `${harness} resolvable`).toBe(true);
      expect(row.resolvableNote).toContain('static check');
      expect(row.disabled).toBe(false);
      expect(row.strict).toBe(false);
    }
    expect(userRow(report, 'codex').trusted).toBe('unknown');
    // Hermes without the allowlist: installed but not trusted (§9 consent).
    const hermes = userRow(report, 'hermes');
    expect(hermes.trusted).toBe(false);
    expect(hermes.trustNote).toContain('shell-hooks-allowlist');
  });

  it('a pre-existing foreign Stop hook surfaces in otherStopHooks and survives setup', () => {
    const h = makeHome();
    const settings = join(h.home, '.claude', 'settings.json');
    writeFileSync(
      settings,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-stop-hook' }] }] } }, null, 2)}\n`,
    );
    setupAll(h);
    const { report, code } = doctorReport(h);
    expect(code).toBe(0);
    const row = userRow(report, 'claude-code');
    expect(row.installed).toBe(true);
    expect(row.otherStopHooks).toContain('/usr/local/bin/other-stop-hook');
    expect(readFileSync(settings, 'utf8')).toContain('/usr/local/bin/other-stop-hook');
  });

  it('disableAllHooks:true masks installed hooks — disabled:true and exit 4', () => {
    const h = makeHome();
    setupAll(h);
    const settings = join(h.home, '.claude', 'settings.json');
    const config = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    config['disableAllHooks'] = true;
    writeFileSync(settings, `${JSON.stringify(config, null, 2)}\n`);
    const { report, code } = doctorReport(h);
    expect(code).toBe(4);
    expect(userRow(report, 'claude-code').disabled).toBe(true);
    expect(report.problems.some((p) => p.includes('disableAllHooks'))).toBe(true);
  });

  it('hermes trusted flips to true once every (event, command) pair is allowlisted', () => {
    const h = makeHome();
    setupAll(h);
    const events = ['post_tool_call', 'post_llm_call', 'on_session_start', 'on_session_end', 'on_session_finalize'];
    const allowlist: Record<string, string[]> = {};
    for (const event of events) allowlist[event] = [`"${h.launcher}" hook hermes ${event}`];
    writeFileSync(join(h.home, '.hermes', 'shell-hooks-allowlist.json'), `${JSON.stringify(allowlist, null, 2)}\n`);
    const { report, code } = doctorReport(h);
    expect(code).toBe(0);
    const row = userRow(report, 'hermes');
    expect(row.trusted).toBe(true);
    expect(row.trustNote).toBeUndefined();
  });

  it('deleting the launcher after setup: resolvable:false and exit 4', () => {
    const h = makeHome();
    setupAll(h);
    unlinkSync(h.launcher);
    const { report, code } = doctorReport(h);
    expect(code).toBe(4);
    for (const harness of V1_HARNESSES) {
      expect(userRow(report, harness).resolvable, `${harness} resolvable`).toBe(false);
    }
    expect(report.problems.some((p) => p.includes('launcher unresolvable'))).toBe(true);
  });

  it('deleting only the sidecar after setup: resolvable:false and exit 4', () => {
    const h = makeHome();
    setupAll(h);
    const sidecar = join(h.sr, 'bin', 'launcher.json');
    expect(existsSync(sidecar)).toBe(true);
    unlinkSync(sidecar);
    const { report, code } = doctorReport(h);
    expect(code).toBe(4);
    expect(userRow(report, 'claude-code').resolvable).toBe(false);
    expect(report.problems.some((p) => p.includes('launcher unresolvable'))).toBe(true);
  });
});
