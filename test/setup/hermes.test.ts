/**
 * S30 e2e — the Hermes managed YAML block over `~/.hermes/config.yaml`:
 * foreign `hooks:` → exit 3, `hooks_auto_accept`-only files gain the block,
 * a missing trailing newline is fixed, multi-document files → exit 3, and
 * `--remove` deletes exactly the block.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SetupResult } from '../../src/model/types.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

interface Home {
  root: string;
  home: string;
  config: string;
  env: Record<string, string>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(seed?: string): Home {
  const root = makeTempDir('sr-setup-hermes-');
  roots.push(root);
  const home = join(root, 'home');
  const hermesDir = join(home, '.hermes');
  mkdirSync(hermesDir, { recursive: true });
  const config = join(hermesDir, 'config.yaml');
  if (seed !== undefined) writeFileSync(config, seed);
  return {
    root,
    home,
    config,
    env: {
      HOME: home,
      USERPROFILE: home,
      SHOWRECEIPTS_HOME: join(home, '.showreceipts'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    },
  };
}

function run(h: Home, args: string[]): { code: number; stdout: string; stderr: string } {
  return runCli(['setup', '--harness', 'hermes', ...args], { env: h.env, cwd: h.root });
}

describe('setup — Hermes managed block (§9)', () => {
  it('an existing top-level hooks: key is a manual step (exit 3, nothing written)', () => {
    const seed = 'hooks:\n  post_llm_call: []\n';
    const h = makeHome(seed);
    const r = run(h, ['--json']);
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('manual');
    expect(r.stderr).toContain('# >>> showreceipts >>>');
    expect(readFileSync(h.config, 'utf8')).toBe(seed);
  });

  it('a hooks_auto_accept-only file gets the block appended, first line intact', () => {
    const seed = 'hooks_auto_accept: true\n';
    const h = makeHome(seed);
    const r = run(h, ['--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('updated');
    const text = readFileSync(h.config, 'utf8');
    expect(text.startsWith(seed)).toBe(true);
    expect(text).toContain('# >>> showreceipts >>>');
    expect(text).toContain('hook hermes post_llm_call');
    // Idempotent.
    const again = run(h, ['--json']);
    expect((JSON.parse(again.stdout) as SetupResult[])[0]?.action).toBe('unchanged');
  });

  it('fixes a missing trailing newline before appending', () => {
    const h = makeHome('model: hermes-4');
    expect(run(h, []).code).toBe(0);
    const text = readFileSync(h.config, 'utf8');
    expect(text.startsWith('model: hermes-4\n# >>> showreceipts >>>\n')).toBe(true);
    expect(text.endsWith('# <<< showreceipts <<<\n')).toBe(true);
  });

  it('a multi-document file is a manual step (exit 3)', () => {
    const seed = '---\nmodel: hermes-4\n';
    const h = makeHome(seed);
    const r = run(h, []);
    expect(r.code).toBe(3);
    expect(readFileSync(h.config, 'utf8')).toBe(seed);
  });

  it('--remove deletes exactly the block, restoring the original bytes', () => {
    const seed = 'hooks_auto_accept: true\nmodel: hermes-4\n';
    const h = makeHome(seed);
    expect(run(h, []).code).toBe(0);
    expect(readFileSync(h.config, 'utf8')).not.toBe(seed);
    const r = run(h, ['--remove', '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('removed');
    expect(readFileSync(h.config, 'utf8')).toBe(seed);
  });
});
