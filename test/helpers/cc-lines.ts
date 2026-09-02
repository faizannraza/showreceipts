/**
 * Tiny DSL for building Claude Code transcript lines in tests (PLAN S06).
 * A `cc()` instance keeps a deterministic uuid/timestamp counter and a
 * parent chain: every emitted line's `parentUuid` defaults to the previous
 * line's uuid, mirroring how the harness writes transcripts. All helpers
 * return the new line's uuid so tests can branch chains explicitly.
 */
import type { LineSource, RawUsage, Session, SessionRef } from '../../src/model/types.js';
import { SessionBuilder, type BuilderOptions } from '../../src/readers/claude-code/builder.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions, type ClaudeCodeReadResult } from '../../src/readers/claude-code/reader.js';
import { readJsonl } from '../../src/readers/jsonl.js';

/** Default session id (a UUIDv4, so `shortId` is its first 8 hex). */
export const TEST_SID = 'ab12cd34-1111-4222-8333-444455556666';
const BASE_TS = Date.UTC(2026, 1, 10, 10, 0, 0); // 2026-02-10T10:00:00Z (fixture window, PLAN §0.4)

/** A full usage object; override any field (set `cache_creation: undefined` for the legacy `wU` path). */
export function usage(over: Partial<RawUsage> & { iterations?: (RawUsage & { type?: string; model?: string })[] } = {}): RawUsage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    service_tier: 'standard',
    ...over,
  };
}

interface CommonOver {
  uuid?: string;
  parent?: string | null;
  promptId?: string;
  ts?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  extra?: Record<string, unknown>;
}

/** One transcript-in-progress. */
export class CC {
  readonly sid: string;
  private readonly lines: string[] = [];
  private n = 0;
  private lastUuid: string | null = null;

  constructor(sid: string = TEST_SID) {
    this.sid = sid;
  }

  /** Deterministic uuid `u-0001`, `u-0002`, … */
  nextUuid(): string {
    return `u-${String(++this.n).padStart(4, '0')}`;
  }

  /** Deterministic ISO timestamp, one second per line. */
  nextTs(): string {
    return new Date(BASE_TS + this.lines.length * 1000).toISOString();
  }

  /** The uuid of the most recently pushed line (`null` before the first). */
  last(): string | null {
    return this.lastUuid;
  }

  /** Pushes a raw JSON line (already-stringified or an object). */
  raw(line: string | Record<string, unknown>): void {
    this.lines.push(typeof line === 'string' ? line : JSON.stringify(line));
  }

  private push(record: Record<string, unknown>, uuid: string | null): string {
    this.lines.push(JSON.stringify(record));
    if (uuid !== null) this.lastUuid = uuid;
    return uuid ?? '';
  }

  private common(over: CommonOver): Record<string, unknown> {
    return {
      isSidechain: false,
      timestamp: over.ts ?? this.nextTs(),
      cwd: over.cwd ?? '/home/u/proj',
      sessionId: this.sid,
      version: over.version ?? '2.1.220',
      gitBranch: over.gitBranch ?? 'main',
      userType: 'external',
      ...(over.extra ?? {}),
    };
  }

  /** A user line with arbitrary message content (string or block list). */
  user(content: unknown, over: CommonOver & { origin?: unknown; promptSource?: string; isMeta?: boolean } = {}): string {
    const uuid = over.uuid ?? this.nextUuid();
    const record: Record<string, unknown> = {
      type: 'user',
      uuid,
      parentUuid: over.parent === undefined ? this.lastUuid : over.parent,
      message: { role: 'user', content },
      ...this.common(over),
    };
    if (over.promptId !== undefined) record['promptId'] = over.promptId;
    if (over.origin !== undefined) record['origin'] = over.origin;
    if (over.promptSource !== undefined) record['promptSource'] = over.promptSource;
    if (over.isMeta !== undefined) record['isMeta'] = over.isMeta;
    return this.push(record, uuid);
  }

  /** A human prompt line (`origin.kind: 'human'`, `promptSource: 'typed'`). */
  human(text: string, over: CommonOver = {}): string {
    return this.user(text, { origin: { kind: 'human' }, promptSource: 'typed', promptId: over.promptId ?? this.nextUuid(), ...over });
  }

  /** A skill invocation line (`<command-name>` + `<command-args>`). */
  skill(name: string, args: string, over: CommonOver = {}): string {
    const text = `<command-name>${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
    return this.user(text, { promptId: over.promptId ?? this.nextUuid(), ...over });
  }

  /** A `<task-notification>` line (`origin.kind: 'task-notification'`, `isMeta: true` as observed). */
  notification(body: string, over: CommonOver = {}): string {
    return this.user(`<task-notification>${body}</task-notification>`, {
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      isMeta: true,
      promptId: over.promptId ?? this.nextUuid(),
      ...over,
    });
  }

  /** An interrupt line (`[Request interrupted…]`, optional `interruptedMessageId`, promptId optional). */
  interrupt(over: CommonOver & { interruptedMessageId?: string } = {}): string {
    const extra: Record<string, unknown> = { ...(over.extra ?? {}) };
    if (over.interruptedMessageId !== undefined) extra['interruptedMessageId'] = over.interruptedMessageId;
    return this.user('[Request interrupted by user]', { ...over, extra });
  }

  /** An `isCompactSummary` line under a fresh promptId. */
  compactSummary(text: string, over: CommonOver = {}): string {
    return this.user(text, { promptId: over.promptId ?? this.nextUuid(), ...over, extra: { isCompactSummary: true, ...(over.extra ?? {}) } });
  }

  /**
   * An assistant line. `stop` defaults to `'end_turn'`; `text`, `thinking`
   * and `tools` compose the content blocks in that order.
   */
  assistant(
    over: CommonOver & {
      id?: string;
      model?: string;
      stop?: string | null;
      text?: string;
      thinking?: string;
      tools?: { id: string; name: string; input?: Record<string, unknown> }[];
      usage?: RawUsage | null;
      requestId?: string;
      content?: unknown[];
    } = {},
  ): string {
    const uuid = over.uuid ?? this.nextUuid();
    const content: unknown[] = over.content ?? [];
    if (over.content === undefined) {
      if (over.thinking !== undefined) content.push({ type: 'thinking', thinking: over.thinking, signature: 'sig' });
      if (over.text !== undefined) content.push({ type: 'text', text: over.text });
      for (const t of over.tools ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} });
    }
    const record: Record<string, unknown> = {
      type: 'assistant',
      uuid,
      parentUuid: over.parent === undefined ? this.lastUuid : over.parent,
      requestId: over.requestId ?? `req-${uuid}`,
      message: {
        id: over.id ?? `msg-${uuid}`,
        type: 'message',
        role: 'assistant',
        model: over.model ?? 'claude-test-5',
        stop_reason: over.stop === undefined ? 'end_turn' : over.stop,
        stop_sequence: null,
        content,
        usage: over.usage === null ? undefined : (over.usage ?? usage()),
      },
      ...this.common(over),
    };
    return this.push(record, uuid);
  }

  /** A `tool_result` user line; `result` becomes `toolUseResult` unless `hasResult: false`. */
  toolResult(
    toolUseId: string,
    content: unknown,
    over: CommonOver & { result?: unknown; hasResult?: boolean; isError?: boolean; toolDenialKind?: string } = {},
  ): string {
    const uuid = over.uuid ?? this.nextUuid();
    const record: Record<string, unknown> = {
      type: 'user',
      uuid,
      parentUuid: over.parent === undefined ? this.lastUuid : over.parent,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: over.isError === true }] },
      ...this.common(over),
    };
    if (over.promptId !== undefined) record['promptId'] = over.promptId;
    if (over.hasResult !== false) record['toolUseResult'] = over.result !== undefined ? over.result : { stdout: typeof content === 'string' ? content : '', stderr: '', interrupted: false, isImage: false };
    if (over.toolDenialKind !== undefined) record['toolDenialKind'] = over.toolDenialKind;
    return this.push(record, uuid);
  }

  /** A system line of any subtype. */
  system(subtype: string, over: CommonOver & { fields?: Record<string, unknown> } = {}): string {
    const uuid = over.uuid ?? this.nextUuid();
    const record: Record<string, unknown> = {
      type: 'system',
      subtype,
      uuid,
      parentUuid: over.parent === undefined ? this.lastUuid : over.parent,
      isMeta: false,
      level: 'info',
      ...(over.fields ?? {}),
      ...this.common(over),
    };
    return this.push(record, uuid);
  }

  /** A `system/turn_duration` line. */
  turnDuration(durationMs: number, over: CommonOver = {}): string {
    return this.system('turn_duration', { ...over, fields: { durationMs } });
  }

  /** A `system/compact_boundary` line (`parentUuid: null`, bridged by `logicalParentUuid`). */
  compactBoundary(logicalParentUuid: string, meta: Record<string, unknown> = {}, over: CommonOver = {}): string {
    return this.system('compact_boundary', {
      ...over,
      parent: null,
      fields: {
        logicalParentUuid,
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100, cumulativeDroppedTokens: 900, durationMs: 1234, ...meta },
      },
    });
  }

  /** A `pr-link` record. */
  prLink(prNumber: number, over: { prUrl?: string; prRepository?: string } = {}): void {
    this.raw({
      type: 'pr-link',
      sessionId: this.sid,
      prNumber,
      prUrl: over.prUrl ?? `https://github.com/u/proj/pull/${prNumber}`,
      prRepository: over.prRepository ?? 'u/proj',
      timestamp: this.nextTs(),
    });
  }

  /** The transcript as an in-memory `LineSource`. */
  src(): LineSource {
    return { kind: 'text', text: this.lines.join('\n') + (this.lines.length > 0 ? '\n' : ''), name: `${this.sid}.jsonl` };
  }

  /** The first `count` lines only (round-trip split tests). */
  srcPrefix(count: number): LineSource {
    const lines = this.lines.slice(0, count);
    return { kind: 'text', text: lines.join('\n') + (lines.length > 0 ? '\n' : ''), name: `${this.sid}.jsonl` };
  }

  /** Number of lines pushed so far. */
  lineCount(): number {
    return this.lines.length;
  }

  /** A minimal `SessionRef` for this transcript. */
  ref(): SessionRef {
    return { harness: 'claude-code', sessionId: this.sid, path: '', size: 0, mtimeMs: 0, subagentManifest: [] };
  }
}

/** Starts a fresh transcript builder. */
export function cc(sid?: string): CC {
  return new CC(sid);
}

/** Reads a `CC` transcript through the real reader; returns the full result. */
export async function readCC(t: CC, opts: Partial<ClaudeCodeReadOptions> = {}): Promise<ClaudeCodeReadResult> {
  return readClaudeCodeSession(t.ref(), { lines: t.src(), home: '/home/u', ...opts });
}

/** Reads a `CC` transcript through the real reader; returns just the session. */
export async function parseCC(t: CC, opts: Partial<ClaudeCodeReadOptions> = {}): Promise<Session> {
  return (await readCC(t, opts)).session;
}

/** Feeds a `LineSource` through a `SessionBuilder` directly (subagent-mode tests). */
export async function buildSession(lines: LineSource, ref: SessionRef, opts: BuilderOptions): Promise<Session> {
  const builder = new SessionBuilder(ref, opts);
  const gen = readJsonl(lines, {});
  let step = await gen.next();
  while (!step.done) {
    builder.feed(step.value);
    step = await gen.next();
  }
  builder.noteSummary(step.value);
  return builder.finish();
}
