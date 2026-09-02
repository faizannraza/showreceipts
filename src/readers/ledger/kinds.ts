/**
 * Appendix C tool-name → `ToolKind` maps per harness. The `kind` stored on a
 * ledger line by the hook is a hint only: the reader re-derives the kind here
 * from `(harness, tool)` at parse time (§4.4), so an outdated or hand-edited
 * ledger can never promote an unknown tool to a write — unknown names map to
 * `'other'`, never `'write'` or `'edit'`.
 */
import type { ToolKind } from '../../model/types.js';

/** Cursor hook events carry Cursor's capitalised tool names (§9, Appendix C). */
const CURSOR: Readonly<Record<string, ToolKind>> = {
  Shell: 'shell',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  afterFileEdit: 'edit',
};

/** Gemini CLI built-in tool names (Appendix C). */
const GEMINI: Readonly<Record<string, ToolKind>> = {
  run_shell_command: 'shell',
  write_file: 'write',
  replace: 'edit',
  read_file: 'read',
  glob: 'search',
  grep: 'search',
  web_fetch: 'fetch',
  google_web_search: 'fetch',
};

/** Copilot CLI tool names (§9 Copilot row). */
const COPILOT: Readonly<Record<string, ToolKind>> = {
  bash: 'shell',
  powershell: 'shell',
  create: 'write',
  edit: 'edit',
  view: 'read',
  glob: 'search',
  grep: 'search',
  web_fetch: 'fetch',
  task: 'agent',
};

/** Hermes tool names (Appendix C). */
const HERMES: Readonly<Record<string, ToolKind>> = {
  terminal: 'shell',
  write_file: 'write',
  edit_file: 'edit',
};

/**
 * dsh forwards Claude Code–shaped events (§9 dsh row: `PostToolUse` /
 * `PostToolUseFailure` with CC tool names), so it uses the Claude Code kind
 * map of §4.2.5.
 */
const DSH: Readonly<Record<string, ToolKind>> = {
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
  Workflow: 'agent',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskStop: 'task',
  Monitor: 'task',
  ListAgents: 'task',
  SendMessage: 'task',
  StructuredOutput: 'task',
};

const MAPS: Readonly<Record<string, Readonly<Record<string, ToolKind>>>> = {
  cursor: CURSOR,
  gemini: GEMINI,
  copilot: COPILOT,
  hermes: HERMES,
  dsh: DSH,
};

/**
 * The kind for `(harness, tool)` when the pair is a known Appendix C mapping
 * (including the `MCP:` / `mcp__` prefixes), else `null`. The reader counts a
 * `null` in `Diagnostics.unknownToolShapes` before falling back to `'other'`.
 */
export function lookupKind(harness: string, tool: string): ToolKind | null {
  if (harness === 'cursor' && tool.startsWith('MCP:')) return 'mcp';
  if (harness === 'dsh' && tool.startsWith('mcp__')) return 'mcp';
  const map = MAPS[harness];
  if (map === undefined) return null;
  return map[tool] ?? null;
}

/**
 * Re-derives the `ToolKind` for a ledger tool line from `(harness, tool)`
 * (§4.4: the stored `kind` is a hint). Unknown tool names — and every tool of
 * a harness without an Appendix C map — yield `'other'`, never a write kind.
 */
export function deriveKind(harness: string, tool: string): ToolKind {
  return lookupKind(harness, tool) ?? 'other';
}
