/**
 * Hook-captured ledger reader (§4.4, Appendix C): reads one
 * `<home>/ledger/<harness>/<safeSid>.jsonl` file into a
 * `Session{source:'ledger'}`.
 *
 * One file = one session. Ordering is **file order** — `t` orders nothing;
 * timestamps only feed `startedAt`/`endedAt`/`spansDays`. Tool kinds are
 * re-derived from `(harness, tool)` via `kinds.ts` (the stored `kind` is a
 * hint). The reader opens nothing but the ledger file itself: the Copilot
 * transcript head is read exclusively through the injected
 * `readTranscriptHead` (the pipeline and the Stop hook supply an fs-backed
 * one), and `process.env` is never consulted.
 */
import { readFileSync } from 'node:fs';
import type {
  Cost,
  Diagnostics,
  Harness,
  Ledger,
  LedgerLine,
  LineSource,
  Session,
  SessionRef,
  SubagentInfo,
  ToolCall,
  Turn,
  UsageTotals,
} from '../../model/types.js';
import { HARNESSES } from '../../model/types.js';
import { shortId } from '../../util/ids.js';
import { isRecord, parseJsonSafe } from '../../util/json.js';
import { calendarDaysBetween, parseIso } from '../../util/time.js';
import { deriveKind, lookupKind } from './kinds.js';
import type { SubagentStopLine, ToolFailLine, ToolPostLine } from './lines.js';
import { classifyLedgerLine, isAgentResponse, isGap, isPrompt, isSessionEnd, isSessionStart, isStop, isSubagentStop, isToolFail, isToolPost } from './lines.js';

/** Cap on the Copilot transcript head handed to the injected reader (§4.4). */
const COPILOT_HEAD_BYTES = 64 * 1024;

export interface ReadLedgerOptions {
  /** Override for the ledger bytes; defaults to reading `ref.path`. */
  lines?: LineSource;
  /** `~/.showreceipts` (kept for signature parity with the other readers; the ledger reader opens nothing under it). */
  home: string;
  /**
   * Injected reader for the Copilot final-text fallback: returns the first
   * `maxBytes` bytes of the transcript at `path` as text, or `null` when it
   * cannot be read. Without it Copilot turns are effects-only
   * (`Diagnostics.copilotTranscriptUnparsed++`).
   */
  readTranscriptHead?: (path: string, maxBytes: number) => string | null;
}

interface Row {
  /** 1-based physical line number in the ledger file (`seq` for everything built from it). */
  seq: number;
  line: LedgerLine;
}

interface StopInfo {
  seq: number;
  status?: string;
  text?: string;
  transcript?: string;
}

/** Accumulator for one turn while walking the file in order. */
interface TurnAcc {
  index: number;
  tid: string | null;
  seqStart: number;
  seqEnd: number;
  minMs: number | null;
  maxMs: number | null;
  firstRawT: string;
  lastRawT: string;
  userText: string | null;
  responses: { seq: number; text: string }[];
  stops: StopInfo[];
  stopped: boolean;
  /** Set by `session-end` closing a still-open turn: never done. */
  forceNotDone: boolean;
  model: string | null;
  hv: string | null;
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

function emptyLedger(incomplete: boolean, incompleteReasons: string[]): Ledger {
  return {
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
    incomplete,
    incompleteReasons,
    opaqueTestCapable: 0,
    perTurn: {},
  };
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/** `''` splits to no lines (a pure insert has no removed lines). */
function splitPatchLines(s: string): string[] {
  return s === '' ? [] : s.split('\n');
}

function pushDistinct(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

/**
 * Splits the raw ledger text into classified rows. Torn trailing lines and
 * mid-file garbage count in `badLines` and are skipped; unknown events are
 * counted per name; unknown keys and `v ≠ 1` become deduplicated notes; every
 * line that parsed to a ledger-shaped object counts in `records`.
 */
function parseRows(text: string, diagnostics: Diagnostics, notes: Set<string>): Row[] {
  const rows: Row[] = [];
  const physical = text.split('\n');
  let badVersions = 0;
  for (let i = 0; i < physical.length; i++) {
    let raw = physical[i] ?? '';
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    if (raw.trim() === '') continue;
    const json = parseJsonSafe(raw);
    if (json === undefined) {
      diagnostics.badLines++;
      continue;
    }
    const c = classifyLedgerLine(json);
    if (c.kind === 'bad') {
      diagnostics.badLines++;
      continue;
    }
    diagnostics.records++;
    if (c.kind === 'unknown-event') {
      bump(diagnostics.unknownRecordTypes, c.event);
      continue;
    }
    if (c.badVersion) badVersions++;
    for (const k of c.unknownKeys) notes.add(`ledger: unknown key "${k}" on ${c.line.e}`);
    rows.push({ seq: i + 1, line: c.line });
  }
  if (badVersions > 0) notes.add(`ledger: ${badVersions} line(s) with v != 1 read best-effort`);
  return rows;
}

/** A text value from a string, a content-block array or a `{text}` record. */
function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const b of v) if (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
    const joined = parts.join('\n\n');
    return joined.trim() === '' ? null : joined;
  }
  if (isRecord(v) && typeof v['text'] === 'string') return textOf(v['text']);
  return null;
}

/** The assistant text of one transcript entry, whatever common shape it uses. */
function assistantTextOf(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const role = v['role'] ?? v['type'] ?? v['sender'];
  if (role === 'assistant') {
    const msg = v['message'];
    return textOf(v['text']) ?? textOf(v['content']) ?? (isRecord(msg) ? textOf(msg['content']) : null);
  }
  const msg = v['message'];
  if (isRecord(msg) && msg['role'] === 'assistant') return textOf(msg['content']) ?? textOf(msg['text']);
  return null;
}

/**
 * Best-effort last assistant text from a Copilot transcript head (§4.4):
 * JSONL first (last parseable line with an assistant text; a torn trailing
 * line is skipped), then a whole-document JSON sniff over the common array
 * keys. `null` means the format is unknown — the caller counts it in
 * `Diagnostics.copilotTranscriptUnparsed`.
 */
function extractLastAssistantText(head: string): string | null {
  let last: string | null = null;
  for (const line of head.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    const json = parseJsonSafe(s);
    if (json === undefined) continue;
    const t = assistantTextOf(json);
    if (t !== null) last = t;
  }
  if (last !== null) return last;
  const doc = parseJsonSafe(head.trim());
  if (doc === undefined) return null;
  let fromDoc = assistantTextOf(doc);
  const arrays: unknown[] = [];
  if (Array.isArray(doc)) arrays.push(...doc);
  else if (isRecord(doc)) {
    for (const key of ['messages', 'events', 'items', 'history', 'transcript']) {
      const arr = doc[key];
      if (Array.isArray(arr)) arrays.push(...arr);
    }
  }
  for (const item of arrays) {
    const t = assistantTextOf(item);
    if (t !== null) fromDoc = t;
  }
  return fromDoc;
}

/**
 * Evidence, from the events actually seen, that the harness's generic
 * post-tool subscription (§4.4: Cursor `postToolUse`, Gemini `AfterTool`,
 * Copilot `postToolUse`, Hermes `post_tool_call`, dsh
 * `PostToolUse`+`PostToolUseFailure`) was live. All non-Cursor dialects
 * install their tool hooks as one managed block, so any tool event proves
 * the block; Cursor's `afterFileEdit` is a separate edit-only event, so only
 * a non-`afterFileEdit` tool line is evidence of the generic subscription.
 */
function hasGenericPostToolEvidence(harness: Harness, toolNames: readonly string[]): boolean {
  if (toolNames.length === 0) return false;
  switch (harness) {
    case 'cursor':
      return toolNames.some((t) => t !== 'afterFileEdit');
    case 'gemini':
    case 'copilot':
    case 'hermes':
    case 'dsh':
      return true;
    default:
      return false;
  }
}

interface FinalizedTurn {
  turn: Turn;
  /** A stop-closed Copilot turn ended without any recoverable final text. */
  copilotMissingFinal: boolean;
}

function finalizeTurn(
  acc: TurnAcc,
  harness: Harness,
  sessionHv: string | null,
  readHead: ReadLedgerOptions['readTranscriptHead'],
  diagnostics: Diagnostics,
): FinalizedTurn {
  const lastStop = acc.stops.at(-1);
  const stopWithText = [...acc.stops].reverse().find((s) => s.text !== undefined && s.text !== '');

  let finalText: string | null = null;
  let finalSeq: number | null = null;
  let finalTextSource: 'transcript' | 'copilot-transcript' | null = null;
  let fromResponse = false;

  if (stopWithText !== undefined && stopWithText.text !== undefined) {
    finalText = stopWithText.text;
    finalSeq = stopWithText.seq;
    finalTextSource = 'transcript';
  } else {
    const lastResponse = [...acc.responses].reverse().find((r) => r.text !== '');
    if (lastResponse !== undefined) {
      finalText = lastResponse.text;
      finalSeq = lastResponse.seq;
      finalTextSource = 'transcript';
      fromResponse = true;
    } else if (harness === 'copilot' && lastStop?.transcript !== undefined) {
      if (readHead !== undefined) {
        const head = readHead(lastStop.transcript, COPILOT_HEAD_BYTES);
        const extracted = head === null ? null : extractLastAssistantText(head);
        if (extracted !== null) {
          finalText = extracted;
          finalSeq = lastStop.seq;
          finalTextSource = 'copilot-transcript';
        } else {
          diagnostics.copilotTranscriptUnparsed++;
        }
      } else {
        diagnostics.copilotTranscriptUnparsed++;
      }
    }
  }

  const interim = acc.responses.length - (fromResponse ? 1 : 0);
  diagnostics.interimFinals += interim;

  const status = lastStop?.status;
  const isDone = acc.stopped && !acc.forceNotDone && (status === undefined || status === 'completed');
  const interrupted = status === 'aborted' || status === 'interrupted';
  const promptId = `t${acc.index + 1}`;

  const turn: Turn = {
    index: acc.index,
    kind: 'human',
    promptId,
    userText: acc.userText,
    echoHashes: [],
    segments: [{ trigger: 'human', promptId, seqStart: acc.seqStart, seqEnd: acc.seqEnd }],
    seqStart: acc.seqStart,
    seqEnd: acc.seqEnd,
    startedAt: acc.minMs !== null ? new Date(acc.minMs).toISOString() : acc.firstRawT,
    endedAt: acc.maxMs !== null ? new Date(acc.maxMs).toISOString() : acc.lastRawT,
    durationMs: null,
    finalText,
    finalSeq,
    finalMessageId: null,
    finalTrigger: finalText !== null ? 'human' : null,
    interimFinals: interim,
    harnessVersion: acc.hv ?? sessionHv,
    model: acc.model,
    isDone,
    interrupted,
    compactions: 0,
    opaqueWriteCommands: 0,
    opaqueTestCommands: 0,
    usage: emptyTotals(),
    costUsd: null,
    apiCalls: 0,
    finalStopReason: null,
  };
  if (finalTextSource !== null) turn.finalTextSource = finalTextSource;
  return { turn, copilotMissingFinal: harness === 'copilot' && acc.stopped && finalText === null };
}

/**
 * Reads one Appendix C ledger file into a `Session{source:'ledger'}` (§4.4).
 * Never throws on malformed content: torn or garbage lines → `badLines`,
 * unknown events/keys → diagnostics, `v ≠ 1` → best-effort read. Synchronous
 * (`await` on the result is a no-op for pipeline callers).
 */
export function readLedgerSession(ref: SessionRef, opts: ReadLedgerOptions): Session {
  const diagnostics = emptyDiagnostics();
  const notes = new Set<string>();
  const src: LineSource = opts.lines ?? { kind: 'file', path: ref.path };
  const text = src.kind === 'file' ? readFileSync(src.path, 'utf8') : src.text;
  const rows = parseRows(text, diagnostics, notes);

  // --- Pass 1: session-level fields (so the tool pass knows the session cwd) ---
  let firstH: string | null = null;
  let firstSid: string | null = null;
  let sessionCwd: string | null = null;
  const cwds: string[] = [];
  let hv: string | null = null;
  const hvs: string[] = [];
  const models: string[] = [];
  let startTranscript: string | null = null;
  let stopTranscript: string | null = null;
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let firstRawT: string | null = null;
  let lastRawT: string | null = null;
  const sessionStartMs: number[] = [];
  let firstToolMs: number | null = null;
  let sawGap = false;
  let sawTruncated = false;
  const toolNames: string[] = [];

  for (const { seq, line } of rows) {
    // `classifyLedgerLine` guarantees a string `h` but may leave it '' — widen for the emptiness check.
    if (firstH === null && (line.h as string) !== '') firstH = line.h;
    if (firstSid === null && line.sid !== '') firstSid = line.sid;
    if (line.cwd !== undefined) {
      sessionCwd ??= line.cwd;
      pushDistinct(cwds, line.cwd);
    }
    if (line.hv !== undefined) {
      hv = line.hv;
      pushDistinct(hvs, line.hv);
    }
    if (line.model !== undefined) pushDistinct(models, line.model);
    const tMs = parseIso(line.t);
    if (tMs !== null) {
      minMs = minMs === null ? tMs : Math.min(minMs, tMs);
      maxMs = maxMs === null ? tMs : Math.max(maxMs, tMs);
    }
    firstRawT ??= line.t;
    lastRawT = line.t;
    if (isSessionStart(line)) {
      startTranscript ??= line.transcript ?? null;
      if (tMs !== null) sessionStartMs.push(tMs);
    } else if (isStop(line)) {
      stopTranscript ??= line.transcript ?? null;
    } else if (isGap(line)) {
      sawGap = true;
      notes.add(`ledger gap at line ${seq}: ${line.reason} (${line.bytes} bytes)`);
    } else if (isToolPost(line) || isToolFail(line)) {
      if (firstToolMs === null && tMs !== null) firstToolMs = tMs;
      toolNames.push(line.tool);
      if (isToolPost(line) && line.out.truncated === true) sawTruncated = true;
    }
  }

  const harness: Harness = firstH !== null && (HARNESSES as readonly string[]).includes(firstH) ? (firstH as Harness) : ref.harness;
  const sessionId = firstSid ?? ref.sessionId;
  const cwdFallback = sessionCwd ?? '';

  // --- Pass 2: turns, tool calls and subagents, strictly in file order ---
  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const subagents: SubagentInfo[] = [];
  let copilotMissingFinal = false;
  let open: TurnAcc | null = null;

  const closeOpen = (): void => {
    if (open === null) return;
    const done = finalizeTurn(open, harness, hv, opts.readTranscriptHead, diagnostics);
    turns.push(done.turn);
    if (done.copilotMissingFinal) copilotMissingFinal = true;
    open = null;
  };

  const buildToolCall = (seq: number, line: ToolPostLine | ToolFailLine, turnIndex: number): ToolCall => {
    const known = lookupKind(harness, line.tool);
    if (known === null && line.tool !== '') bump(diagnostics.unknownToolShapes, line.tool);
    const kind = deriveKind(harness, line.tool);
    let cwd = line.cwd;
    if (cwd === undefined) {
      if (kind === 'shell' || kind === 'edit' || kind === 'write') {
        notes.add(`ledger: missing cwd on ${line.tool} (${kind}) at line ${seq}; session cwd assumed`);
      }
      cwd = cwdFallback;
    }
    const input: Record<string, unknown> = {};
    if (line.in.command !== undefined) input['command'] = line.in.command;
    if (line.in.path !== undefined) input['path'] = line.in.path;
    if (line.in.paths !== undefined) input['paths'] = line.in.paths;
    if (line.in.url !== undefined) input['url'] = line.in.url;
    if (line.in.raw !== undefined) input['raw'] = line.in.raw;
    const filesTouched: string[] = [];
    if (line.in.path !== undefined) pushDistinct(filesTouched, line.in.path);
    for (const p of line.in.paths ?? []) pushDistinct(filesTouched, p);

    const fail = isToolFail(line);
    const durationMs = fail ? line.durationMs : line.out.durationMs;
    const tMs = parseIso(line.t);
    const startedAt = durationMs !== undefined && tMs !== null ? new Date(tMs - durationMs).toISOString() : line.t;

    const call: ToolCall = {
      seq,
      id: line.id,
      tool: line.tool,
      kind,
      agentId: null,
      turnIndex,
      cwd,
      input,
      resultText: fail ? line.error : line.out.text,
      resultBytes: fail ? Buffer.byteLength(line.error, 'utf8') : line.out.bytes,
      isError: fail ? true : line.out.error === true,
      exitCode: (fail ? line.out?.exit : line.out.exit) ?? null,
      exitCodeSource: line.exitSource ?? 'unknown',
      interrupted: false,
      background: false,
      startedAt,
      endedAt: line.t,
      filesTouched,
    };
    if (line.in.command !== undefined) call.command = line.in.command;
    if (durationMs !== undefined) call.durationMs = durationMs;
    if (!fail && line.out.truncated === true) call.truncated = 'harness';
    if (line.in.edits !== undefined && line.in.edits.length > 0) {
      const added: string[] = [];
      const removed: string[] = [];
      for (const e of line.in.edits) {
        removed.push(...splitPatchLines(e.old));
        added.push(...splitPatchLines(e.new));
      }
      call.patch = { added, removed, hunks: line.in.edits.length };
      if (line.in.editsTruncated === true) call.patch.truncated = true;
    }
    if (fail) {
      if (line.failureType === 'permission_denied') call.denied = 'permission-rule';
      if (line.failureType === 'timeout') call.terminated = true;
    }
    return call;
  };

  const addSubagentStop = (seq: number, line: SubagentStopLine, turnIndex: number): void => {
    const agentId = `ledger-agent-${seq}`;
    const info: SubagentInfo = {
      agentId,
      parentAgentId: null,
      spawnedBy: { tool: 'unknown' },
      toolCalls: 0,
      startedAt: line.t,
      endedAt: line.t,
      finished: line.agent.status === undefined || line.agent.status === 'completed',
    };
    if (line.agent.type !== undefined) info.agentType = line.agent.type;
    if (line.agent.summary !== undefined) info.description = line.agent.summary;
    subagents.push(info);
    const modified = line.agent.modifiedFiles ?? [];
    if (modified.length > 0) {
      // S12 turns this synthetic call into `WriteFact{source:'subagent-list', status:'unknown'}`.
      const summary = line.agent.summary ?? '';
      toolCalls.push({
        seq,
        id: `subagent-stop-${seq}`,
        tool: 'subagent-stop',
        kind: 'agent',
        agentId,
        turnIndex,
        cwd: cwdFallback,
        input: {},
        resultText: summary,
        resultBytes: Buffer.byteLength(summary, 'utf8'),
        isError: false,
        exitCode: null,
        exitCodeSource: 'unknown',
        interrupted: false,
        background: false,
        startedAt: line.t,
        endedAt: line.t,
        filesTouched: [...modified],
      });
    }
  };

  for (const row of rows) {
    const { seq, line } = row;
    if (isSessionStart(line) || isGap(line)) continue; // session-level only, never turn content
    if (isSessionEnd(line)) {
      if (open !== null) {
        if (!open.stopped) open.forceNotDone = true; // closes the open turn as not-done
        closeOpen();
      }
      continue;
    }

    // Turn boundary: the maximal run sharing `tid` when the dialect provides
    // one, else the segment closed by a stop-class line. Never `t`.
    const tid = line.tid ?? null;
    if (open !== null) {
      const o: TurnAcc = open;
      if (o.stopped) {
        if (!(tid !== null && o.tid === tid)) closeOpen(); // same-tid extra stop (Hermes on_session_end) stays deduped
      } else if (tid !== null && o.tid !== null && tid !== o.tid) {
        closeOpen();
      }
    }
    if (open === null) {
      open = {
        index: turns.length,
        tid,
        seqStart: seq,
        seqEnd: seq,
        minMs: null,
        maxMs: null,
        firstRawT: line.t,
        lastRawT: line.t,
        userText: null,
        responses: [],
        stops: [],
        stopped: false,
        forceNotDone: false,
        model: null,
        hv: null,
      };
    }
    const acc: TurnAcc = open;
    if (acc.tid === null && tid !== null) acc.tid = tid;
    acc.seqEnd = seq;
    acc.lastRawT = line.t;
    const tMs = parseIso(line.t);
    if (tMs !== null) {
      acc.minMs = acc.minMs === null ? tMs : Math.min(acc.minMs, tMs);
      acc.maxMs = acc.maxMs === null ? tMs : Math.max(acc.maxMs, tMs);
    }
    if (line.model !== undefined) acc.model = line.model;
    if (line.hv !== undefined) acc.hv = line.hv;

    if (isPrompt(line)) {
      acc.userText = line.text;
    } else if (isAgentResponse(line)) {
      // A blank response can never be a final and must not count as an
      // interim final (S09 review), so it is not accumulated at all.
      if (line.text !== '') acc.responses.push({ seq, text: line.text });
    } else if (isStop(line)) {
      const stop: StopInfo = { seq };
      if (line.status !== undefined) stop.status = line.status;
      if (line.text !== undefined) stop.text = line.text;
      if (line.transcript !== undefined) stop.transcript = line.transcript;
      acc.stops.push(stop);
      acc.stopped = true;
    } else if (isToolPost(line) || isToolFail(line)) {
      toolCalls.push(buildToolCall(seq, line, acc.index));
    } else if (isSubagentStop(line)) {
      addSubagentStop(seq, line, acc.index);
    }
  }
  closeOpen(); // lines after the last stop form an open turn that is never scored

  // --- Coverage (§4.4) ---
  const incompleteReasons: string[] = [];
  if (sawGap) incompleteReasons.push('gap lines in the ledger');
  if (sawTruncated) incompleteReasons.push('harness-truncated tool output');
  if (!hasGenericPostToolEvidence(harness, toolNames)) {
    incompleteReasons.push(toolNames.length === 0 ? 'no tool events recorded' : 'no generic post-tool subscription observed');
  }
  if (firstToolMs !== null) {
    const near = firstToolMs;
    if (!sessionStartMs.some((s) => Math.abs(near - s) <= 60_000)) {
      incompleteReasons.push('no session-start within 60s of the first tool event');
    }
  }
  const coverage: 'all-tools' | 'partial' = incompleteReasons.length === 0 ? 'all-tools' : 'partial';

  // --- Per-harness ledger notes (§4.4) ---
  const noteParts: string[] = [];
  if (harness === 'copilot' && copilotMissingFinal) noteParts.push('final message not captured by Copilot');
  const shells = toolCalls.filter((c) => c.kind === 'shell');
  if (shells.length > 0 && shells.every((c) => c.exitCodeSource === 'unknown')) noteParts.push('exit codes unknown');
  if (harness === 'copilot' || harness === 'hermes') noteParts.push(`test-integrity not available (${harness})`);

  diagnostics.notes = [...notes];

  const startedAt = minMs !== null ? new Date(minMs).toISOString() : (firstRawT ?? '');
  const endedAt = maxMs !== null ? new Date(maxMs).toISOString() : (lastRawT ?? '');

  const session: Session = {
    harness,
    harnessVersion: hv,
    harnessVersions: hvs,
    sessionId,
    shortId: shortId(harness, sessionId),
    source: 'ledger',
    transcriptPath: startTranscript ?? stopTranscript,
    cwd: cwdFallback,
    cwds,
    repoRoot: null,
    gitBranch: null,
    title: null,
    models,
    primaryModel: models[0] ?? 'unknown',
    startedAt,
    endedAt,
    durationMs: minMs !== null && maxMs !== null ? maxMs - minMs : 0,
    activeMs: null,
    turns,
    preamble: [],
    toolCalls,
    ledger: emptyLedger(coverage === 'partial', incompleteReasons),
    usage: emptyTotals(),
    cost: emptyCost(),
    compactions: [],
    subagents,
    prRefs: [],
    apiErrors: [],
    refusalFallbacks: [],
    diagnostics,
    usageRows: [],
    tokenDeltas: [],
    kind: diagnostics.records === 0 ? 'empty' : turns.length === 0 ? 'no-turns' : 'normal',
    records: diagnostics.records,
    spansDays: minMs !== null && maxMs !== null ? calendarDaysBetween(minMs, maxMs, 'utc') + 1 : 1,
    editedFiles: [],
    ledgerCoverage: coverage,
  };
  if (noteParts.length > 0) session.ledgerNote = noteParts.join('; ');
  return session;
}
