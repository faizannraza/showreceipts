/**
 * Runs `scripts/survey-fixtures.mjs --check` (expected.json.shapes ⊆ found for
 * every fixture, fixtures/ ≤ 8 MB) and the single-file survey over the hazard
 * file. Offline; reads only `fixtures/`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SURVEY = join(ROOT, 'scripts', 'survey-fixtures.mjs');

function survey(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SURVEY, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('survey-fixtures.mjs', () => {
  it('--check passes: every expected shape is found and fixtures/ is within budget', () => {
    const r = survey(['--check']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--check: \d+ fixture\(s\) ok/);
    for (const id of ['claude-code/2.1.214', 'claude-code/2.1.251', 'codex/0.98.0', 'codex/shell_command', 'claude-code/legacy']) {
      expect(r.stdout).toContain(`${id}: ok`);
    }
  });

  it('prints shape signatures for a single transcript (the hazard file)', () => {
    const r = survey([join(ROOT, 'fixtures', 'hazards', 'u2028.jsonl')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lines: 10');
    expect(r.stdout).toContain('badLines: 0');
    expect(r.stdout).toContain('u2028: true');
    expect(r.stdout).toContain('hazard:crlf');
    expect(r.stdout).toContain('record:user');
  });

  it('prints the signatures of a fixture directory', () => {
    const r = survey([join(ROOT, 'fixtures', 'readers', 'codex', 'shell_command')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('codex:call:shell_command');
    expect(r.stdout).toContain('codex:exit:-1');
  });
});
