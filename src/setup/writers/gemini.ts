/**
 * Gemini CLI writer (S30; §9 Gemini row): merges named hook entries with
 * millisecond timeouts into `~/.gemini/settings.json`. Gemini's settings may
 * carry comments — the shared JSON engine refuses to rewrite those files
 * (manual step, exit 3).
 */
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';

function group(name: string, command: string, timeoutMs: number, description?: string): unknown[] {
  const entry: Record<string, unknown> = { name, type: 'command', command, timeout: timeoutMs };
  if (description !== undefined) entry['description'] = description;
  return [{ matcher: '', hooks: [entry] }];
}

/** The exact §9 `hooks` entries for Gemini (names + timeouts in ms). */
export function desiredGemini(launcherPath: string, strict: boolean): Record<string, unknown[]> {
  return {
    SessionStart: group('showreceipts-start', hookCommand(launcherPath, 'gemini', 'SessionStart'), 5000),
    AfterTool: group('showreceipts-record', hookCommand(launcherPath, 'gemini', 'AfterTool'), 10000, 'records tool effects for receipts'),
    AfterAgent: group('showreceipts-stop', hookCommand(launcherPath, 'gemini', 'AfterAgent', strict), 30000),
    SessionEnd: group('showreceipts-end', hookCommand(launcherPath, 'gemini', 'SessionEnd'), 5000),
  };
}

/** Installs/updates/removes the Gemini hooks. */
export function apply(ctx: WriterContext): WriterOutcome {
  return applyJsonWriter(ctx, {
    shape: 'nested',
    desired: desiredGemini(ctx.launcherPath, ctx.strict),
  });
}
