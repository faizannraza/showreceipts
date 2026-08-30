/** Temporary directories for tests, always removed afterwards. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a fresh temp directory (real path, so macOS `/var` → `/private/var` never surprises a test). */
export function makeTempDir(prefix = 'showreceipts-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Runs `fn` with a fresh temp directory and removes it afterwards, whatever happens. */
export async function withTempDir<T>(fn: (dir: string) => T | Promise<T>, prefix?: string): Promise<T> {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
