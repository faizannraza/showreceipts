/**
 * Codex CLI writer (S30; §9 Codex row): merges the Stop hook (with
 * `commandWindows` pointing at the `.cmd` launcher) into
 * `~/.codex/hooks.json`, prints the trust instruction and the originator
 * split computed from the rollouts on disk (`N of M rollouts started from
 * VS Code (codex_vscode)` — Codex hooks run in the CLI only).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { isRecord, parseJsonSafe } from '../../util/json.js';
import { applyJsonWriter } from '../json-merge.js';
import { hookCommand, type WriterContext, type WriterOutcome } from '../plan.js';

/** The §9 trust instruction, printed on every Codex install. */
export const CODEX_TRUST_NOTE =
  'Codex requires trusting non-managed hooks: run `codex`, type `/hooks`, trust the showreceipts entry (trust is keyed to the hook hash; re-trust after `setup` changes it).';

/** The originator of one rollout's `session_meta` first line, or `null`. */
function firstLineOriginator(path: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const record = parseJsonSafe(line);
    if (!isRecord(record)) return null;
    const payload = record['payload'];
    const originator = isRecord(payload) ? payload['originator'] : record['originator'];
    return typeof originator === 'string' ? originator : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Counts rollouts under `<codexHome>/sessions` and how many came from VS Code. */
export function codexOriginatorSplit(codexHome: string): { vscode: number; total: number } {
  let vscode = 0;
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      total += 1;
      const originator = firstLineOriginator(full);
      if (originator !== null && originator.toLowerCase().includes('vscode')) vscode += 1;
    }
  };
  walk(join(codexHome, 'sessions'), 1);
  return { vscode, total };
}

/** The exact §9 `hooks` entries for Codex. */
export function desiredCodex(launcherPath: string, launcherCmdPath: string, strict: boolean): Record<string, unknown[]> {
  return {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: hookCommand(launcherPath, 'codex', 'Stop', strict),
            commandWindows: hookCommand(launcherCmdPath, 'codex', 'Stop', strict),
            timeout: 30,
            statusMessage: 'showreceipts',
          },
        ],
      },
    ],
  };
}

/** Installs/updates/removes the Codex Stop hook (never `SessionEnd`). */
export function apply(ctx: WriterContext): WriterOutcome {
  const notes: string[] = [];
  if (!ctx.remove) {
    notes.push(CODEX_TRUST_NOTE);
    const split = codexOriginatorSplit(ctx.codexHome);
    if (split.total > 0) {
      notes.push(
        `Codex hooks run in the CLI only: ${split.vscode} of ${split.total} rollouts on this machine were started from VS Code (codex_vscode) — those sessions are audited from disk, not live.`,
      );
    }
  }
  return applyJsonWriter(ctx, {
    shape: 'nested',
    desired: desiredCodex(ctx.launcherPath, ctx.launcherCmdPath, ctx.strict),
    notes,
  });
}
