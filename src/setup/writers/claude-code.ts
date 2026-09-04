/**
 * Claude Code writer (S30; §9 row 1): merges the `Stop` hook (no matcher)
 * into `~/.claude/settings.json` (or the `--project`/`--shared` scope
 * files); `--strict` appends `--strict` to the Stop command and adds the
 * `SessionStart` entry with the `startup|resume` matcher.
 */
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';

/** The exact §9 `hooks` entries for Claude Code. */
export function desiredClaudeCode(launcherPath: string, strict: boolean): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(launcherPath, 'claude-code', 'Stop', strict),
            timeout: 30,
            statusMessage: 'showreceipts: building receipt',
          },
        ],
      },
    ],
  };
  if (strict) {
    hooks['SessionStart'] = [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: hookCommand(launcherPath, 'claude-code', 'SessionStart'),
            timeout: 5,
          },
        ],
      },
    ];
  }
  return hooks;
}

/** Installs/updates/removes the Claude Code hooks. */
export function apply(ctx: WriterContext): WriterOutcome {
  return applyJsonWriter(ctx, {
    shape: 'nested',
    desired: desiredClaudeCode(ctx.launcherPath, ctx.strict),
  });
}
