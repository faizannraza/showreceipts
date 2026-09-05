#!/usr/bin/env node
// Renders `docs/receipt.svg` — the README's opening image — from the first
// bundled demo scenario via the hidden `demo --svg` flag (S23b/S33). The
// render is deterministic by construction (§14.1: seeded scenarios, fixed
// clock, `--tz utc`, `homeDir=/home/u`), so the committed SVG is a fixed
// point: `--check` re-renders into a temp file and compares bytes.
//
//   node scripts/screenshot.mjs           write docs/receipt.svg
//   node scripts/screenshot.mjs --check   exit 1 when docs/receipt.svg is stale
//
// The child runs with empty harness roots and a temp home: `demo` reads no
// session data by design (§12.1), and this keeps the invocation hermetic
// even if that ever regressed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');
const TARGET = join(ROOT, 'docs', 'receipt.svg');
/** The §10.2 sample width (`docs/samples/*.txt` and the demo e2e use 74). */
const WIDTH = '74';

function fail(msg) {
  process.stderr.write(`screenshot: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(CLI)) fail('missing dist/cli.js — run `npm run build` first');
const check = process.argv.includes('--check');

const tmp = mkdtempSync(join(tmpdir(), 'showreceipts-svg-'));
try {
  const out = join(tmp, 'receipt.svg');
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  execFileSync(
    process.execPath,
    [CLI, 'demo', '--svg', out, '--width', WIDTH, '--unicode', '--tz', 'utc', '--now', '2026-08-29T12:00:00Z'],
    {
      cwd: tmp,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        TZ: 'UTC',
        NO_COLOR: '1',
        COLUMNS: '80',
        SHOWRECEIPTS_HOME: join(tmp, 'sr'),
        CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
        CODEX_HOME: join(tmp, 'codex'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const fresh = readFileSync(out);
  if (check) {
    const current = existsSync(TARGET) ? readFileSync(TARGET) : Buffer.alloc(0);
    if (!current.equals(fresh)) fail('docs/receipt.svg is stale — run `node scripts/screenshot.mjs`');
    process.stdout.write('screenshot: docs/receipt.svg is up to date\n');
  } else {
    writeFileSync(TARGET, fresh);
    process.stdout.write(`screenshot: wrote docs/receipt.svg (${fresh.length} bytes)\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
