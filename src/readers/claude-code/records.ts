/**
 * Type guards for Claude Code transcript records (ARCHITECTURE §4.2.2) and
 * the §4.2.4 `toolUseResult` shapes. Every guard is total: wrong types,
 * `null` and missing keys return `false`, never throw. Extra keys are always
 * tolerated. Shapes that match no guard are counted by the caller in
 * `Diagnostics.unknownToolShapes[tool]`.
 */
import type { RawUsage } from '../../model/types.js';
import { isRecord } from '../../util/json.js';

/** The parsed line as a plain record, or `null` when it is not an object. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/** `v` when it is a string, else `null`. */
export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** `v` when it is a finite number, else `null`. */
export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A Bash `toolUseResult` success object (§4.2.4 row 1). */
export interface BashResultObject {
  stdout: string;
  stderr: string;
  interrupted?: unknown;
  isImage?: unknown;
  noOutputExpected?: unknown;
  returnCodeInterpretation?: unknown;
  gitOperation?: unknown;
  persistedOutputPath?: unknown;
  persistedOutputSize?: unknown;
  backgroundTaskId?: unknown;
  timedOutAfterMs?: unknown;
  [key: string]: unknown;
}

/** Bash success shape: an object with string `stdout` and `stderr`. */
export function isBashSuccess(v: unknown): v is BashResultObject {
  return isRecord(v) && typeof v['stdout'] === 'string' && typeof v['stderr'] === 'string';
}

/** Bash failure shape: the whole result is a string (`"Error: Exit code N…"`, denials). */
export function isBashErrorString(v: unknown): v is string {
  return typeof v === 'string';
}

/** An Edit `toolUseResult` (`filePath` + `oldString`/`newString`). */
export function isEditResult(v: unknown): v is Record<string, unknown> & { filePath: string } {
  return isRecord(v) && typeof v['filePath'] === 'string' && typeof v['oldString'] === 'string' && typeof v['newString'] === 'string';
}

/** A Write `toolUseResult` (`type: 'create' | 'update'` + `filePath`). */
export function isWriteResult(v: unknown): v is Record<string, unknown> & { type: 'create' | 'update'; filePath: string } {
  return isRecord(v) && (v['type'] === 'create' || v['type'] === 'update') && typeof v['filePath'] === 'string';
}

/** A MultiEdit `toolUseResult` (`filePath` + `edits[]`; legacy §4.2.9). */
export function isMultiEditResult(v: unknown): v is Record<string, unknown> & { filePath: string; edits: unknown[] } {
  return isRecord(v) && typeof v['filePath'] === 'string' && Array.isArray(v['edits']);
}

/** A NotebookEdit `toolUseResult` (`notebook_path`; unobserved, accepted per §4.2.4). */
export function isNotebookEditResult(v: unknown): v is Record<string, unknown> & { notebook_path: string } {
  return isRecord(v) && typeof v['notebook_path'] === 'string';
}

/** A Read `toolUseResult` (`type: text | image | pdf | parts`). */
export function isReadResult(v: unknown): v is Record<string, unknown> & { type: string } {
  if (!isRecord(v)) return false;
  const type = v['type'];
  return type === 'text' || type === 'image' || type === 'pdf' || type === 'parts';
}

/** An Agent `toolUseResult` (any object with a string `status`). */
export function isAgentResult(v: unknown): v is Record<string, unknown> & { status: string } {
  return isRecord(v) && typeof v['status'] === 'string';
}

/** The async-launch Agent shape (48/48 observed): `status: 'async_launched'` + `agentId`. */
export function isAgentAsyncResult(v: unknown): v is Record<string, unknown> & { status: 'async_launched'; agentId: string } {
  return isRecord(v) && v['status'] === 'async_launched' && typeof v['agentId'] === 'string';
}

/** A Workflow `toolUseResult` (`runId` + `transcriptDir` linkage data). */
export function isWorkflowResult(v: unknown): v is Record<string, unknown> & { runId: string } {
  return isRecord(v) && typeof v['runId'] === 'string';
}

/** The 2025 `Task` tool result (`content[]` + `totalDurationMs`/`totalToolUseCount`, §4.2.9). */
export function isLegacyTaskResult(v: unknown): v is Record<string, unknown> & { content: unknown[] } {
  return isRecord(v) && Array.isArray(v['content']) && (typeof v['totalDurationMs'] === 'number' || typeof v['totalToolUseCount'] === 'number');
}

/** An `mcp__*` result: a list of content blocks, or a plain string (§4.2.4 last row). */
export function isMcpResult(v: unknown): v is unknown[] | string {
  return Array.isArray(v) || typeof v === 'string';
}

/** The Anthropic usage object as logged (tolerant: only `input_tokens`/`output_tokens` are required). */
export function isRawUsage(v: unknown): v is RawUsage {
  return isRecord(v) && typeof v['input_tokens'] === 'number' && typeof v['output_tokens'] === 'number';
}

/** Tools whose `toolUseResult` shape is pinned by §4.2.4 (an unmatched shape is a diagnostic). */
const SHAPED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Agent', 'Task', 'Workflow']);

/**
 * Whether a present `toolUseResult` matches a known shape for `tool`.
 * Tools outside the §4.2.4 shape table accept anything (`true`); for the
 * shaped tools an unmatched value means `unknown-shape` and the caller
 * increments `Diagnostics.unknownToolShapes[tool]`.
 */
export function resultShapeKnown(tool: string, result: unknown): boolean {
  if (!SHAPED_TOOLS.has(tool)) return true;
  if (typeof result === 'string') return true; // error / denial strings are a known shape everywhere
  switch (tool) {
    case 'Bash':
      return isBashSuccess(result);
    case 'Edit':
      return isEditResult(result) || isMultiEditResult(result);
    case 'Write':
      return isWriteResult(result);
    case 'MultiEdit':
      return isMultiEditResult(result);
    case 'NotebookEdit':
      return isNotebookEditResult(result);
    case 'Read':
      return isReadResult(result);
    case 'Agent':
    case 'Task':
      return isAgentResult(result) || isLegacyTaskResult(result);
    case 'Workflow':
      return isWorkflowResult(result);
    default:
      return true;
  }
}
