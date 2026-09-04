/**
 * The demo generator (ARCHITECTURE §14.1, PLAN S23a): lowers a {@link Scenario}
 * to the exact record shapes the readers verify — Appendix A Claude Code
 * lines (uuids, promptIds, usage objects with cache buckets, per-tool
 * `toolUseResult`, `turn_duration`, `compact_boundary` + summary, subagent
 * files with `.meta.json` equivalents), Appendix B Codex rollouts
 * (`session_meta`, `turn_context`, `user_message`/`agent_message`,
 * `exec_command` outputs in the header grammar, `token_count` totals) and
 * Appendix C hook-captured ledger lines.
 *
 * Deterministic by construction: timestamps derive from `startedAt` plus the
 * scenario's minute offsets, ids from counters and the seeded PRNG — no
 * wall clock, no `Math.random`, no environment, no filesystem.
 */
import type { Harness, LineSource, RawUsage } from '../model/types.js';
import type { DemoCommand, DemoEdit, DemoSubagent, Scenario } from './dsl.js';
import { distribute, prng } from './prng.js';

/** What {@link generate} returns; ledger scenarios set both `lines` and `ledger` to the same source. */
export interface Generated {
  harness: Harness;
  lines: LineSource;
  subagents?: Map<string, LineSource>;
  ledger?: LineSource;
}

/** ISO UTC instant `min` minutes after `baseMs`. */
function iso(baseMs: number, min: number): string {
  return new Date(baseMs + Math.round(min * 60_000)).toISOString();
}

/** UTF-8 byte length without importing `node:buffer` (demo imports no builtins). */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Joins JSONL lines with a trailing newline. */
function jsonl(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** A full Anthropic usage object (§4.2.7 shape) from bucket totals. */
function usageObject(input: number, cacheRead: number, w5: number, w1: number, output: number): RawUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: w5 + w1,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
    service_tier: 'standard',
  };
}

/** One scheduled emission of the Claude Code / Codex event loop. */
type DemoEvent =
  | { at: number; ord: number; kind: 'edit'; edit: DemoEdit }
  | { at: number; ord: number; kind: 'command'; command: DemoCommand }
  | { at: number; ord: number; kind: 'read' }
  | { at: number; ord: number; kind: 'agent'; sub: DemoSubagent };

/** The scenario's events, time-ordered (stable on ties). */
function scheduleEvents(s: Scenario): DemoEvent[] {
  const events: DemoEvent[] = [];
  let ord = 0;
  for (const edit of s.edits) events.push({ at: edit.at, ord: ord++, kind: 'edit', edit });
  for (const command of s.commands) events.push({ at: command.at, ord: ord++, kind: 'command', command });
  for (const sub of s.subagents ?? []) events.push({ at: 1 + ord * 0.01, ord: ord++, kind: 'agent', sub });
  const fillers = s.fillerReads ?? 0;
  for (let i = 1; i <= fillers; i++) {
    events.push({ at: (s.durationMin * i) / (fillers + 2), ord: ord++, kind: 'read' });
  }
  return events.sort((a, b) => a.at - b.at || a.ord - b.ord);
}

/** The absolute form of a scenario path (relative paths live under `cwd`). */
function absPath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Emits one Claude Code main transcript (+ subagent files) per Appendix A. */
function generateClaudeCode(s: Scenario): Generated {
  const rng = prng(s.sessionId);
  const baseMs = Date.parse(s.startedAt);
  const lines: string[] = [];
  const subagentFiles = new Map<string, LineSource>();
  let n = 0;
  let lastUuid: string | null = null;

  const nextId = (prefix: string): string => `${prefix}-${String(++n).padStart(4, '0')}`;
  const common = (min: number): Record<string, unknown> => ({
    isSidechain: false,
    timestamp: iso(baseMs, min),
    cwd: s.cwd,
    sessionId: s.sessionId,
    version: s.harnessVersion,
    ...(s.branch === null ? {} : { gitBranch: s.branch }),
    userType: 'external',
  });
  const push = (record: Record<string, unknown>, uuid: string | null): void => {
    lines.push(JSON.stringify(record));
    if (uuid !== null) lastUuid = uuid;
  };

  if (s.noTurns === true) {
    // Header-only records (the 2.1.243 shape): recognised types, no turns.
    const types = ['mode', 'permission-mode', 'last-prompt', 'agent-name', 'atis-latch'];
    for (let i = 0; i < 13; i++) {
      const type = types[i % types.length] as string;
      const record: Record<string, unknown> =
        i >= 10
          ? { type: 'queue-operation', operation: 'enqueue', content: 'queued demo prompt', sessionId: s.sessionId, timestamp: iso(baseMs, i * 0.05) }
          : { type, sessionId: s.sessionId, timestamp: iso(baseMs, i * 0.05) };
      push(record, null);
    }
    return { harness: 'claude-code', lines: { kind: 'text', text: jsonl(lines), name: `${s.sessionId}.jsonl` } };
  }

  const events = scheduleEvents(s);
  // Billed assistant messages: one per event, plus the final (or the dangling partial).
  const messages = events.length + 1;
  const profile = s.usageProfile ?? {
    input: messages * 10,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: messages * 5,
  };
  const shares = {
    input: distribute(profile.input, messages),
    cacheRead: distribute(profile.cacheRead, messages),
    w5: distribute(profile.cacheWrite5m, messages),
    w1: distribute(profile.cacheWrite1h, messages),
    output: distribute(profile.output, messages),
  };
  let usageIdx = 0;
  const nextUsage = (): RawUsage => {
    const i = usageIdx++;
    return usageObject(shares.input[i] ?? 0, shares.cacheRead[i] ?? 0, shares.w5[i] ?? 0, shares.w1[i] ?? 0, shares.output[i] ?? 0);
  };

  /** An assistant line carrying content blocks (chained onto the previous line). */
  const assistant = (min: number, content: unknown[], stop: string | null, usage: RawUsage, extra: Record<string, unknown> = {}): string => {
    const uuid = nextId('u');
    push(
      {
        type: 'assistant',
        uuid,
        parentUuid: lastUuid,
        requestId: `req-${uuid}`,
        message: {
          id: `msg-${uuid}`,
          type: 'message',
          role: 'assistant',
          model: s.model,
          stop_reason: stop,
          stop_sequence: null,
          content,
          usage,
        },
        ...extra,
        ...common(min),
      },
      uuid,
    );
    return uuid;
  };

  /** A `tool_result` user line paired to `toolUseId`. */
  const toolResult = (min: number, toolUseId: string, content: unknown, result: unknown, isError: boolean): void => {
    const uuid = nextId('u');
    push(
      {
        type: 'user',
        uuid,
        parentUuid: lastUuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
        ...(result === undefined ? {} : { toolUseResult: result }),
        ...common(min),
      },
      uuid,
    );
  };

  /** One tool call: assistant `tool_use` + result line. */
  const toolCall = (min: number, tool: string, input: Record<string, unknown>, content: unknown, result: unknown, isError = false): string => {
    const toolUseId = nextId('tu');
    assistant(min, [{ type: 'tool_use', id: toolUseId, name: tool, input }], 'tool_use', nextUsage());
    toolResult(min + 0.01, toolUseId, content, result, isError);
    return toolUseId;
  };

  const emitEdit = (min: number, edit: DemoEdit): void => {
    const filePath = absPath(s.cwd, edit.path);
    if (edit.verb === 'create') {
      toolCall(
        min,
        'Write',
        { file_path: filePath, content: '# generated by the showreceipts demo\n' },
        `File created successfully at: ${filePath}`,
        { type: 'create', filePath, content: '# generated by the showreceipts demo\n', structuredPatch: [], userModified: false },
      );
      return;
    }
    const patchLines = ['-value = 1', '+value = 2', ...(edit.addedLines ?? [])];
    toolCall(
      min,
      'Edit',
      { file_path: filePath, old_string: 'value = 1', new_string: 'value = 2' },
      'Applied 1 edit',
      {
        filePath,
        oldString: 'value = 1',
        newString: 'value = 2',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: patchLines.filter((l) => l.startsWith('+')).length, lines: patchLines },
        ],
        userModified: false,
      },
    );
  };

  const emitCommand = (min: number, command: DemoCommand): void => {
    const input = { command: command.cmd };
    if (command.exit === null) {
      toolCall(min, 'Bash', input, command.out, {
        stdout: command.out,
        stderr: '',
        interrupted: false,
        isImage: false,
        backgroundTaskId: nextId('bg'),
      });
      return;
    }
    if (command.exit !== 0) {
      const text = `Error: Exit code ${command.exit}\n${command.out}`;
      toolCall(min, 'Bash', input, text, text, true);
      return;
    }
    toolCall(min, 'Bash', input, command.out, {
      stdout: command.out,
      stderr: '',
      interrupted: false,
      isImage: false,
      ...(command.commitSha === undefined ? {} : { gitOperation: { commit: { sha: command.commitSha, kind: 'committed' } } }),
    });
  };

  const emitRead = (min: number): void => {
    const filePath = `${s.cwd}/README.md`;
    toolCall(min, 'Read', { file_path: filePath }, '# demo project', {
      type: 'text',
      file: { filePath, content: '# demo project', numLines: 1, startLine: 1, totalLines: 1 },
    });
  };

  /** Spawns one subagent: `Agent` call in the main file + its own transcript. */
  const emitAgent = (min: number, sub: DemoSubagent): void => {
    const agentId = `a${rng.hex(16)}`;
    const toolUseId = toolCall(min, 'Agent', { description: sub.description, prompt: 'Survey the module and report.' }, 'Launched agent.', {
      status: 'async_launched',
      agentId,
    });
    subagentFiles.set(`agent-${agentId}.jsonl`, buildSubagentFile(s, sub, agentId, baseMs));
    subagentFiles.set(`agent-${agentId}.meta.json`, {
      kind: 'text',
      text: JSON.stringify({ agentType: 'general-purpose', description: sub.description, toolUseId, spawnDepth: 1, model: s.model }),
      name: `agent-${agentId}.meta.json`,
    });
  };

  // ---- the turn ----
  const promptId = 'p-0001';
  {
    const uuid = nextId('u');
    push(
      {
        type: 'user',
        uuid,
        parentUuid: null,
        promptId,
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: { role: 'user', content: s.prompt },
        ...common(0),
      },
      uuid,
    );
  }

  const compactAfter = (s.compactions ?? 0) > 0 ? Math.floor(events.length * 0.6) : -1;
  events.forEach((event, index) => {
    if (index === compactAfter) {
      const boundaryUuid = nextId('u');
      push(
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: boundaryUuid,
          parentUuid: null,
          isMeta: false,
          level: 'info',
          logicalParentUuid: lastUuid,
          content: 'Conversation compacted',
          compactMetadata: { trigger: 'auto', preTokens: 180_000, postTokens: 12_000, cumulativeDroppedTokens: 168_000, durationMs: 2_400 },
          ...common(event.at),
        },
        boundaryUuid,
      );
      const summaryUuid = nextId('u');
      push(
        {
          type: 'user',
          uuid: summaryUuid,
          parentUuid: boundaryUuid,
          promptId: 'p-0002',
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: { role: 'user', content: 'Session summary: normalized the models and wired the CLI tests.' },
          ...common(event.at + 0.005),
        },
        summaryUuid,
      );
    }
    switch (event.kind) {
      case 'edit':
        emitEdit(event.at, event.edit);
        break;
      case 'command':
        emitCommand(event.at, event.command);
        break;
      case 'read':
        emitRead(event.at);
        break;
      case 'agent':
        emitAgent(event.at, event.sub);
        break;
    }
  });

  for (let i = 0; i < (s.apiErrors ?? 0); i++) {
    const uuid = nextId('u');
    push(
      {
        type: 'assistant',
        uuid,
        parentUuid: lastUuid,
        requestId: `req-${uuid}`,
        isApiErrorMessage: true,
        error: 'API Error: 503 upstream connect error',
        apiErrorStatus: 503,
        message: {
          id: `msg-${uuid}`,
          type: 'message',
          role: 'assistant',
          model: '<synthetic>',
          stop_reason: null,
          stop_sequence: null,
          content: [{ type: 'text', text: 'API Error: 503 upstream connect error' }],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        ...common(s.durationMin * 0.5 + i * 0.01),
      },
      uuid,
    );
  }

  const rf = s.refusalFallback;
  if (rf !== undefined) {
    const serving: RawUsage & { type: string; model: string } = {
      ...usageObject(1_000, 0, 0, 0, 500),
      type: 'message',
      model: rf.fallbackModel,
    };
    const refused: RawUsage & { type: string; model: string } = {
      ...usageObject(0, rf.refused.cacheRead, 0, 0, rf.refused.output),
      type: 'message',
      model: rf.originalModel,
    };
    const usage: RawUsage = { ...usageObject(1_000, 0, 0, 0, 500), iterations: [refused, serving] };
    const uuid = assistant(rf.at, [{ type: 'text', text: 'Continuing with a fallback model for this reply.' }], 'end_turn', usage);
    const sysUuid = nextId('u');
    push(
      {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: sysUuid,
        parentUuid: uuid,
        isMeta: false,
        level: 'info',
        originalModel: rf.originalModel,
        fallbackModel: rf.fallbackModel,
        requestId: `req-${uuid}`,
        apiRefusalCategory: 'other',
        ...common(rf.at + 0.01),
      },
      sysUuid,
    );
  }

  {
    const uuid = nextId('u');
    push(
      {
        type: 'system',
        subtype: 'turn_duration',
        uuid,
        parentUuid: lastUuid,
        isMeta: false,
        level: 'info',
        durationMs: Math.round((s.activeMin ?? s.durationMin) * 60_000),
        ...common(s.durationMin - 0.01),
      },
      uuid,
    );
  }

  if (s.final !== null) {
    assistant(s.durationMin, [{ type: 'text', text: s.final }], 'end_turn', nextUsage());
  } else {
    assistant(s.durationMin, [{ type: 'text', text: 'Still working through the refactor…' }], null, nextUsage());
  }

  const out: Generated = {
    harness: 'claude-code',
    lines: { kind: 'text', text: jsonl(lines), name: `${s.sessionId}.jsonl` },
  };
  if (subagentFiles.size > 0) out.subagents = subagentFiles;
  return out;
}

/** One subagent transcript: sidechain lines carrying the parent's promptId. */
function buildSubagentFile(s: Scenario, sub: DemoSubagent, agentId: string, baseMs: number): LineSource {
  const lines: string[] = [];
  let n = 0;
  let lastUuid: string | null = null;
  const nextId = (prefix: string): string => `${agentId}-${prefix}${String(++n).padStart(3, '0')}`;
  const common = (min: number): Record<string, unknown> => ({
    agentId,
    isSidechain: true,
    timestamp: iso(baseMs, min),
    cwd: s.cwd,
    sessionId: s.sessionId,
    version: s.harnessVersion,
    ...(s.branch === null ? {} : { gitBranch: s.branch }),
    userType: 'external',
  });
  const push = (record: Record<string, unknown>, uuid: string): void => {
    lines.push(JSON.stringify(record));
    lastUuid = uuid;
  };
  const zeroUsage = usageObject(0, 0, 0, 0, 0);

  const startMin = Math.min(...sub.commands.map((c) => c.at), ...sub.edits.map((e) => e.at), s.durationMin) - 0.02;
  {
    const uuid = nextId('u');
    push(
      { type: 'user', uuid, parentUuid: null, promptId: 'p-0001', message: { role: 'user', content: sub.description }, ...common(startMin) },
      uuid,
    );
  }
  let endMin = startMin;
  for (const command of sub.commands) {
    const toolUseId = nextId('tu');
    const assistantUuid = nextId('u');
    push(
      {
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: lastUuid,
        requestId: `req-${assistantUuid}`,
        message: {
          id: `msg-${assistantUuid}`,
          type: 'message',
          role: 'assistant',
          model: s.model,
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: command.cmd } }],
          usage: zeroUsage,
        },
        ...common(command.at),
      },
      assistantUuid,
    );
    const resultUuid = nextId('u');
    push(
      {
        type: 'user',
        uuid: resultUuid,
        parentUuid: lastUuid,
        promptId: 'p-0001',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: command.out, is_error: false }] },
        toolUseResult: { stdout: command.out, stderr: '', interrupted: false, isImage: false },
        ...common(command.at + 0.005),
      },
      resultUuid,
    );
    endMin = Math.max(endMin, command.at + 0.005);
  }
  {
    const uuid = nextId('u');
    push(
      {
        type: 'assistant',
        uuid,
        parentUuid: lastUuid,
        requestId: `req-${uuid}`,
        message: {
          id: `msg-${uuid}`,
          type: 'message',
          role: 'assistant',
          model: s.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'Survey complete.' }],
          usage: zeroUsage,
        },
        ...common(endMin + 0.01),
      },
      uuid,
    );
  }
  return { kind: 'text', text: jsonl(lines), name: `agent-${agentId}.jsonl` };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Emits one Codex rollout per Appendix B. */
function generateCodex(s: Scenario): Generated {
  const rng = prng(s.sessionId);
  const baseMs = Date.parse(s.startedAt);
  const lines: string[] = [];
  let calls = 0;
  const push = (min: number, type: string, payload: unknown): void => {
    lines.push(JSON.stringify({ timestamp: iso(baseMs, min), type, payload }));
  };

  push(0, 'session_meta', {
    id: s.sessionId,
    timestamp: iso(baseMs, 0),
    cwd: s.cwd,
    originator: 'codex_cli_rs',
    cli_version: s.harnessVersion,
    source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: 'showreceipts demo instructions' },
  });
  push(0.01, 'turn_context', {
    approval_policy: 'on-request',
    cwd: s.cwd,
    effort: 'medium',
    model: s.model,
    sandbox_policy: { type: 'workspace-write', writable_roots: [s.cwd], network_access: false },
    summary: 'auto',
    user_instructions: 'showreceipts demo user instructions',
  });
  push(0.02, 'event_msg', { type: 'user_message', message: s.prompt, images: [], local_images: [], text_elements: [] });

  for (const command of [...s.commands].sort((a, b) => a.at - b.at)) {
    const callId = `call-${String(++calls).padStart(3, '0')}`;
    push(command.at, 'response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: command.cmd }),
      call_id: callId,
    });
    const status = command.exit === null ? 'Process running with session ID 1' : `Process exited with code ${command.exit}`;
    const output = `Chunk ID: ${rng.hex(6)}\nWall time: 0.0500 seconds\n${status}\nOutput:\n${command.out}`;
    push(command.at + 0.01, 'response_item', { type: 'function_call_output', call_id: callId, output });
  }

  for (const tc of s.tokenCounts ?? []) {
    const totals = {
      input_tokens: tc.input,
      cached_input_tokens: tc.cached,
      output_tokens: tc.output,
      reasoning_output_tokens: 0,
      total_tokens: tc.input + tc.output,
    };
    push(s.durationMin - 0.02, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: totals, last_token_usage: totals, model_context_window: 258_400 },
      rate_limits:
        tc.ratePct === undefined
          ? null
          : { primary: { used_percent: tc.ratePct, window_minutes: 300, resets_at: 1_772_366_400 }, secondary: null },
    });
  }

  if (s.final !== null) push(s.durationMin, 'event_msg', { type: 'agent_message', message: s.final });

  // Deterministic UTC stamp (real rollout names use local wall time; the
  // readers never parse the name, so the demo keeps the seeded UTC instant).
  const stamp = s.startedAt.slice(0, 19).replace(/:/g, '-');
  return {
    harness: 'codex',
    lines: { kind: 'text', text: jsonl(lines), name: `rollout-${stamp}-${s.sessionId}.jsonl` },
  };
}

// ---------------------------------------------------------------------------
// Hook-captured ledger (Appendix C)
// ---------------------------------------------------------------------------

/** Ledger tool names per harness and kind (§9 / Appendix C tool→kind maps, inverted). */
const LEDGER_TOOLS: Readonly<Record<string, Readonly<Record<'shell' | 'edit' | 'write' | 'read', string>>>> = {
  cursor: { shell: 'Shell', edit: 'Edit', write: 'Write', read: 'Read' },
  gemini: { shell: 'run_shell_command', edit: 'replace', write: 'write_file', read: 'read_file' },
  copilot: { shell: 'bash', edit: 'str_replace_editor', write: 'create', read: 'view' },
  hermes: { shell: 'terminal', edit: 'edit_file', write: 'write_file', read: 'read_file' },
  dsh: { shell: 'shell', edit: 'edit', write: 'write', read: 'read' },
};

/** Emits one Appendix C ledger file. */
function generateLedger(s: Scenario): Generated {
  const harness = s.ledgerHarness ?? 'cursor';
  const tools = LEDGER_TOOLS[harness] ?? (LEDGER_TOOLS['dsh'] as Readonly<Record<'shell' | 'edit' | 'write' | 'read', string>>);
  const exitSource = harness === 'cursor' ? 'harness' : 'parsed';
  const baseMs = Date.parse(s.startedAt);
  const lines: string[] = [];
  let n = 0;
  const push = (min: number, event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ v: 1, t: iso(baseMs, min), h: harness, sid: s.sessionId, ...event }));
  };
  const withMeta = (extra: Record<string, unknown>): Record<string, unknown> => ({
    ...(s.harnessVersion === '' ? {} : { hv: s.harnessVersion }),
    ...(s.model === '' ? {} : { model: s.model }),
    ...extra,
  });

  push(0, withMeta({ e: 'session-start', transcript: `/home/u/.${harness}/chats/demo-1.json`, source: 'startup' }));
  push(0.02, { e: 'prompt', tid: 't1', text: s.prompt });

  type LedgerEventRow = { at: number; emit: () => void };
  const rows: LedgerEventRow[] = [];
  for (const edit of s.edits) {
    rows.push({
      at: edit.at,
      emit: (): void => {
        const kind = edit.verb === 'create' ? 'write' : 'edit';
        push(edit.at, {
          e: 'tool-post',
          tid: 't1',
          cwd: s.cwd,
          id: `tl-${String(++n).padStart(3, '0')}`,
          tool: kind === 'write' ? tools.write : tools.edit,
          kind,
          in: kind === 'write' ? { path: edit.path } : { path: edit.path, edits: [{ old: 'value = 1', new: 'value = 2' }] },
          out: { text: 'ok', bytes: 2 },
        });
      },
    });
  }
  for (const command of s.commands) {
    rows.push({
      at: command.at,
      emit: (): void => {
        push(command.at, {
          e: 'tool-post',
          tid: 't1',
          cwd: s.cwd,
          exitSource,
          id: `tl-${String(++n).padStart(3, '0')}`,
          tool: tools.shell,
          kind: 'shell',
          in: { command: command.cmd },
          out: {
            text: command.out,
            bytes: utf8Bytes(command.out),
            ...(command.exit === null ? {} : { exit: command.exit }),
            durationMs: 1200,
          },
        });
      },
    });
  }
  for (let i = 1; i <= (s.fillerReads ?? 0); i++) {
    const at = (s.durationMin * i) / ((s.fillerReads ?? 0) + 2);
    rows.push({
      at,
      emit: (): void => {
        push(at, {
          e: 'tool-post',
          tid: 't1',
          id: `tl-${String(++n).padStart(3, '0')}`,
          tool: tools.read,
          kind: 'read',
          in: { path: 'README.md' },
          out: { text: '# demo', bytes: 6 },
        });
      },
    });
  }
  rows.sort((a, b) => a.at - b.at);
  for (const row of rows) row.emit();

  if (s.final !== null) push(s.durationMin - 0.05, { e: 'agent-response', tid: 't1', text: s.final });
  push(s.durationMin - 0.02, withMeta({ e: 'stop', tid: 't1', status: 'completed' }));
  push(s.durationMin, { e: 'session-end', reason: 'exit' });

  const src: LineSource = { kind: 'text', text: jsonl(lines), name: `${s.sessionId}.jsonl` };
  return { harness, lines: src, ledger: src };
}

/**
 * Generates the synthetic session of `scenario` (§14.1): the transcript (or
 * ledger) as an in-memory `LineSource`, plus subagent transcripts keyed by
 * file name for Claude Code scenarios that spawn agents. Pure and
 * deterministic: identical scenarios produce identical bytes.
 */
export function generate(scenario: Scenario): Generated {
  switch (scenario.harness) {
    case 'claude-code':
      return generateClaudeCode(scenario);
    case 'codex':
      return generateCodex(scenario);
    case 'ledger':
      return generateLedger(scenario);
  }
}
