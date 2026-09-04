/**
 * Hermes writer (S30; §9 Hermes row): appends the managed block to
 * `~/.hermes/config.yaml` via `yaml-block.ts` (manual step when the file has
 * a foreign top-level `hooks:` or is multi-document) and prints the consent
 * note — Hermes prompts once per `(event, command)` pair.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../util/fs.js';
import { unifiedDiff } from '../diff.js';
import { makeResult, type WriterContext, type WriterOutcome } from '../plan.js';
import { applyHermesBlock, hermesBlock, removeHermesBlock } from '../yaml-block.js';

/** The §9 consent instruction, printed on every Hermes install. */
export const HERMES_CONSENT_NOTE =
  'Hermes prompts once per (event, command) — changing the command string re-triggers consent; run `hermes hooks list` and accept, or add the entries to ~/.hermes/shell-hooks-allowlist.json.';

/** Installs/updates/removes the Hermes managed block. */
export function apply(ctx: WriterContext): WriterOutcome {
  const path = ctx.target.path;
  let text: string | null = null;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      const message = `cannot read ${path} (${code ?? 'unknown error'})`;
      return { result: makeResult(ctx, 'manual', { notes: [message] }), exit: 1, error: message };
    }
  }
  const block = hermesBlock(ctx.launcherPath);

  try {
    if (ctx.remove) {
      if (text === null) return { result: makeResult(ctx, 'unchanged'), exit: 0 };
      const { changed, text: next } = removeHermesBlock(text);
      if (!changed) return { result: makeResult(ctx, 'unchanged'), exit: 0 };
      const diff = unifiedDiff(text, next, path);
      let backup: string | null = null;
      if (!ctx.dryRun) {
        backup = ctx.backup(text);
        atomicWriteFile(path, next);
      }
      return { result: makeResult(ctx, ctx.dryRun ? 'dry-run' : 'removed', { backup, diff }), exit: 0 };
    }

    const applied = applyHermesBlock(text, block);
    if (applied.kind === 'manual') {
      const message = `${path}: ${applied.reason}`;
      return {
        result: makeResult(ctx, 'manual', { notes: [message, HERMES_CONSENT_NOTE] }),
        exit: 3,
        snippet: `# add to ${path} manually:\n${block}`,
      };
    }
    if (applied.kind === 'unchanged') {
      return { result: makeResult(ctx, 'unchanged', { notes: [HERMES_CONSENT_NOTE] }), exit: 0 };
    }
    const diff = unifiedDiff(text ?? '', applied.text, path);
    let backup: string | null = null;
    if (!ctx.dryRun) {
      fs.mkdirSync(dirname(path), { recursive: true });
      if (text !== null) backup = ctx.backup(text);
      atomicWriteFile(path, applied.text, text === null ? { mode: 0o600 } : {});
    }
    const action = ctx.dryRun ? 'dry-run' : applied.kind;
    return { result: makeResult(ctx, action, { backup, diff, notes: [HERMES_CONSENT_NOTE] }), exit: 0 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = `cannot write ${path} (${code ?? String(err)})`;
    return { result: makeResult(ctx, 'manual', { notes: [message] }), exit: 1, error: message };
  }
}
