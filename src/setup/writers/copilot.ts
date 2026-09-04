/**
 * Copilot CLI writer (S30; §9 Copilot row): showreceipts owns its own file,
 * `~/.copilot/hooks/showreceipts.json` (`--project`:
 * `.github/hooks/showreceipts.json`), with `bash`/`powershell` command
 * variants and `timeoutSec` timeouts. Because the file is ours, a removal
 * that leaves only the `{version: 1}` shell deletes it.
 */
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';

function entry(launcherPath: string, launcherCmdPath: string, event: string, timeoutSec: number): Record<string, unknown> {
  return {
    type: 'command',
    bash: hookCommand(launcherPath, 'copilot', event),
    powershell: hookCommand(launcherCmdPath, 'copilot', event),
    timeoutSec,
  };
}

/** The exact §9 `hooks` entries for Copilot. */
export function desiredCopilot(launcherPath: string, launcherCmdPath: string): Record<string, unknown[]> {
  return {
    sessionStart: [entry(launcherPath, launcherCmdPath, 'sessionStart', 5)],
    postToolUse: [entry(launcherPath, launcherCmdPath, 'postToolUse', 10)],
    postToolUseFailure: [entry(launcherPath, launcherCmdPath, 'postToolUseFailure', 10)],
    agentStop: [entry(launcherPath, launcherCmdPath, 'agentStop', 30)],
    sessionEnd: [entry(launcherPath, launcherCmdPath, 'sessionEnd', 5)],
  };
}

/** Installs/updates/removes the Copilot hooks file. */
export function apply(ctx: WriterContext): WriterOutcome {
  return applyJsonWriter(ctx, {
    shape: 'flat',
    desired: desiredCopilot(ctx.launcherPath, ctx.launcherCmdPath),
    freshBase: { version: 1 },
    deleteWhenEmpty: true,
  });
}
