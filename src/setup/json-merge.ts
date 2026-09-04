/**
 * Surgical JSON hook-config editing (S30; §9 "Backups and removal"): strict
 * parse first; a file that only parses after comment stripping is NEVER
 * rewritten (manual step, exit 3 — Gemini allows comments); indentation
 * (2/4/tab) and the trailing newline are detected and preserved; writes go
 * through temp + rename keeping the original mode; other keys are never
 * touched.
 *
 * The merge is strip-and-append: every marked entry (a command string
 * containing `showreceipts-hook` / `showreceipts hook`) is removed, then the
 * desired groups are appended per event. Foreign entries are preserved
 * byte-for-byte; a second run reproduces the file exactly and reports
 * `unchanged`. `--remove` deletes marked entries only; event arrays and the
 * `hooks` key are dropped only when empty **and**
 * `state/setup.json.createdHooksKey[harness]` is true.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../util/fs.js';
import { isRecord, stableStringify } from '../util/json.js';
import { unifiedDiff } from './diff.js';
import { stripJsonComments } from './inspect.js';
import { makeResult, type WriterContext, type WriterOutcome } from './plan.js';

/** A hook command of ours, in any config dialect (§9). */
export const MARKER_RE = /showreceipts-hook|showreceipts hook/;

/** How the harness nests hook entries under `hooks[event]`. */
export type HookShape =
  /** Claude Code / Codex / Gemini: `hooks[event] = [{matcher?, hooks: [entry…]}]`. */
  | 'nested'
  /** Cursor / Copilot: `hooks[event] = [entry…]` (command or bash/powershell). */
  | 'flat';

/** True when a hook entry carries a showreceipts command in any of its command fields. */
export function entryMarked(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  for (const key of ['command', 'bash', 'powershell', 'commandWindows']) {
    const value = entry[key];
    if (typeof value === 'string' && MARKER_RE.test(value)) return true;
  }
  return false;
}

/** The formatting facts preserved across a rewrite. */
export interface JsonFormat {
  /** The indentation unit: two spaces, four spaces or a tab. */
  indent: string;
  trailingNewline: boolean;
}

/** Detects the indentation unit and trailing newline of an existing file. */
export function detectJsonFormat(text: string): JsonFormat {
  const m = /^([ \t]+)\S/m.exec(text);
  let indent = '  ';
  if (m !== null) {
    const ws = m[1] as string;
    if (ws.includes('\t')) indent = '\t';
    else if (ws.length >= 4) indent = '    ';
  }
  return { indent, trailingNewline: text.endsWith('\n') };
}

/** Serialises a config with the detected formatting. */
export function serializeJson(value: unknown, format: JsonFormat): string {
  return JSON.stringify(value, null, format.indent) + (format.trailingNewline ? '\n' : '');
}

/** The four ways a config text can read (§9: comment-bearing is never rewritten). */
export type ParsedJsonConfig =
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'not-object' }
  | { kind: 'comments' }
  | { kind: 'malformed' };

/** Strict parse; a strict failure that parses after comment stripping is `comments`. */
export function classifyJsonText(text: string): ParsedJsonConfig {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { kind: 'ok', value } : { kind: 'not-object' };
  } catch {
    // fall through to the comment-stripped parse
  }
  try {
    JSON.parse(stripJsonComments(text));
    return { kind: 'comments' };
  } catch {
    return { kind: 'malformed' };
  }
}

/** Deep clone via JSON (configs are plain JSON by construction). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Removes marked entries from one event's array; nested groups that end up empty are dropped. */
function stripEvent(entries: unknown[], shape: HookShape): { kept: unknown[]; removed: boolean } {
  if (shape === 'flat') {
    const kept = entries.filter((entry) => !entryMarked(entry));
    return { kept, removed: kept.length !== entries.length };
  }
  let removed = false;
  const kept: unknown[] = [];
  for (const group of entries) {
    if (!isRecord(group) || !Array.isArray(group['hooks'])) {
      // Tolerate flat-style strays inside a nested config.
      if (entryMarked(group)) removed = true;
      else kept.push(group);
      continue;
    }
    const inner = group['hooks'].filter((entry) => !entryMarked(entry));
    if (inner.length !== group['hooks'].length) {
      removed = true;
      // A group that held only our entry was our group — drop it entirely.
      if (inner.length > 0) kept.push({ ...group, hooks: inner });
      continue;
    }
    kept.push(group);
  }
  return { kept, removed };
}

/** What one harness writer wants written (the exact §9 table entries). */
export interface JsonWriterSpec {
  shape: HookShape;
  /** `hooks[event]` groups/entries to ensure. */
  desired: Record<string, unknown[]>;
  /** Top-level keys of a freshly created file, in order, before `hooks` (e.g. `{version: 1}`). */
  freshBase?: Record<string, unknown> | undefined;
  /** Own-file harnesses (Copilot): delete the file when removal leaves only the fresh base. */
  deleteWhenEmpty?: boolean | undefined;
  /** Extra notes appended to the result. */
  notes?: string[] | undefined;
}

/** The snippet printed for a config we refuse to rewrite (comment-bearing JSON). */
function manualSnippet(path: string, spec: JsonWriterSpec): string {
  return `# ${path} contains comments; add this to it manually:\n${JSON.stringify({ hooks: spec.desired }, null, 2)}`;
}

function errorOutcome(ctx: WriterContext, message: string, notes: string[]): WriterOutcome {
  return {
    result: makeResult(ctx, 'manual', { notes: [...notes, message] }),
    exit: 1,
    error: message,
  };
}

/**
 * The shared fs engine behind every JSON writer: read → classify → merge or
 * remove → back up → temp+rename write. Returns the `SetupResult` plus the
 * exit contribution (§12.2: 1 unreadable/unwritable, 3 manual). Under
 * `--dry-run` nothing is written and changing actions become `dry-run`.
 */
export function applyJsonWriter(ctx: WriterContext, spec: JsonWriterSpec): WriterOutcome {
  const path = ctx.target.path;
  const notes = spec.notes ?? [];

  let originalText: string | null = null;
  try {
    originalText = fs.readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return errorOutcome(ctx, `cannot read ${path} (${code ?? 'unknown error'})`, notes);
    }
  }

  let parsed: Record<string, unknown> | null = null;
  if (originalText !== null) {
    const classified = classifyJsonText(originalText);
    if (classified.kind === 'comments') {
      const message = `${path} contains comments; showreceipts never rewrites comment-bearing JSON — merge the printed snippet manually`;
      return {
        result: makeResult(ctx, 'manual', { notes: [...notes, message] }),
        exit: 3,
        snippet: manualSnippet(path, spec),
      };
    }
    if (classified.kind === 'malformed') {
      return errorOutcome(ctx, `${path} is not valid JSON — fix it (or --restore a backup) and re-run setup`, notes);
    }
    if (classified.kind === 'not-object') {
      return errorOutcome(ctx, `${path}: the JSON root is not an object — fix it and re-run setup`, notes);
    }
    parsed = classified.value;
  }

  const format: JsonFormat = originalText === null ? { indent: '  ', trailingNewline: true } : detectJsonFormat(originalText);

  try {
    if (ctx.remove) return removeFrom(ctx, spec, path, originalText, parsed, format, notes);
    return installInto(ctx, spec, path, originalText, parsed, format, notes);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return errorOutcome(ctx, `cannot write ${path} (${code ?? String(err)})`, notes);
  }
}

/** The `--remove` path: marker-matched deletion only (§9). */
function removeFrom(
  ctx: WriterContext,
  spec: JsonWriterSpec,
  path: string,
  originalText: string | null,
  parsed: Record<string, unknown> | null,
  format: JsonFormat,
  notes: string[],
): WriterOutcome {
  if (originalText === null || parsed === null) {
    return { result: makeResult(ctx, 'unchanged', { notes }), exit: 0 };
  }
  const value = cloneJson(parsed);
  const hooks = value['hooks'];
  let changed = false;
  if (isRecord(hooks)) {
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      const { kept, removed } = stripEvent(entries, spec.shape);
      if (!removed) continue;
      changed = true;
      if (kept.length === 0 && ctx.createdHooksKey) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0 && ctx.createdHooksKey) delete value['hooks'];
  }
  if (!changed) {
    return { result: makeResult(ctx, 'unchanged', { notes }), exit: 0 };
  }

  const deleteFile =
    spec.deleteWhenEmpty === true &&
    ctx.createdHooksKey &&
    stableStringify(value) === stableStringify(spec.freshBase ?? {});
  const newText = deleteFile ? '' : serializeJson(value, format);
  const diff = unifiedDiff(originalText, newText, path);
  let backup: string | null = null;
  if (!ctx.dryRun) {
    backup = ctx.backup(originalText);
    if (deleteFile) fs.unlinkSync(path);
    else atomicWriteFile(path, newText);
  }
  return {
    result: makeResult(ctx, ctx.dryRun ? 'dry-run' : 'removed', { backup, diff, notes }),
    exit: 0,
    createdHooksKey: ctx.dryRun ? undefined : false,
  };
}

/** The install path: strip every marked entry, then append the desired groups. */
function installInto(
  ctx: WriterContext,
  spec: JsonWriterSpec,
  path: string,
  originalText: string | null,
  parsed: Record<string, unknown> | null,
  format: JsonFormat,
  notes: string[],
): WriterOutcome {
  const base: Record<string, unknown> = parsed !== null ? cloneJson(parsed) : { ...(spec.freshBase ?? {}) };
  const hadHooksKey = parsed !== null && 'hooks' in parsed;
  let hooks: Record<string, unknown>;
  if (isRecord(base['hooks'])) {
    hooks = base['hooks'];
  } else {
    hooks = {};
    base['hooks'] = hooks;
  }

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const { kept, removed } = stripEvent(entries, spec.shape);
    if (!removed) continue;
    // An array we emptied was ours alone; keep it only when re-populated below.
    if (kept.length === 0 && !(event in spec.desired)) delete hooks[event];
    else hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(spec.desired)) {
    const existing = hooks[event];
    hooks[event] = Array.isArray(existing) ? [...existing, ...cloneJson(groups)] : cloneJson(groups);
  }

  const newText = serializeJson(base, format);
  if (originalText !== null && newText === originalText) {
    return {
      result: makeResult(ctx, 'unchanged', { notes }),
      exit: 0,
      createdHooksKey: ctx.createdHooksKey || !hadHooksKey ? true : undefined,
    };
  }
  const diff = unifiedDiff(originalText ?? '', newText, path);
  let backup: string | null = null;
  if (!ctx.dryRun) {
    fs.mkdirSync(dirname(path), { recursive: true });
    if (originalText !== null) backup = ctx.backup(originalText);
    atomicWriteFile(path, newText, originalText === null ? { mode: 0o600 } : {});
  }
  const action = ctx.dryRun ? 'dry-run' : originalText === null ? 'installed' : 'updated';
  return {
    result: makeResult(ctx, action, { backup, diff, notes }),
    exit: 0,
    createdHooksKey: ctx.dryRun ? undefined : !hadHooksKey || ctx.createdHooksKey,
  };
}
