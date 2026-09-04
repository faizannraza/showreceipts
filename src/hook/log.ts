/**
 * `hook.log` — the hook runtime's only diagnostic channel (§9): stdout is
 * reserved for the single JSON answer and stderr may be swallowed by the
 * harness, so `--debug` traces, watchdog firings and swallowed exceptions are
 * appended to `<home>/hook.log`. Logging must never break a hook — every
 * failure here is swallowed — and every line is masked and sanitised before
 * it is written (§13.2).
 */
import { join } from 'node:path';
import { appendLine, ensureDir } from '../util/fs.js';
import { maskSecrets } from '../util/mask.js';
import { sanitizeForCell } from '../util/sanitize.js';

/** Absolute path of the hook log under the showreceipts home. */
export function hookLogPath(home: string): string {
  return join(home, 'hook.log');
}

/**
 * Appends one `<ISO timestamp> <message>` line to `<home>/hook.log` (`0600`
 * in a `0700` home). The message is masked and flattened to one line first.
 * Never throws: a hook must answer `{}` even when its log is unwritable.
 */
export function hookLog(home: string, now: Date, message: string): void {
  try {
    ensureDir(home, 0o700);
    appendLine(hookLogPath(home), `${now.toISOString()} ${sanitizeForCell(maskSecrets(message))}\n`);
  } catch {
    // logging must never break a hook
  }
}

/**
 * A trace logger for `--debug`: writes to `hook.log` when enabled and a home
 * is known, a no-op otherwise (a `null` home means nothing may be written).
 */
export function makeDebugLogger(home: string | null, now: Date, enabled: boolean): (message: string) => void {
  if (!enabled || home === null) return () => undefined;
  return (message: string) => {
    hookLog(home, now, message);
  };
}
