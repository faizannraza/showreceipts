/**
 * Test environment pins (PLAN §0.4). `test/setup.ts` applies them to
 * `process.env` for every test file; `pinnedEnv()` produces the environment
 * handed to spawned CLI children.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The frozen clock every test runs under unless it passes `--now`. */
export const PINNED_NOW = '2026-08-29T12:00:00Z';

/** Constant pins applied to every test process and child. */
export const PINNED_CONSTANTS: Readonly<Record<string, string>> = {
  TZ: 'UTC',
  NO_COLOR: '1',
  COLUMNS: '80',
  SHOWRECEIPTS_NOW: PINNED_NOW,
};

/** Variables that must be absent so they cannot leak from the developer's shell. */
export const UNPINNED_KEYS: readonly string[] = ['FORCE_COLOR', 'SHOWRECEIPTS_NO_CACHE'];

export interface PinnedDirs {
  readonly root: string;
  readonly home: string;
  readonly showreceiptsHome: string;
  readonly claudeConfigDir: string;
  readonly codexHome: string;
}

let pinned: PinnedDirs | undefined;

/**
 * Creates the per-run temp roots once and points `HOME`, `USERPROFILE`,
 * `SHOWRECEIPTS_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at them, applies
 * the constant pins and removes the unpinned keys. Idempotent.
 */
export function ensurePins(): PinnedDirs {
  if (pinned === undefined) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'showreceipts-test-')));
    const dirs: PinnedDirs = {
      root,
      home: join(root, 'home'),
      showreceiptsHome: join(root, 'showreceipts-home'),
      claudeConfigDir: join(root, 'claude'),
      codexHome: join(root, 'codex'),
    };
    for (const dir of [dirs.home, dirs.showreceiptsHome, dirs.claudeConfigDir, dirs.codexHome]) {
      mkdirSync(dir, { recursive: true });
    }
    pinned = dirs;
    process.env['HOME'] = dirs.home;
    process.env['USERPROFILE'] = dirs.home;
    process.env['SHOWRECEIPTS_HOME'] = dirs.showreceiptsHome;
    process.env['CLAUDE_CONFIG_DIR'] = dirs.claudeConfigDir;
    process.env['CODEX_HOME'] = dirs.codexHome;
  }
  for (const [key, value] of Object.entries(PINNED_CONSTANTS)) process.env[key] = value;
  for (const key of UNPINNED_KEYS) delete process.env[key];
  return pinned;
}

/** Removes the temp roots created by `ensurePins()` (called from `afterAll`). */
export function releasePins(): void {
  if (pinned === undefined) return;
  rmSync(pinned.root, { recursive: true, force: true });
  pinned = undefined;
}

/**
 * The environment for a spawned child: the current `process.env` (so a test
 * that re-points `HOME` is honoured) with the constant pins forced and the
 * unpinned keys removed. Values are always strings.
 */
export function pinnedEnv(): Record<string, string> {
  ensurePins();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, PINNED_CONSTANTS);
  for (const key of UNPINNED_KEYS) delete env[key];
  return env;
}
