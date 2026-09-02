/**
 * `apply_patch` parsing for the Codex reader (ARCHITECTURE §4.3.4).
 *
 * A patch is a `*** Begin Patch` … `*** End Patch` block with `Add File:`,
 * `Update File:` (+ optional `Move to:`) and `Delete File:` headers, `@@`
 * hunks and `±` lines. Writes are gated on the **output**, never on the
 * item's `status` (the one observed failed patch also carries
 * `status:'completed'`): success iff the output's `exit_code === 0` and its
 * body starts with `Success.`; `filesTouched` comes from the body's
 * `/^([AMD]) (.+)$/` lines (authoritative), falling back to the input
 * headers. A failed patch keeps its attempted paths in `attempted[]` and is
 * never a write. The same grammar covers a patch delivered through
 * `exec_command`/`shell_command` whose command text starts with
 * `apply_patch` (heredoc body or argv[1]).
 */
import { isRecord, parseJsonSafe } from '../../util/json.js';

const BEGIN_MARKER = '*** Begin Patch';
const END_MARKER = '*** End Patch';
const ADD_RE = /^\*\*\* Add File: (.+)$/;
const UPDATE_RE = /^\*\*\* Update File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;
const DELETE_RE = /^\*\*\* Delete File: (.+)$/;
const TOUCHED_LINE_RE = /^([AMD]) (.+)$/gm;
const APPLY_PATCH_COMMAND_RE = /^\s*apply_patch\b/;

/** Total `±` lines kept on a `ToolCall.patch` before it is truncated (mirrors S06). */
const MAX_PATCH_LINES = 2000;

/** One file operation named by the patch headers. */
export interface PatchFileOp {
  verb: 'create' | 'update' | 'delete';
  path: string;
  /** `*** Move to:` target of an update (write `movedTo`, delete `path`). */
  movedTo?: string;
}

/** A parsed `*** Begin Patch` block. */
export interface ParsedPatch {
  ops: PatchFileOp[];
  /** `+` line bodies, capped at {@link MAX_PATCH_LINES} combined with `removed`. */
  added: string[];
  /** `-` line bodies. */
  removed: string[];
  /** Number of `@@` hunk markers. */
  hunks: number;
  /** The `±` cap was hit; `added`/`removed` are incomplete. */
  truncated: boolean;
}

/**
 * Parses the first `*** Begin Patch` block found in `text`. Returns `null`
 * when there is none. Header lines never count as `±` lines; `±` collection
 * stops (with `truncated:true`) at {@link MAX_PATCH_LINES} combined lines.
 */
export function parsePatchText(text: string): ParsedPatch | null {
  const begin = text.indexOf(BEGIN_MARKER);
  if (begin === -1) return null;
  const end = text.indexOf(END_MARKER, begin);
  const inner = end === -1 ? text.slice(begin) : text.slice(begin, end);
  const patch: ParsedPatch = { ops: [], added: [], removed: [], hunks: 0, truncated: false };
  for (let line of inner.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('***')) {
      const add = ADD_RE.exec(line);
      if (add?.[1] !== undefined) {
        patch.ops.push({ verb: 'create', path: add[1].trim() });
        continue;
      }
      const update = UPDATE_RE.exec(line);
      if (update?.[1] !== undefined) {
        patch.ops.push({ verb: 'update', path: update[1].trim() });
        continue;
      }
      const move = MOVE_RE.exec(line);
      if (move?.[1] !== undefined) {
        const last = patch.ops.at(-1);
        if (last !== undefined && last.verb === 'update') last.movedTo = move[1].trim();
        continue;
      }
      const del = DELETE_RE.exec(line);
      if (del?.[1] !== undefined) patch.ops.push({ verb: 'delete', path: del[1].trim() });
      continue;
    }
    if (line.startsWith('@@')) {
      patch.hunks++;
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (patch.added.length + patch.removed.length >= MAX_PATCH_LINES) {
        patch.truncated = true;
        continue;
      }
      (line.startsWith('+') ? patch.added : patch.removed).push(line.slice(1));
    }
  }
  return patch;
}

/**
 * The patch text carried by an `exec_command`/`shell_command` whose command
 * text starts with `apply_patch` — a heredoc body or a quoted argv[1] — or
 * `null` when the command is not an `apply_patch` invocation or carries no
 * patch block.
 */
export function extractPatchFromCommand(command: string): string | null {
  if (!APPLY_PATCH_COMMAND_RE.test(command)) return null;
  return command.includes(BEGIN_MARKER) ? command : null;
}

/**
 * The paths a patch's input headers name, in order of appearance (an update
 * with `Move to:` contributes the target then the source), deduplicated.
 * These are the `attempted[]` paths of a failed patch and the
 * `filesTouched` fallback of a successful one.
 */
export function headerPaths(patch: ParsedPatch): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  for (const op of patch.ops) {
    if (op.movedTo !== undefined) {
      push(op.movedTo);
      push(op.path);
    } else {
      push(op.path);
    }
  }
  return out;
}

/** How one `apply_patch` execution went (paths are raw, not yet canonicalised). */
export interface PatchOutcome {
  ok: boolean;
  exitCode: number | null;
  isError: boolean;
  /** Paths touched by a successful patch (`[AMD]` output lines, else input headers). */
  filesTouched: string[];
  /** Paths a failed patch tried to touch — never counted as writes. */
  attempted: string[];
  /** The output body (for `resultText`). */
  body: string;
}

/**
 * Gates a patch on its output body and exit code (§4.3.4): success iff
 * `exitCode === 0` and the body starts with `Success.`. On success the
 * body's `[AMD]` lines are the authoritative `filesTouched` (input headers
 * are the fallback); on failure `filesTouched` is empty, the attempted
 * header paths are kept and `exitCode` defaults to `1` when unreported.
 */
export function patchOutcome(patch: ParsedPatch | null, body: string, exitCode: number | null): PatchOutcome {
  const headers = patch === null ? [] : headerPaths(patch);
  const ok = exitCode === 0 && body.startsWith('Success.');
  if (!ok) {
    return { ok: false, exitCode: exitCode ?? 1, isError: true, filesTouched: [], attempted: headers, body };
  }
  const touched: string[] = [];
  TOUCHED_LINE_RE.lastIndex = 0;
  for (let m = TOUCHED_LINE_RE.exec(body); m !== null; m = TOUCHED_LINE_RE.exec(body)) {
    const p = m[2];
    if (p !== undefined && !touched.includes(p)) touched.push(p);
  }
  return { ok: true, exitCode: 0, isError: false, filesTouched: touched.length > 0 ? touched : headers, attempted: [], body };
}

/**
 * The outcome of a `custom_tool_call_output` (§4.3.4): the output is either a
 * JSON string `{output, metadata{exit_code}}` — gated through
 * {@link patchOutcome} — or plain text (`apply_patch verification failed: …`)
 * ⇒ `isError:true`, `exitCode:1`, attempted paths kept.
 */
export function customPatchOutcome(patch: ParsedPatch | null, rawOutput: string): PatchOutcome {
  const json = parseJsonSafe(rawOutput);
  if (isRecord(json) && typeof json['output'] === 'string' && isRecord(json['metadata'])) {
    const exit = json['metadata']['exit_code'];
    if (typeof exit === 'number' && Number.isFinite(exit)) return patchOutcome(patch, json['output'], exit);
  }
  return {
    ok: false,
    exitCode: 1,
    isError: true,
    filesTouched: [],
    attempted: patch === null ? [] : headerPaths(patch),
    body: rawOutput,
  };
}
