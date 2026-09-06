/**
 * Pass 3 — `commands/setup.ts` argv validation: a malformed `--restore`
 * value is a §12.2 usage error (exit 2, `showreceipts:` prefix and the
 * usage footer at the CLI shell), validated before any I/O — previously it
 * surfaced as a `showreceipts setup:` runtime failure with exit 1.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../../../src/cli/args.js';
import { createContext } from '../../../src/cli/context.js';
import { run } from '../../../src/commands/setup.js';

function ctxOf(argv: string[]): ReturnType<typeof createContext> {
  const sink = { write: (): boolean => true } as unknown as NodeJS.WritableStream;
  return createContext(parse(argv), {
    stdout: sink,
    stderr: sink,
    env: {},
    cwd: '/tmp',
    now: new Date('2026-08-29T12:00:00.000Z'),
    isTTY: false,
  });
}

describe('setup --restore usage validation (§12.2 exit 2)', () => {
  it('rejects a path outside backups/<harness>/ as a usage error', async () => {
    await expect(run(ctxOf(['setup', '--restore', 'nope']))).rejects.toMatchObject({
      name: 'UsageError',
      exitCode: 2,
      message: expect.stringContaining('--restore: expected a path under ~/.showreceipts/backups/<harness>/ (got nope)'),
    });
  });

  it('rejects a backup name without the .<unix-ms> suffix as a usage error', async () => {
    await expect(run(ctxOf(['setup', '--restore', '/x/backups/codex/config.toml']))).rejects.toMatchObject({
      name: 'UsageError',
      exitCode: 2,
      message: expect.stringContaining('not a backup file name (<basename>.<unix-ms>): config.toml'),
    });
  });
});
