/**
 * dsh writer (S30; §9 dsh row): dsh shares the Claude Code settings file and
 * dialect. `setup --harness dsh` (opt-in, never auto-detected) installs the
 * Stop hook plus `PostToolUse`/`PostToolUseFailure` with the
 * `Bash|Edit|Write|MultiEdit|NotebookEdit` matcher, commands spoken in the
 * claude-code dialect.
 */
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';
import { desiredClaudeCode } from './claude-code.js';

const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';

/** The exact §9 `hooks` entries for dsh: Claude Code's Stop + the two record events. */
export function desiredDsh(launcherPath: string, strict: boolean): Record<string, unknown[]> {
  const hooks = desiredClaudeCode(launcherPath, strict);
  hooks['PostToolUse'] = [
    {
      matcher: MATCHER,
      hooks: [
        {
          type: 'command',
          command: hookCommand(launcherPath, 'claude-code', 'PostToolUse'),
          timeout: 10,
        },
      ],
    },
  ];
  hooks['PostToolUseFailure'] = [
    {
      matcher: MATCHER,
      hooks: [
        {
          type: 'command',
          command: hookCommand(launcherPath, 'claude-code', 'PostToolUseFailure'),
          timeout: 10,
        },
      ],
    },
  ];
  return hooks;
}

/** Installs/updates/removes the dsh hooks in the shared Claude Code settings file. */
export function apply(ctx: WriterContext): WriterOutcome {
  return applyJsonWriter(ctx, {
    shape: 'nested',
    desired: desiredDsh(ctx.launcherPath, ctx.strict),
    notes: [
      'dsh records PostToolUse/PostToolUseFailure into the ledger (~80–120 ms per matched tool call); Claude Code sessions are skipped by transcript path',
    ],
  });
}
