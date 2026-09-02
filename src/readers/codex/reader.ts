/**
 * Codex rollout reader (ARCHITECTURE §4.3): parses one
 * `rollout-*.jsonl` file — the verified 0.98 `exec_command`/`write_stdin`/
 * `apply_patch` dialect and the unobserved `shell_command`/`shell` dialect —
 * into a `Session` with turns, tool calls, exit codes, stdin back-fill,
 * patches and token deltas.
 *
 * Framing (§4.3.1): every line is `{timestamp, type, payload}`. Turns span
 * from an `event_msg.user_message` to the next (§4.3.2); the final is the
 * **last** `event_msg.agent_message` of the span, falling back to an
 * assistant `response_item.message` with `phase === 'final_answer'`. Nothing
 * from `base_instructions`, `user_instructions`, developer messages or
 * reasoning content ever reaches the `Session`.
 *
 * The reader opens nothing but the transcript handed to it (no `realpath`,
 * no `stat`, no `process.env`) and never throws on malformed content.
 */
import type {
  Cost,
  Diagnostics,
  ExitSource,
  LineSource,
  RawLine,
  Session,
  SessionRef,
  ToolCall,
  ToolKind,
  TokenDelta,
  Turn,
  UsageTotals,
} from '../../model/types.js';
import { shortId } from '../../util/ids.js';
import { canon, resolveAgainst } from '../../util/paths.js';
import { calendarDaysBetween, parseIso } from '../../util/time.js';
import { readJsonl } from '../jsonl.js';
import {
  assistantMessageFields,
  callOutputFields,
  classifyCodexLine,
  customToolCallFields,
  eventMessageText,
  functionCallFields,
  localShellCallFields,
  messageRole,
  payloadType,
  sessionMetaFields,
  tokenCountFields,
  turnContextFields,
} from './records.js';
import type { CodexOutput } from './output.js';
import { parseCodexOutput } from './output.js';
import type { ParsedPatch } from './patch.js';
import { customPatchOutcome, extractPatchFromCommand, parsePatchText, patchOutcome } from './patch.js';
import { TokenTracker, usageFromDeltas } from './tokens.js';

/** The VS Code prompt wrapper stripped from `user_message` text (§4.3.2). */
const IDE_WRAPPER_RE = /^# Context from my IDE setup:[\s\S]*?## My request for Codex:\n/;
/** Shell wrappers whose third argv element is the actual script (§4.3.3). */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh']);
const SHELL_WRAPPER_FLAGS: ReadonlySet<string> = new Set(['-lc', '-c']);
/** Tool names of the shell family across dialects (§4.3.3). */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['exec_command', 'shell_command', 'shell', 'container.exec', 'local_shell_call']);
/** Every function-call name the reader knows (no `unknownCodexPayloads` bump). */
const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(['exec_command', 'shell_command', 'shell', 'container.exec', 'write_stdin']);
/** Cap on retained result text (mirrors S06's 1 MiB head/tail retention). */
const MAX_RESULT_TEXT = 1 << 20;
const RESULT_HEAD = 512 * 1024;

/** Options for {@link readCodexSession}. */
export interface ReadCodexOptions {
  /** Override for the rollout bytes; defaults to reading `ref.path`. */
  lines?: LineSource;
  /** The user's home directory, injected for `~` expansion in patch paths. */
  home: string;
}

/** What one read pass produced (shape shared with the Claude Code reader for the cache). */
export interface ReadCodexResult {
  session: Session;
  /** Absolute offset just past the last complete line (incremental resume, §4.9). */
  bytesParsed: number;
  /** SHA-256 of the tail of the parsed region (§4.9). */
  tailHash: string;
}

function emptyTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function emptyCost(): Cost {
  return {
    usd: null,
    apiCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteOther: 0,
    output: 0,
    cacheHitPct: null,
    unverified: false,
    unpriced: [],
    apiEquivalent: true,
    pricesVersion: 'none',
    notes: [],
  };
}

function emptyDiagnostics(): Diagnostics {
  return {
    unknownRecordTypes: {},
    unknownSubtypes: {},
    unknownToolShapes: {},
    unknownContentBlocks: {},
    unknownCodexPayloads: {},
    badLines: 0,
    lineSeparatorChars: 0,
    reorderedEvents: 0,
    duplicateUuids: 0,
    duplicateToolResults: 0,
    negativeDeltas: 0,
    orphanAssistantLines: 0,
    notificationPrompts: 0,
    localCommandPrompts: 0,
    incompleteMessages: 0,
    bashWithoutToolUseResult: 0,
    legacyShapes: {},
    subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
    notes: [],
    interimFinals: 0,
    emptySessions: 0,
    excludedSyntheticLines: 0,
    unknownAttachmentTypes: {},
    journals: 0,
    unrecognisedFiles: 0,
    orphanSessionDirs: 0,
    emptyProjects: 0,
    corruptCache: 0,
    copilotTranscriptUnparsed: 0,
    records: 0,
  };
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function pushDistinct(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

/** The `ToolKind` for a Codex tool name (§4.3.3): shells, `apply_patch → edit`, MCP names, else `other`. */
export function codexToolKind(name: string): ToolKind {
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (name === 'apply_patch') return 'edit';
  if (name === 'write_stdin') return 'other';
  if (name.startsWith('mcp__') || name.includes('__')) return 'mcp';
  return 'other';
}

/**
 * The command text of a call's arguments (§4.3.3): `args.cmd ?? args.command`
 * — a string as-is; a `string[]` joined with spaces, except the
 * `[sh|bash|zsh, -lc|-c, script]` wrapper, which yields the script alone.
 */
export function commandTextOf(args: Record<string, unknown>): string | undefined {
  const v = args['cmd'] ?? args['command'];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return joinArgv(v.filter((x): x is string => typeof x === 'string'));
  return undefined;
}

/** Joins an argv array with the shell-wrapper collapse rule. */
function joinArgv(parts: string[]): string {
  if (parts.length === 3) {
    const first = parts[0] ?? '';
    const program = first.slice(first.lastIndexOf('/') + 1);
    if (SHELL_WRAPPERS.has(program) && SHELL_WRAPPER_FLAGS.has(parts[1] ?? '') && parts[2] !== undefined) return parts[2];
  }
  return parts.join(' ');
}

/** A patch path resolved against the call's cwd, `~` expanded with the injected home. */
function resolvePatchPath(p: string, cwd: string, home: string): string {
  return resolveAgainst(canon(cwd, { home }), canon(p, { home }));
}

/** Caps a result text at 1 MiB (head + tail), mirroring the S06 retention. */
function capResultText(text: string): { text: string; capped: boolean } {
  if (text.length <= MAX_RESULT_TEXT) return { text, capped: false };
  return { text: `${text.slice(0, RESULT_HEAD)}\n…\n${text.slice(text.length - RESULT_HEAD)}`, capped: true };
}

/** What a pending (unanswered) call needs at output time. */
interface PendingCall {
  index: number;
  tool: string;
  /** `write_stdin` target session id. */
  stdinSessionId?: number;
  /** The parsed patch of an `apply_patch` (custom item or exec-delivered). */
  patch?: ParsedPatch | null;
  /** The call is a `custom_tool_call` (its output is a `custom_tool_call_output`). */
  custom?: boolean;
}

/** One open turn while walking the file. */
interface TurnAcc {
  index: number;
  promptId: string;
  userText: string;
  seqStart: number;
  seqEnd: number;
  startTs: string;
  lastTs: string;
  finalText: string | null;
  finalSeq: number | null;
  fallbackText: string | null;
  fallbackSeq: number | null;
  interim: number;
}

/**
 * Reads one Codex rollout into a `Session` (§4.3.1–4.3.5). Never throws on
 * malformed content: bad lines, unknown frame types and unknown payload
 * types/names all land in `Diagnostics`.
 */
export async function readCodexSession(ref: SessionRef, opts: ReadCodexOptions): Promise<ReadCodexResult> {
  const diagnostics = emptyDiagnostics();
  const notes = new Set<string>();
  const src: LineSource = opts.lines ?? { kind: 'file', path: ref.path };

  // --- Session-level state ---
  let sawMeta = false;
  let metaTimestamp: string | null = null;
  let metaCwd: string | null = null;
  let harnessVersion: string | null = null;
  let originator: string | null = null;
  let subagent = false;
  let gitBranch: string | null = null;
  let sandbox: Session['sandbox'];
  let currentCwd = '';
  let currentModel = 'unknown';
  const cwds: string[] = [];
  const models: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let planUsagePct: number | null = null;

  // --- Turn / call state ---
  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const tokenDeltas: TokenDelta[] = [];
  const pending = new Map<string, PendingCall>();
  /** Unified-exec session id → index of the still-running originating call. */
  const runningBySession = new Map<number, number>();
  const tracker = new TokenTracker();
  let open: TurnAcc | null = null;

  const closeOpen = (): void => {
    if (open === null) return;
    const acc = open;
    open = null;
    const finalText = acc.finalText ?? acc.fallbackText;
    const finalSeq = acc.finalText !== null ? acc.finalSeq : acc.fallbackSeq;
    const isDone = finalText !== null;
    const turn: Turn = {
      index: acc.index,
      kind: 'human',
      promptId: acc.promptId,
      userText: acc.userText,
      echoHashes: [],
      segments: [{ trigger: 'human', promptId: acc.promptId, seqStart: acc.seqStart, seqEnd: acc.seqEnd }],
      seqStart: acc.seqStart,
      seqEnd: acc.seqEnd,
      startedAt: acc.startTs,
      endedAt: acc.lastTs,
      durationMs: null,
      finalText,
      finalSeq,
      finalMessageId: null,
      finalTrigger: isDone ? 'human' : null,
      interimFinals: acc.interim,
      harnessVersion,
      model: currentModel === 'unknown' ? null : currentModel,
      isDone,
      interrupted: !isDone,
      compactions: 0,
      opaqueWriteCommands: 0,
      opaqueTestCommands: 0,
      usage: emptyTotals(),
      costUsd: null,
      apiCalls: 0,
      finalStopReason: null,
    };
    turns.push(turn);
  };

  /** Applies a reported exit to a call: `-1` ⇒ `null` + `terminated` (§4.3.3). */
  const applyExit = (call: ToolCall, reported: number, source: ExitSource): void => {
    if (reported === -1) {
      call.exitCode = null;
      call.terminated = true;
      call.interpretation = 'killed-or-unknown';
    } else {
      call.exitCode = reported;
    }
    call.exitCodeSource = source;
  };

  /** Back-fills the originating command of a stdin session with its reported exit. */
  const backfill = (sessionId: number, reported: number): void => {
    const targetIndex = runningBySession.get(sessionId);
    if (targetIndex === undefined) return;
    const target = toolCalls[targetIndex];
    if (target === undefined) return;
    runningBySession.delete(sessionId);
    if (target.exitCode !== null || target.terminated === true) return;
    applyExit(target, reported, 'backfilled');
  };

  const newToolCall = (seq: number, ts: string, id: string, tool: string, kind: ToolKind): ToolCall => ({
    seq,
    id,
    tool,
    kind,
    agentId: null,
    turnIndex: open?.index ?? -1,
    cwd: currentCwd,
    input: {},
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: null,
    exitCodeSource: 'unknown',
    interrupted: false,
    background: false,
    startedAt: ts,
    endedAt: null,
    filesTouched: [],
  });

  /** Applies a parsed output's generic fields (body, timing, truncation) to a call. */
  const applyOutputCommon = (call: ToolCall, ts: string, raw: string, out: CodexOutput): void => {
    call.endedAt = ts;
    call.resultBytes = Buffer.byteLength(raw, 'utf8');
    if (out.wallTimeMs !== undefined) call.durationMs = out.wallTimeMs;
    if (out.truncated) {
      call.truncated = 'harness';
      if (out.originalTokens !== undefined) call.originalTokens = out.originalTokens;
    }
    const capped = capResultText(out.body);
    call.resultText = capped.text;
    if (capped.capped && call.truncated === undefined) call.truncated = 'showreceipts';
  };

  const onFunctionCallOutput = (seq: number, ts: string, payload: Record<string, unknown>): void => {
    const { callId, output } = callOutputFields(payload);
    const entry = callId !== null ? pending.get(callId) : undefined;
    if (entry === undefined || callId === null) {
      notes.add('codex: function_call_output without a matching call');
      return;
    }
    pending.delete(callId);
    const call = toolCalls[entry.index];
    if (call === undefined) return;
    const out = parseCodexOutput(output);

    if (entry.patch !== undefined) {
      // An `apply_patch` delivered through exec_command/shell_command (§4.3.4):
      // gate the writes on the parsed body + exit, never on the raw status.
      const outcome =
        out.parser === 'none' ? patchOutcome(entry.patch, out.body, null) : patchOutcome(entry.patch, out.body, out.exitCode);
      applyOutputCommon(call, ts, output, out);
      call.isError = outcome.isError;
      call.exitCode = outcome.exitCode;
      // parser 'none' (plain failure text): the exit is `patchOutcome`'s
      // conservative default (1), labelled 'parsed' for want of a 'default'
      // source value; the call stays isError and is never green (S08 review).
      call.exitCodeSource = out.parser === 'none' ? 'parsed' : out.exitCodeSource;
      call.filesTouched = outcome.filesTouched.map((p) => resolvePatchPath(p, call.cwd, opts.home));
      if (outcome.attempted.length > 0) call.attempted = outcome.attempted.map((p) => resolvePatchPath(p, call.cwd, opts.home));
      return;
    }

    applyOutputCommon(call, ts, output, out);
    if (out.parser === 'none') {
      bump(diagnostics.unknownCodexPayloads, `output:${call.tool}`);
      return; // exit stays null/'unknown' — never green.
    }
    if (out.isError) {
      call.isError = true;
      if (out.denied !== undefined) call.denied = out.denied;
      if (out.exitCode !== null) applyExit(call, out.exitCode, out.exitCodeSource);
      return;
    }
    if (out.running === true && out.execSessionId !== undefined) {
      if (call.stdinWrite === true) {
        // The write landed but the target still runs: the write's own exit stays unknown.
        return;
      }
      call.background = true;
      runningBySession.set(out.execSessionId, entry.index);
      return;
    }
    if (out.exitCode !== null) {
      applyExit(call, out.exitCode, out.exitCodeSource);
      if (call.stdinWrite === true && entry.stdinSessionId !== undefined) backfill(entry.stdinSessionId, out.exitCode);
    }
  };

  const onFunctionCall = (seq: number, ts: string, payload: Record<string, unknown>): void => {
    const fields = functionCallFields(payload);
    if (fields === null) {
      bump(diagnostics.unknownCodexPayloads, 'function_call:no-name');
      return;
    }
    const { name, args } = fields;
    const callId = fields.callId ?? `codex-call-${seq}`;
    const kind = codexToolKind(name);
    if (!KNOWN_FUNCTIONS.has(name) && kind !== 'mcp') bump(diagnostics.unknownCodexPayloads, `function:${name}`);
    // Classified MCP by the broad double-underscore heuristic without the
    // `mcp__` prefix: keep the classification, but leave a structural trace
    // so the catalogue surfaces the name shape (S08 review).
    if (kind === 'mcp' && !name.startsWith('mcp__')) bump(diagnostics.unknownCodexPayloads, `mcp-name:${name}`);
    const call = newToolCall(seq, ts, callId, name, kind);
    const entry: PendingCall = { index: toolCalls.length, tool: name };

    if (name === 'write_stdin') {
      call.stdinWrite = true;
      const input: Record<string, unknown> = { ...args };
      delete input['chars'];
      call.input = input;
      const chars = typeof args['chars'] === 'string' ? args['chars'] : '';
      const sessionId = typeof args['session_id'] === 'number' ? args['session_id'] : undefined;
      if (sessionId !== undefined) {
        entry.stdinSessionId = sessionId;
        const targetIndex = runningBySession.get(sessionId);
        const target = targetIndex === undefined ? undefined : toolCalls[targetIndex];
        if (target !== undefined) {
          const write: { seq: number; chars: number; interrupted?: boolean } = { seq, chars: chars.length };
          const interrupts = chars.includes('\u0003');
          if (interrupts) {
            write.interrupted = true;
            target.interrupted = true;
          }
          (target.stdinWrites ??= []).push(write);
        }
      }
    } else {
      call.input = { ...args };
      const command = commandTextOf(args);
      if (command !== undefined) {
        call.command = command;
        const patchText = extractPatchFromCommand(command);
        if (patchText !== null) {
          const parsed = parsePatchText(patchText);
          entry.patch = parsed;
          if (parsed !== null) {
            call.patch = { added: parsed.added, removed: parsed.removed, hunks: parsed.hunks };
            if (parsed.truncated) call.patch.truncated = true;
          }
        }
      }
    }
    pending.set(callId, entry);
    toolCalls.push(call);
  };

  const onCustomToolCall = (seq: number, ts: string, payload: Record<string, unknown>): void => {
    const fields = customToolCallFields(payload);
    if (fields === null) {
      bump(diagnostics.unknownCodexPayloads, 'custom_tool_call:no-name');
      return;
    }
    const callId = fields.callId ?? `codex-call-${seq}`;
    if (fields.name !== 'apply_patch') {
      bump(diagnostics.unknownCodexPayloads, `custom_tool_call:${fields.name}`);
      const call = newToolCall(seq, ts, callId, fields.name, 'other');
      pending.set(callId, { index: toolCalls.length, tool: fields.name, custom: true });
      toolCalls.push(call);
      return;
    }
    const parsed = parsePatchText(fields.input);
    const call = newToolCall(seq, ts, callId, 'apply_patch', 'edit');
    if (parsed !== null) {
      call.patch = { added: parsed.added, removed: parsed.removed, hunks: parsed.hunks };
      if (parsed.truncated) call.patch.truncated = true;
    }
    pending.set(callId, { index: toolCalls.length, tool: 'apply_patch', patch: parsed, custom: true });
    toolCalls.push(call);
  };

  const onCustomToolCallOutput = (seq: number, ts: string, payload: Record<string, unknown>): void => {
    const { callId, output } = callOutputFields(payload);
    const entry = callId !== null ? pending.get(callId) : undefined;
    if (entry === undefined || callId === null) {
      notes.add('codex: custom_tool_call_output without a matching call');
      return;
    }
    pending.delete(callId);
    const call = toolCalls[entry.index];
    if (call === undefined) return;
    const outcome = customPatchOutcome(entry.patch ?? null, output);
    call.endedAt = ts;
    call.resultBytes = Buffer.byteLength(output, 'utf8');
    const capped = capResultText(outcome.body);
    call.resultText = capped.text;
    if (capped.capped) call.truncated = 'showreceipts';
    call.isError = outcome.isError;
    call.exitCode = outcome.exitCode;
    call.exitCodeSource = outcome.ok ? 'harness' : 'parsed';
    call.filesTouched = outcome.filesTouched.map((p) => resolvePatchPath(p, call.cwd, opts.home));
    if (outcome.attempted.length > 0) call.attempted = outcome.attempted.map((p) => resolvePatchPath(p, call.cwd, opts.home));
  };

  const onLocalShellCall = (seq: number, ts: string, payload: Record<string, unknown>): void => {
    const fields = localShellCallFields(payload);
    const callId = fields.callId ?? `codex-call-${seq}`;
    const call = newToolCall(seq, ts, callId, 'local_shell_call', 'shell');
    if (fields.command.length > 0) call.command = joinArgv(fields.command);
    pending.set(callId, { index: toolCalls.length, tool: 'local_shell_call' });
    toolCalls.push(call);
  };

  // --- Single pass over the file ---
  const gen = readJsonl(src, { sniff: false });
  let step = await gen.next();
  while (step.done !== true) {
    const line: RawLine = step.value;
    step = await gen.next();
    if (line.bad === true || line.json === undefined) continue;
    const classified = classifyCodexLine(line.json);
    if (classified.kind === 'not-a-record') {
      bump(diagnostics.unknownRecordTypes, '<not-a-record>');
      continue;
    }
    diagnostics.records++;
    const ts: string = (classified.kind === 'record' ? classified.record.ts : classified.ts) ?? lastTs ?? '';
    firstTs ??= ts;
    lastTs = ts;
    if (classified.kind === 'unknown-type') {
      bump(diagnostics.unknownRecordTypes, classified.type);
      continue;
    }
    const { type, payload } = classified.record;
    const seq = line.seq;
    if (open !== null) {
      open.seqEnd = seq;
      open.lastTs = ts;
    }

    if (type === 'session_meta') {
      if (sawMeta) {
        notes.add('codex: second session_meta ignored (first session id wins)');
        continue;
      }
      sawMeta = true;
      const meta = sessionMetaFields(payload);
      metaTimestamp = meta.timestamp;
      harnessVersion = meta.cliVersion;
      originator = meta.originator;
      subagent = meta.sourceIsObject;
      if (meta.gitBranch !== null) gitBranch = meta.gitBranch;
      if (meta.cwd !== null) {
        metaCwd = meta.cwd;
        currentCwd = meta.cwd;
        pushDistinct(cwds, meta.cwd);
      }
      continue;
    }

    if (type === 'turn_context') {
      const ctx = turnContextFields(payload);
      if (ctx.cwd !== null) {
        currentCwd = ctx.cwd;
        pushDistinct(cwds, ctx.cwd);
      }
      if (ctx.model !== null) {
        currentModel = ctx.model;
        pushDistinct(models, ctx.model);
      }
      if (ctx.gitBranch !== null) gitBranch = ctx.gitBranch;
      if (ctx.sandbox !== null) sandbox = ctx.sandbox;
      continue; // never a turn boundary, never a tool call (§4.3.1)
    }

    if (type === 'event_msg') {
      const kind = payloadType(payload);
      if (kind === 'user_message') {
        closeOpen(); // a second user_message without agent_message ⇒ previous turn interrupted
        const index = turns.length;
        open = {
          index,
          promptId: `t${index + 1}`,
          userText: eventMessageText(payload).replace(IDE_WRAPPER_RE, ''),
          seqStart: seq,
          seqEnd: seq,
          startTs: ts,
          lastTs: ts,
          finalText: null,
          finalSeq: null,
          fallbackText: null,
          fallbackSeq: null,
          interim: 0,
        };
      } else if (kind === 'agent_message') {
        if (open === null) {
          diagnostics.orphanAssistantLines++;
        } else {
          if (open.finalText !== null) {
            open.interim++;
            diagnostics.interimFinals++;
          }
          open.finalText = eventMessageText(payload);
          open.finalSeq = seq;
        }
      } else if (kind === 'token_count') {
        const tc = tokenCountFields(payload);
        if (tc.ratePct !== null) planUsagePct = tc.ratePct;
        if (tc.totals !== null) {
          const fed = tracker.feed(tc.totals, {
            seq,
            ts,
            model: currentModel,
            turnIndex: open?.index ?? -1,
            lastInput: tc.lastInput,
          });
          if (fed.reset) {
            diagnostics.negativeDeltas++;
            notes.add('usage counter reset (resume)');
          }
          if (fed.delta !== null) tokenDeltas.push(fed.delta);
        }
      } else if (kind !== 'agent_reasoning') {
        // `agent_reasoning` is ignored and never stored (§4.3.2).
        bump(diagnostics.unknownCodexPayloads, `event_msg:${kind ?? '<no-type>'}`);
      }
      continue;
    }

    // response_item
    const itemKind = payloadType(payload);
    switch (itemKind) {
      case 'message': {
        const role = messageRole(payload);
        if (role === 'assistant') {
          const assistant = assistantMessageFields(payload);
          if (assistant !== null && assistant.phase === 'final_answer' && open !== null) {
            open.fallbackText = assistant.text;
            open.fallbackSeq = seq;
          }
          // Plain assistant items are duplicates of `agent_message` and unused.
        }
        // Developer and user items are ignored and never stored (§4.3.1).
        break;
      }
      case 'reasoning':
        break; // never retained (encrypted_content stays on disk only)
      case 'function_call':
        onFunctionCall(seq, ts, payload);
        break;
      case 'function_call_output':
        onFunctionCallOutput(seq, ts, payload);
        break;
      case 'custom_tool_call':
        onCustomToolCall(seq, ts, payload);
        break;
      case 'custom_tool_call_output':
        onCustomToolCallOutput(seq, ts, payload);
        break;
      case 'local_shell_call':
        onLocalShellCall(seq, ts, payload);
        break;
      default:
        bump(diagnostics.unknownCodexPayloads, `response_item:${itemKind ?? '<no-type>'}`);
    }
  }
  const summary = step.value;
  closeOpen();

  diagnostics.badLines += summary.badLines;
  diagnostics.lineSeparatorChars = summary.lineSeparatorChars;
  diagnostics.notes = [...notes];

  // --- Per-turn usage from the deltas (§4.3.5: deltas attribute to the open turn) ---
  for (const turn of turns) {
    const own = tokenDeltas.filter((d) => d.turnIndex === turn.index);
    turn.usage = usageFromDeltas(own);
    turn.apiCalls = own.length;
  }

  const usage = usageFromDeltas(tokenDeltas);
  const outputByModel = new Map<string, number>();
  for (const d of tokenDeltas) outputByModel.set(d.model, (outputByModel.get(d.model) ?? 0) + d.output);
  let primaryModel = models[0] ?? 'unknown';
  let bestOutput = -1;
  for (const [model, output] of outputByModel) {
    if (output > bestOutput) {
      bestOutput = output;
      primaryModel = model;
    }
  }

  const startedAt = metaTimestamp ?? firstTs ?? '';
  const endedAt = lastTs ?? startedAt;
  const startMs = parseIso(startedAt);
  const endMs = parseIso(endedAt);
  const sessionId = ref.sessionId;
  const cost = emptyCost();
  if (planUsagePct !== null) cost.planUsagePct = planUsagePct;

  const session: Session = {
    harness: 'codex',
    harnessVersion,
    harnessVersions: harnessVersion !== null ? [harnessVersion] : [],
    sessionId,
    shortId: shortId('codex', sessionId),
    source: 'transcript',
    transcriptPath: ref.path,
    cwd: metaCwd ?? cwds[0] ?? '',
    cwds,
    repoRoot: null, // the pipeline fills it (S18)
    gitBranch,
    title: ref.title ?? null,
    models,
    primaryModel,
    startedAt,
    endedAt,
    durationMs: startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0,
    activeMs: null,
    turns,
    preamble: [],
    toolCalls,
    ledger: {
      writes: [],
      commands: [],
      testRuns: [],
      checks: [],
      git: [],
      network: [],
      integrity: [],
      danger: [],
      filesChanged: [],
      lastWriteSeq: null,
      lastSourceWriteSeq: null,
      lastGreenSeq: null,
      incomplete: false,
      incompleteReasons: [],
      opaqueTestCapable: 0,
      perTurn: {},
    },
    usage,
    cost,
    compactions: [],
    subagents: [],
    prRefs: [],
    apiErrors: [],
    refusalFallbacks: [],
    diagnostics,
    usageRows: [],
    tokenDeltas,
    kind: diagnostics.records === 0 ? 'empty' : turns.length === 0 ? 'no-turns' : 'normal',
    records: diagnostics.records,
    spansDays: startMs !== null && endMs !== null ? Math.max(1, calendarDaysBetween(startMs, endMs, 'utc') + 1) : 1,
    editedFiles: [],
  };
  if (originator !== null) session.originator = originator;
  if (subagent) session.subagent = true;
  if (sandbox !== undefined) session.sandbox = sandbox;

  return { session, bytesParsed: summary.bytesParsed, tailHash: summary.tailHash };
}
