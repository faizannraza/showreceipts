/**
 * Cursor writer (S30; §9 Cursor row): merges the full event list into
 * `~/.cursor/hooks.json` (`version: 1` on a fresh file). Every event except
 * `afterShellExecution`, which carries no exit code and would duplicate
 * `postToolUse`; the `stop` entry carries `loop_limit: 2`.
 */
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';

function entry(launcherPath: string, event: string, timeout: number, strict = false): Record<string, unknown> {
  return { command: hookCommand(launcherPath, 'cursor', event, strict), type: 'command', timeout };
}

/** The exact §9 `hooks` entries for Cursor. */
export function desiredCursor(launcherPath: string, strict: boolean): Record<string, unknown[]> {
  return {
    sessionStart: [entry(launcherPath, 'sessionStart', 5)],
    postToolUse: [entry(launcherPath, 'postToolUse', 10)],
    postToolUseFailure: [entry(launcherPath, 'postToolUseFailure', 10)],
    afterFileEdit: [entry(launcherPath, 'afterFileEdit', 10)],
    afterMCPExecution: [entry(launcherPath, 'afterMCPExecution', 10)],
    afterAgentResponse: [entry(launcherPath, 'afterAgentResponse', 10)],
    subagentStop: [entry(launcherPath, 'subagentStop', 10)],
    stop: [{ ...entry(launcherPath, 'stop', 30, strict), loop_limit: 2 }],
    sessionEnd: [entry(launcherPath, 'sessionEnd', 10)],
  };
}

/** Installs/updates/removes the Cursor hooks. */
export function apply(ctx: WriterContext): WriterOutcome {
  return applyJsonWriter(ctx, {
    shape: 'flat',
    desired: desiredCursor(ctx.launcherPath, ctx.strict),
    freshBase: { version: 1 },
  });
}
