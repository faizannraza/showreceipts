/**
 * Tool-call pairing, exit codes and truncation (ARCHITECTURE §4.2.5).
 * `tool_use` blocks open a `ToolCall` (its `seq`, `cwd` and `startedAt` come
 * from the assistant line and the *preceding user line's* cwd, §4.5.3); the
 * matching `tool_result` completes it. Bash exit rules (a)–(j) run in order;
 * Edit/Write results yield `filesTouched` and a `patch` of changed lines
 * only — file bodies (`originalFile`, `content`, `base64`) are discarded
 * immediately and never stored.
 */
import type { ToolCall, ToolKind } from '../../model/types.js';
import {
  asNumber,
  asRecord,
  asString,
  isAgentAsyncResult,
  isAgentResult,
  isBashErrorString,
  isBashSuccess,
  isEditResult,
  isLegacyTaskResult,
  isMultiEditResult,
  isNotebookEditResult,
  isReadResult,
  isWorkflowResult,
  isWriteResult,
  resultShapeKnown,
} from './records.js';

/** `resultText` cap (§4.2.5 as amended by S06: 1 MiB here; S18 trims to 4 KB head/tail after the ledger parsers ran). */
export const RESULT_TEXT_CAP = 1 << 20;
const RESULT_HEAD = 1 << 19;
const RESULT_TAIL = 1 << 19;
/** `mcp__*` results are normalised to text no longer than this (§4.2.4). */
export const MCP_TEXT_CAP = 8 * 1024;
/** A `ToolCall.patch` keeps at most this many `+`/`-` lines in total (§4.2.5). */
export const PATCH_LINE_CAP = 2000;

/** Input keys retained on `ToolCall.input` (§4.2.5). */
export const INPUT_KEYS: readonly string[] = [
  'command',
  'description',
  'timeout',
  'run_in_background',
  'dangerouslyDisableSandbox',
  'file_path',
  'pattern',
  'path',
  'url',
];

const KIND_BY_TOOL: Readonly<Record<string, ToolKind>> = {
  Bash: 'shell',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Agent: 'agent',
  Task: 'agent',
  Workflow: 'agent',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskStop: 'task',
  Monitor: 'task',
  ListAgents: 'task',
  SendMessage: 'task',
  StructuredOutput: 'task',
};

/** The §4.2.5 tool → kind map (`mcp__*` → `mcp`, unknown → `other`). */
export function toolKindOf(tool: string): ToolKind {
  if (tool.startsWith('mcp__')) return 'mcp';
  return KIND_BY_TOOL[tool] ?? 'other';
}

const EXIT_CODE_RE = /^Error: Exit code (\d+)/;
const CONTENT_EXIT_RE = /^Exit code (\d+)/;
const DENIAL_RE =
  /^(?:<tool_use_error>)?(?:Error: Permission|User rejected|Error: The user doesn't|Error: Blocked:|Error: This agent is isolated|InputValidationError)/;
const CWD_RESET_RE = /\n?Shell cwd was reset to ([^\n]+)$/;

/** Diagnostic hooks `completeToolCall` reports through (wired by the builder). */
export interface ToolDiag {
  legacy(shape: string): void;
  unknownShape(tool: string): void;
  bashWithoutToolUseResult(): void;
}

/** Linkage data an `Agent`/`Workflow` result seeds for the S07 merge (§4.2.6). */
export interface SpawnSeed {
  tool: 'Agent' | 'Workflow';
  toolUseId: string;
  seq: number;
  agentId: string | null;
  runId: string | null;
  transcriptDir: string | null;
  description: string | null;
  resolvedModel: string | null;
  workflowName: string | null;
  isAsync: boolean;
  startedAt: string;
  endedAt: string;
}

/**
 * Caps a result text at 1 Mi UTF-16 code units: head 512 Ki + `…` + tail
 * 512 Ki (§4.2.5). The cap is a memory bound in code units, not bytes: a
 * multibyte-heavy string within the code-unit cap is kept whole — slicing it
 * into head + tail would overlap and duplicate the middle (S06 review).
 */
export function capResultText(s: string): { text: string; truncated: boolean } {
  if (s.length <= RESULT_TEXT_CAP) return { text: s, truncated: false };
  let head = s.slice(0, RESULT_HEAD);
  const headLast = head.charCodeAt(head.length - 1);
  if (headLast >= 0xd800 && headLast <= 0xdbff) head = head.slice(0, -1);
  let tail = s.slice(-RESULT_TAIL);
  const tailFirst = tail.charCodeAt(0);
  if (tailFirst >= 0xdc00 && tailFirst <= 0xdfff) tail = tail.slice(1);
  return { text: `${head}…${tail}`, truncated: true };
}

/** Joined `text` items of a `tool_result` content value (string or block list). */
export function resultContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block !== null && typeof block['text'] === 'string') parts.push(block['text']);
  }
  return parts.join('\n');
}

/** Normalises an `mcp__*` result (block list / JSON string / anything) to text ≤ 8 KB; images are dropped. */
export function normalizeMcpText(result: unknown, fallback: string): { text: string; truncated: boolean } {
  let text = fallback;
  if (typeof result === 'string') text = result;
  else if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const item of result) {
      const block = asRecord(item);
      if (block !== null && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
    }
    text = parts.join('\n');
  }
  if (text.length <= MCP_TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, MCP_TEXT_CAP), truncated: true };
}

/** The whitelisted input subset (§4.2.5). */
export function pickInput(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  if (record === null) return {};
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

/** Constructs the open `ToolCall` for one `tool_use` block (§4.2.5). */
export function newToolCall(args: {
  seq: number;
  id: string;
  tool: string;
  input: unknown;
  agentId: string | null;
  cwd: string;
  startedAt: string;
}): ToolCall {
  const input = pickInput(args.input);
  const call: ToolCall = {
    seq: args.seq,
    id: args.id,
    tool: args.tool,
    kind: toolKindOf(args.tool),
    agentId: args.agentId,
    turnIndex: -1,
    cwd: args.cwd,
    input,
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: null,
    exitCodeSource: 'unknown',
    interrupted: false,
    background: false,
    startedAt: args.startedAt,
    endedAt: null,
    filesTouched: [],
  };
  const command = asString(input['command']);
  if (command !== null) call.command = command;
  const description = asString(input['description']);
  if (description !== null) call.description = description;
  if (input['dangerouslyDisableSandbox'] === true) call.sandboxDisabled = true; // rule (j)
  return call;
}

/** The non-optional shape of `ToolCall.patch`. */
type Patch = NonNullable<ToolCall['patch']>;

function patchFromLines(added: string[], removed: string[], hunks: number): Patch {
  let truncated = false;
  if (added.length + removed.length > PATCH_LINE_CAP) {
    truncated = true;
    const keepAdded = Math.min(added.length, PATCH_LINE_CAP);
    added = added.slice(0, keepAdded);
    removed = removed.slice(0, PATCH_LINE_CAP - keepAdded);
  }
  const patch: Patch = { added, removed, hunks };
  if (truncated) patch.truncated = true;
  return patch;
}

/** `ToolCall.patch` from `structuredPatch[].lines` (`+`/`-` lines only, ≤ 2,000). */
export function patchFromStructured(structuredPatch: unknown): Patch | null {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  const added: string[] = [];
  const removed: string[] = [];
  let hunks = 0;
  for (const hunk of structuredPatch) {
    const record = asRecord(hunk);
    const lines = record?.['lines'];
    if (!Array.isArray(lines)) continue;
    hunks++;
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
  }
  if (hunks === 0) return null;
  return patchFromLines(added, removed, hunks);
}

/**
 * Line-wise diff of a Write `update` without a `structuredPatch`: common
 * prefix/suffix stripped, the differing middles become the `-`/`+` lines
 * (§4.2.5). Bodies are read here once and discarded by the caller.
 */
export function diffPatch(originalFile: string, content: string): Patch | null {
  const o = originalFile.split('\n');
  const n = content.split('\n');
  let prefix = 0;
  while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) prefix++;
  let suffix = 0;
  while (suffix < o.length - prefix && suffix < n.length - prefix && o[o.length - 1 - suffix] === n[n.length - 1 - suffix]) suffix++;
  const removed = o.slice(prefix, o.length - suffix);
  const added = n.slice(prefix, n.length - suffix);
  if (removed.length === 0 && added.length === 0) return null;
  return patchFromLines(added, removed, 1);
}

function applyDenial(call: ToolCall, toolDenialKind: unknown, fromString: boolean): boolean {
  const kind = asString(toolDenialKind);
  if (kind === 'permission-rule' || kind === 'user-rejected' || kind === 'automode-blocked' || kind === 'sandbox-denied') {
    call.denied = kind;
  } else if (kind !== null) {
    // §4.2.5 (b): toolDenialKind PRESENT ⇒ denied, whatever the kind — an
    // unknown (future) value falls back to 'tool_use_error'.
    call.denied = 'tool_use_error';
  } else if (fromString) {
    call.denied = 'tool_use_error';
  } else {
    return false;
  }
  call.exitCode = null;
  call.exitCodeSource = 'unknown';
  return true;
}

function completeBash(call: ToolCall, result: unknown, hasResult: boolean, isError: boolean, toolDenialKind: unknown, diag: ToolDiag): void {
  if (!hasResult) {
    // (f) — subagent results without `toolUseResult`: exit from the content string.
    diag.bashWithoutToolUseResult();
    if (applyDenial(call, toolDenialKind, DENIAL_RE.test(call.resultText))) return;
    if (isError) {
      const m = CONTENT_EXIT_RE.exec(call.resultText.replace(/^<tool_use_error>/, ''));
      call.exitCode = m?.[1] !== undefined ? Number(m[1]) : null;
    } else {
      call.exitCode = 0;
    }
    call.exitCodeSource = 'content';
    return;
  }
  if (isBashErrorString(result)) {
    const exit = EXIT_CODE_RE.exec(result);
    if (exit?.[1] !== undefined) {
      // (a)
      call.exitCode = Number(exit[1]);
      call.exitCodeSource = 'harness';
      return;
    }
    // (b) — denied is never a run.
    if (applyDenial(call, toolDenialKind, DENIAL_RE.test(result))) return;
    call.exitCode = null;
    call.exitCodeSource = 'unknown';
    return;
  }
  if (!isBashSuccess(result)) {
    diag.unknownShape(call.tool);
    applyDenial(call, toolDenialKind, false);
    return;
  }
  // A denial recorded alongside an object result (unobserved) still wins.
  if (applyDenial(call, toolDenialKind, false)) return;
  const interpretation = asString(result['returnCodeInterpretation']);
  const backgroundTaskId = asString(result['backgroundTaskId']);
  const timedOutAfterMs = asNumber(result['timedOutAfterMs']);
  const stderr = result.stderr;
  const reset = CWD_RESET_RE.exec(stderr);
  if (reset?.[1] !== undefined) {
    call.cwdReset = reset[1];
    call.resultText = call.resultText.replace(CWD_RESET_RE, '');
  }
  if (interpretation !== null) {
    // (c)
    call.exitCode = null;
    call.exitCodeSource = 'interpreted';
    call.interpretation = interpretation;
  } else if (backgroundTaskId !== null || timedOutAfterMs !== null) {
    // (d) — exit arrives later via a `<task-notification>`.
    call.exitCode = null;
    call.exitCodeSource = 'unknown';
  } else if (result['interrupted'] === true) {
    // (e)
    call.interrupted = true;
    call.exitCode = null;
    call.exitCodeSource = 'unknown';
  } else {
    // (g)
    call.exitCode = 0;
    call.exitCodeSource = 'harness';
  }
  if (backgroundTaskId !== null) {
    call.background = true;
    call.backgroundTaskId = backgroundTaskId;
  }
  if (timedOutAfterMs !== null) {
    call.background = true;
    call.timedOutAfterMs = timedOutAfterMs;
  }
  if (result['interrupted'] === true) call.interrupted = true;
  const persistedPath = asString(result['persistedOutputPath']);
  if (persistedPath !== null) {
    // (h) — v1 never reads the persisted file (§13.1 boundary).
    call.truncated = 'persisted';
    const size = asNumber(result['persistedOutputSize']);
    if (size !== null) call.persistedBytes = size;
  }
  const gitOperation = asRecord(result['gitOperation']);
  const commit = gitOperation === null ? null : asRecord(gitOperation['commit']);
  if (commit !== null) {
    // (i) — the `GitFact` itself is S12's job.
    const sha = asString(commit['sha']);
    const kind = commit['kind'] === 'amended' ? 'amended' : 'committed';
    if (sha !== null) call.gitOperation = { sha, kind };
  }
}

function completeEditLike(call: ToolCall, result: unknown, diag: ToolDiag): void {
  if (typeof result === 'string' || result === undefined) return;
  if (isEditResult(result)) {
    call.filesTouched = [result.filePath];
    if (typeof result['userModified'] === 'boolean') call.userModified = result['userModified'];
    const patch = patchFromStructured(result['structuredPatch']);
    if (patch !== null) call.patch = patch;
    return;
  }
  if (isWriteResult(result)) {
    call.filesTouched = [result.filePath];
    if (typeof result['userModified'] === 'boolean') call.userModified = result['userModified'];
    let patch = patchFromStructured(result['structuredPatch']);
    if (patch === null && result.type === 'update') {
      const original = asString(result['originalFile']);
      const content = asString(result['content']);
      if (original !== null && content !== null) patch = diffPatch(original, content);
    }
    if (patch !== null) call.patch = patch;
    return;
  }
  if (isMultiEditResult(result)) {
    diag.legacy('MultiEdit');
    call.filesTouched = [result.filePath];
    if (typeof result['userModified'] === 'boolean') call.userModified = result['userModified'];
    const patch = patchFromStructured(result['structuredPatch']);
    if (patch !== null) call.patch = patch;
    return;
  }
  if (isNotebookEditResult(result)) {
    diag.legacy('NotebookEdit');
    call.filesTouched = [result.notebook_path];
    return;
  }
  diag.unknownShape(call.tool);
}

function completeRead(call: ToolCall, result: unknown, diag: ToolDiag): void {
  if (typeof result === 'string' || result === undefined) return;
  if (!isReadResult(result)) {
    diag.unknownShape(call.tool);
    return;
  }
  // `filesTouched` only when `file.filePath` exists; base64/content never retained.
  const file = asRecord(result['file']);
  const filePath = file === null ? null : asString(file['filePath']);
  if (filePath !== null) call.filesTouched = [filePath];
}

function completeAgent(call: ToolCall, result: unknown, ts: string, diag: ToolDiag): SpawnSeed | null {
  if (typeof result === 'string' || result === undefined) return null;
  if (isAgentAsyncResult(result)) {
    call.background = true;
    call.backgroundTaskId = result.agentId;
    return {
      tool: 'Agent',
      toolUseId: call.id,
      seq: call.seq,
      agentId: result.agentId,
      runId: null,
      transcriptDir: null,
      description: asString(result['description']),
      resolvedModel: asString(result['resolvedModel']),
      workflowName: null,
      isAsync: true,
      startedAt: call.startedAt,
      endedAt: ts,
    };
  }
  if (isLegacyTaskResult(result)) {
    // 2025 `Task` result: the content text *is* the agent result (§4.2.9).
    diag.legacy('task-result');
    return null;
  }
  if (isAgentResult(result)) return null; // non-async status: content text is the agent result
  diag.unknownShape(call.tool);
  return null;
}

function completeWorkflow(call: ToolCall, result: unknown, ts: string, diag: ToolDiag): SpawnSeed | null {
  if (typeof result === 'string' || result === undefined) return null;
  if (!isWorkflowResult(result)) {
    diag.unknownShape(call.tool);
    return null;
  }
  const taskId = asString(result['taskId']);
  call.background = true;
  call.backgroundTaskId = taskId ?? result.runId;
  return {
    tool: 'Workflow',
    toolUseId: call.id,
    seq: call.seq,
    agentId: null,
    runId: result.runId,
    transcriptDir: asString(result['transcriptDir']),
    description: asString(result['summary']),
    resolvedModel: null,
    workflowName: asString(result['workflowName']),
    isAsync: true,
    startedAt: call.startedAt,
    endedAt: ts,
  };
}

/**
 * Completes an open `ToolCall` from its `tool_result` line (§4.2.5):
 * `resultText` (full content, capped at 1 MiB with head/tail halves),
 * `resultBytes`, error/denial state, the Bash exit rules (a)–(j), Edit/Write
 * `filesTouched` + `patch`, Read `filesTouched`, `mcp__*` normalisation, and
 * `Agent`/`Workflow` spawn seeds for the S07 merge. Returns the seed when
 * the result launched a subagent. Never throws on malformed results.
 */
export function completeToolCall(
  call: ToolCall,
  params: { ts: string; content: unknown; isError: boolean; hasToolUseResult: boolean; toolUseResult: unknown; toolDenialKind: unknown },
  diag: ToolDiag,
): SpawnSeed | null {
  call.endedAt = params.ts;
  call.isError = params.isError;
  const rawText = resultContentText(params.content);
  call.resultBytes = Buffer.byteLength(rawText, 'utf8');
  if (call.kind === 'mcp') {
    const mcp = normalizeMcpText(params.hasToolUseResult ? params.toolUseResult : rawText, rawText);
    call.resultText = mcp.text;
    if (mcp.truncated) call.truncated = 'showreceipts';
    if (applyDenial(call, params.toolDenialKind, DENIAL_RE.test(call.resultText))) return null;
    return null;
  }
  const capped = capResultText(rawText);
  call.resultText = capped.text;
  if (capped.truncated) call.truncated = 'showreceipts';

  const result = params.hasToolUseResult ? params.toolUseResult : undefined;
  if (call.tool === 'Bash') {
    completeBash(call, result, params.hasToolUseResult, params.isError, params.toolDenialKind, diag);
    return null;
  }
  // Non-Bash denial detection (toolDenialKind, or a denial string result).
  const stringResult = typeof result === 'string' ? result : null;
  if (applyDenial(call, params.toolDenialKind, DENIAL_RE.test(stringResult ?? (params.isError ? call.resultText : '')))) return null;
  switch (call.kind) {
    case 'edit':
    case 'write':
      completeEditLike(call, result, diag);
      return null;
    case 'read':
      completeRead(call, result, diag);
      return null;
    case 'agent':
      if (call.tool === 'Workflow') return completeWorkflow(call, result, params.ts, diag);
      return completeAgent(call, result, params.ts, diag);
    default:
      if (result !== undefined && !resultShapeKnown(call.tool, result)) diag.unknownShape(call.tool);
      return null;
  }
}
