/**
 * S30 e2e — surgical merges over existing configs: foreign hooks preserved
 * byte-for-byte, malformed JSON → exit 1 no write, comment JSON → exit 3 no
 * write, `--remove` marker-only, `--restore`, backup rotation (3, 0600,
 * never beside the config) and unwritable configs → exit 1.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SetupResult } from '../../src/model/types.js';
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
  const root = makeTempDir('sr-setup-merge-');
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

/** A foreign Claude Code settings file, serialised exactly as setup would. */
const FOREIGN_SEED = `${JSON.stringify(
  {
    model: 'opus',
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  },
  null,
  2,
)}\n`;

function seedClaude(h: Home, text: string = FOREIGN_SEED): string {
  const dir = join(h.home, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, text);
  return path;
}

describe('setup — merges into existing configs (§9)', () => {
  it('preserves foreign hooks and keys; --remove restores the original bytes', () => {
    const h = makeHome();
    const config = seedClaude(h);
    chmodSync(config, 0o644);
    const r = runCli(['setup', '--harness', 'claude-code', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    // temp + rename kept the original file mode (0644, not the fresh 0600).
    expect(statSync(config).mode & 0o777).toBe(0o644);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results[0]?.action).toBe('updated');
    expect(results[0]?.backup).toContain(join(h.sr, 'backups', 'claude-code'));
    const merged = readFileSync(config, 'utf8');
    expect(merged).toContain('"echo foreign-stop"');
    expect(merged).toContain('"echo pre"');
    expect(merged).toContain('"model": "opus"');
    expect(merged).toContain('showreceipts-hook');

    const removed = runCli(['setup', '--harness', 'claude-code', '--remove', '--json'], { env: h.env, cwd: h.root });
    expect(removed.code).toBe(0);
    expect((JSON.parse(removed.stdout) as SetupResult[])[0]?.action).toBe('removed');
    // Marker-matched removal only: byte-for-byte back to the foreign seed,
    // the hooks key kept because it was not ours.
    expect(readFileSync(config, 'utf8')).toBe(FOREIGN_SEED);
  });

  it('drops the hooks key on --remove only when setup created it', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    const config = join(h.home, '.claude', 'settings.json');
    expect(readFileSync(config, 'utf8')).toContain('"hooks"');
    const r = runCli(['setup', '--harness', 'claude-code', '--remove'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('{}\n');
  });

  it('deletes the Copilot own-file when removal leaves only the shell', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'copilot'], { env: h.env, cwd: h.root });
    const config = join(h.home, '.copilot', 'hooks', 'showreceipts.json');
    expect(existsSync(config)).toBe(true);
    const r = runCli(['setup', '--harness', 'copilot', '--remove', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('removed');
    expect(existsSync(config)).toBe(false);
  });

  it('malformed JSON: exit 1, nothing written', () => {
    const h = makeHome();
    const broken = '{"hooks": \n';
    const config = seedClaude(h, broken);
    const r = runCli(['setup', '--harness', 'claude-code', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(readFileSync(config, 'utf8')).toBe(broken);
    expect(existsSync(join(h.sr, 'backups'))).toBe(false);
  });

  it('comment-bearing JSON: exit 3, nothing written, snippet printed', () => {
    const h = makeHome();
    const commented = '// managed by hand\n{\n  "hooks": {}\n}\n';
    const config = seedClaude(h, commented);
    const r = runCli(['setup', '--harness', 'claude-code', '--json'], { env: h.env, cwd: h.root });
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('manual');
    expect(r.stderr).toContain('showreceipts-hook');
    expect(readFileSync(config, 'utf8')).toBe(commented);
  });

  it('--restore copies the named backup back over the config', () => {
    const h = makeHome();
    const config = seedClaude(h);
    const r = runCli(['setup', '--harness', 'claude-code', '--json'], { env: h.env, cwd: h.root });
    const backup = (JSON.parse(r.stdout) as SetupResult[])[0]?.backup as string;
    expect(readFileSync(backup, 'utf8')).toBe(FOREIGN_SEED);
    expect(readFileSync(config, 'utf8')).not.toBe(FOREIGN_SEED);
    const restored = runCli(['setup', '--restore', backup, '--json'], { env: h.env, cwd: h.root });
    expect(restored.code).toBe(0);
    expect((JSON.parse(restored.stdout) as SetupResult[])[0]?.action).toBe('updated');
    expect(readFileSync(config, 'utf8')).toBe(FOREIGN_SEED);
  });

  it('backups rotate to the newest three, mode 0600, never beside the config', () => {
    const h = makeHome();
    runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
    // Four rewrites (strict on/off toggles) → four backups → rotated to 3.
    for (const args of [['--strict'], [], ['--strict'], []]) {
      const r = runCli(['setup', '--harness', 'claude-code', ...args, '--json'], { env: h.env, cwd: h.root });
      expect((JSON.parse(r.stdout) as SetupResult[])[0]?.action).toBe('updated');
    }
    const dir = join(h.sr, 'backups', 'claude-code');
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(3);
    for (const name of names) {
      expect(name).toMatch(/^settings\.json\.\d+$/);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    // Nothing backup-shaped beside the config.
    expect(readdirSync(join(h.home, '.claude'))).toEqual(['settings.json']);
  });

  it('unwritable config directory: exit 1', () => {
    const h = makeHome();
    const config = seedClaude(h);
    const dir = join(h.home, '.claude');
    chmodSync(dir, 0o555);
    try {
      const r = runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
      expect(r.code).toBe(1);
      expect(readFileSync(config, 'utf8')).toBe(FOREIGN_SEED);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
