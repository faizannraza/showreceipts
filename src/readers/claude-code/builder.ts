/**
 * The resumable Claude Code session builder (S06). `feed()` consumes one
 * `RawLine` at a time and accumulates serialisable state (groups, message
 * groups, tool calls, indexes, counters); `finish()` is a pure assembly over
 * that state, so `serialize()` at any prefix + `resume()` + the remaining
 * lines reproduces the single-pass `Session` exactly (§4.9 incremental tail
 * parsing). No file bodies are ever kept: result texts are capped (tools.ts)
 * and `originalFile`/`content`/`base64` are discarded on arrival.
 *
 * Determinism: no wall clock, no `process.env`, no `Math.random` — every
 * timestamp comes from the transcript via `util/time.parseIso`.
 */
import type {
  Compaction,
  Cost,
  Diagnostics,
  Ledger,
  PrRef,
  RawLine,
  RefusalFallback,
  Segment,
  Session,
  SessionRef,
  SubagentInfo,
  ToolCall,
  UsageRow,
  UsageTotals,
} from '../../model/types.js';
import { shortId } from '../../util/ids.js';
import { calendarDaysBetween, parseIso } from '../../util/time.js';
import { legacyToolName, SidechainCollector, type SidechainState } from './legacy.js';
import { applyNotification, parseTaskNotification } from './notifications.js';
import { asNumber, asRecord, asString, isRawUsage } from './records.js';
import type { SubagentSource } from './subagents.js';
import { completeToolCall, newToolCall, type SpawnSeed, type ToolDiag } from './tools.js';
import { assembleTurns, classifyUserLine, hasToolResultBlock, skillUserText, type GroupState, type MessageState } from './turns.js';
import { addRowToTotals, buildUsageRow, emptyTotals, noteUsageLine, thinkingOf } from './usage.js';

/** Builder options: parse mode and the (injected) home directory. */
export interface BuilderOptions {
  mode: 'main' | 'subagent';
  home: string;
}

/**
 * Per-message text budget: the head kept in `MessageState.texts` (8 MiB —
 * far above any real final message) plus the newest block's tail
 * ({@link MESSAGE_TEXT_TAIL}). Without a bound, one pathological assistant
 * message accumulating hundreds of MB either throws `Invalid string length`
 * at the turn join or aborts the whole hook process inside
 * `JSON.stringify` — silently killing that session's receipts.
 */
export const MESSAGE_TEXT_BUDGET = 8 * 1024 * 1024;
/** Tail bytes kept from the newest block once the budget is hit (flush guard needs the true suffix). */
export const MESSAGE_TEXT_TAIL = 64 * 1024;

/**
 * Appends one assistant text block to its message, bounded by
 * {@link MESSAGE_TEXT_BUDGET}: under budget the block is kept whole; the
 * first overflowing block keeps its head up to the budget (char-sliced —
 * close enough for a guard); every block past the budget only refreshes
 * `tailText` (the newest block's last {@link MESSAGE_TEXT_TAIL} chars), and
 * the message is marked `textsTruncated` for the turn join.
 */
function noteMessageText(msg: MessageState, seq: number, text: string): void {
  const total = msg.textBytes ?? 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (msg.textsTruncated !== true && total + bytes <= MESSAGE_TEXT_BUDGET) {
    msg.texts.push({ seq, text });
    msg.textBytes = total + bytes;
    return;
  }
  if (msg.textsTruncated !== true) {
    const room = MESSAGE_TEXT_BUDGET - total;
    if (room > 0) msg.texts.push({ seq, text: text.slice(0, room) });
    msg.textBytes = MESSAGE_TEXT_BUDGET;
    msg.textsTruncated = true;
  }
  msg.tailText = { seq, text: text.length > MESSAGE_TEXT_TAIL ? text.slice(-MESSAGE_TEXT_TAIL) : text };
}

/** Top-level record types that are recognised but carry nothing the session needs. */
const RECOGNISED_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'last-prompt',
  'agent-name',
  'atis-latch',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'frame-link',
  'fork-context-ref',
]);

/** System subtypes that are recognised (everything else → `unknownSubtypes`). */
const RECOGNISED_SUBTYPES: ReadonlySet<string> = new Set([
  'turn_duration',
  'compact_boundary',
  'local_command',
  'away_summary',
  'informational',
  'model_refusal_fallback',
]);

/** Attachment types listed in Appendix A (anything else → `unknownAttachmentTypes`). */
const KNOWN_ATTACHMENTS: ReadonlySet<string> = new Set([
  'total_tokens_reminder',
  'task_reminder',
  'edited_text_file',
  'batching_reminder_sent',
  'queued_command',
  'bash_output_audience_note',
  'file',
  'date_change',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'agent_listing_delta',
  'skill_listing',
  'task_status',
  'plan_mode',
  'compact_file_reference',
  'hook_system_message',
]);

/** Notification segment text is retained at most this long (parsing only, never rendered as a prompt). */
const NOTIFICATION_TEXT_CAP = 4096;

interface Counters {
  badLines: number;
  lineSeparatorChars: number;
  reorderedEvents: number;
  duplicateUuids: number;
  duplicateToolResults: number;
  bashWithoutToolUseResult: number;
  excludedSyntheticLines: number;
  records: number;
  unknownRecordTypes: Record<string, number>;
  unknownSubtypes: Record<string, number>;
  unknownToolShapes: Record<string, number>;
  unknownContentBlocks: Record<string, number>;
  unknownAttachmentTypes: Record<string, number>;
  legacyShapes: Record<string, number>;
}

function emptyCounters(): Counters {
  return {
    badLines: 0,
    lineSeparatorChars: 0,
    reorderedEvents: 0,
    duplicateUuids: 0,
    duplicateToolResults: 0,
    bashWithoutToolUseResult: 0,
    excludedSyntheticLines: 0,
    records: 0,
    unknownRecordTypes: {},
    unknownSubtypes: {},
    unknownToolShapes: {},
    unknownContentBlocks: {},
    unknownAttachmentTypes: {},
    legacyShapes: {},
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function emptyLedger(): Ledger {
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
    incomplete: false,
    incompleteReasons: [],
    opaqueTestCapable: 0,
    perTurn: {},
  };
}

function neutralCost(totals: UsageTotals): Cost {
  return {
    usd: null,
    apiCalls: totals.calls,
    input: totals.input,
    cacheRead: totals.cacheRead,
    cacheWrite5m: totals.cacheWrite5m,
    cacheWrite1h: totals.cacheWrite1h,
    cacheWriteOther: totals.cacheWriteOther,
    output: totals.output,
    thinking: totals.thinking,
    cacheHitPct: null,
    unverified: false,
    unpriced: [],
    apiEquivalent: true,
    pricesVersion: '',
    notes: [],
  };
}

/** The serialised shape (version-tagged; `resume` rejects other versions). */
interface SerializedState {
  v: 1;
  mode: 'main' | 'subagent';
  nextSeq: number;
  counters: Counters;
  activeMs: number | null;
  title: string | null;
  harnessVersion: string | null;
  harnessVersions: string[];
  sessionId: string | null;
  models: string[];
  cwds: string[];
  firstCwd: string | null;
  lastUserCwd: string | null;
  firstHumanSeen: boolean;
  firstHumanCwd: string | null;
  firstHumanGitBranch: string | null;
  tsMinIso: string | null;
  tsMaxIso: string | null;
  tsMinMs: number | null;
  tsMaxMs: number | null;
  lastTsMs: number | null;
  uuidParent: Record<string, string | null>;
  uuidPrompt: Record<string, string>;
  promptMemo: Record<string, string | null>;
  seenUuids: string[];
  resolvedToolIds: string[];
  pendingTools: Record<string, number>;
  toolCalls: ToolCall[];
  toolCallGroup: number[];
  groups: GroupState[];
  groupByPrompt: Record<string, number>;
  currentGroup: number;
  messages: MessageState[];
  messageIndex: Record<string, number>;
  compactions: Compaction[];
  compactionGroups: number[];
  prRefs: PrRef[];
  editedFiles: { seq: number; path: string }[];
  apiErrors: { error: string; status?: number }[];
  refusalFallbacks: RefusalFallback[];
  refusalByRequest: Record<string, string>;
  retracted: string[];
  interruptedMessageIds: string[];
  seeds: SpawnSeed[];
  orphanToolUse: Record<string, number>;
  sidechain: SidechainState;
}

/**
 * Streaming, resumable parser for one Claude Code transcript file. In
 * `subagent` mode finals are never computed, `stop_reason: null` partials
 * are expected, and every tool call / usage row carries the line's
 * `agentId`.
 */
export class SessionBuilder {
  readonly mode: 'main' | 'subagent';
  readonly home: string;
  private readonly ref: SessionRef;

  private nextSeq = 0;
  private readonly counters = emptyCounters();
  private activeMs: number | null = null;
  private title: string | null = null;
  private harnessVersion: string | null = null;
  private harnessVersions: string[] = [];
  private sessionId: string | null = null;
  private models: string[] = [];
  private cwds: string[] = [];
  private firstCwd: string | null = null;
  private lastUserCwd: string | null = null;
  private firstHumanSeen = false;
  private firstHumanCwd: string | null = null;
  private firstHumanGitBranch: string | null = null;
  private tsMinIso: string | null = null;
  private tsMaxIso: string | null = null;
  private tsMinMs: number | null = null;
  private tsMaxMs: number | null = null;
  private lastTsMs: number | null = null;

  private readonly uuidParent = new Map<string, string | null>();
  private readonly uuidPrompt = new Map<string, string>();
  private readonly promptMemo = new Map<string, string | null>();
  private readonly seenUuids = new Set<string>();
  private readonly resolvedToolIds = new Set<string>();
  private readonly pendingTools = new Map<string, number>();
  private readonly toolCalls: ToolCall[] = [];
  private readonly toolCallGroup: number[] = [];
  private readonly groups: GroupState[] = [];
  private readonly groupByPrompt = new Map<string, number>();
  private currentGroup = -1;
  private readonly messages: MessageState[] = [];
  private readonly messageIndex = new Map<string, number>();
  private readonly compactions: Compaction[] = [];
  private readonly compactionGroups: number[] = [];
  private readonly prRefs: PrRef[] = [];
  private readonly editedFiles: { seq: number; path: string }[] = [];
  private readonly apiErrors: { error: string; status?: number }[] = [];
  private readonly refusalFallbacks: RefusalFallback[] = [];
  private readonly refusalByRequest: Record<string, string> = {};
  private readonly retracted = new Set<string>();
  private readonly interruptedMessageIds = new Set<string>();
  private readonly seeds: SpawnSeed[] = [];
  /** toolUseId → index of the orphaned message awaiting forward attribution. */
  private readonly orphanToolUse = new Map<string, number>();
  private sidechain = new SidechainCollector();

  private readonly toolDiag: ToolDiag = {
    legacy: (shape) => bump(this.counters.legacyShapes, shape),
    unknownShape: (tool) => bump(this.counters.unknownToolShapes, tool),
    bashWithoutToolUseResult: () => {
      this.counters.bashWithoutToolUseResult++;
    },
  };

  constructor(ref: SessionRef, opts: BuilderOptions) {
    this.ref = ref;
    this.mode = opts.mode;
    this.home = opts.home;
  }

  /** True once an `ai-title` supplied the session title (reader stops parsing them). */
  hasTitle(): boolean {
    return this.title !== null;
  }

  /** Folds one `JsonlSummary`'s stream-level stats into the builder (call once per read pass). */
  noteSummary(summary: { lineSeparatorChars: number }): void {
    this.counters.lineSeparatorChars += summary.lineSeparatorChars;
  }

  /** The in-memory `SubagentSource` for inline sidechain chains (§4.2.9), or `null`. */
  sidechainSource(): SubagentSource | null {
    return this.sidechain.source();
  }

  /** Consumes one raw line. Never throws on malformed records. */
  feed(line: RawLine): void {
    const seq = this.nextSeq++;
    if (line.bad === true) {
      this.counters.badLines++;
      return;
    }
    if (line.countOnly === true) {
      this.counters.records++;
      return;
    }
    const json = line.json;
    if (json === undefined) return;
    const rec = asRecord(json);
    if (rec === null) {
      this.counters.records++;
      bump(this.counters.unknownRecordTypes, '(non-object)');
      return;
    }
    this.counters.records++;

    // Common per-record tracking: timestamps, cwd, version, session id.
    const tsIso = asString(rec['timestamp']);
    const tsMs = tsIso === null ? null : parseIso(tsIso);
    if (tsMs !== null && tsIso !== null) {
      if (this.lastTsMs !== null && tsMs < this.lastTsMs) this.counters.reorderedEvents++;
      this.lastTsMs = tsMs;
      if (this.tsMinMs === null || tsMs < this.tsMinMs) {
        this.tsMinMs = tsMs;
        this.tsMinIso = tsIso;
      }
      if (this.tsMaxMs === null || tsMs > this.tsMaxMs) {
        this.tsMaxMs = tsMs;
        this.tsMaxIso = tsIso;
      }
    }
    const cwd = asString(rec['cwd']);
    if (cwd !== null) {
      if (this.firstCwd === null) this.firstCwd = cwd;
      if (!this.cwds.includes(cwd)) this.cwds.push(cwd);
    }
    const version = asString(rec['version']);
    if (version !== null) {
      this.harnessVersion = version;
      if (!this.harnessVersions.includes(version)) this.harnessVersions.push(version);
    }
    if (this.sessionId === null) this.sessionId = asString(rec['sessionId']) ?? asString(rec['session_id']);

    // Dedupe: the first record per uuid wins (§4.2.3 step 2).
    const uuid = asString(rec['uuid']);
    if (uuid !== null) {
      if (this.seenUuids.has(uuid)) {
        this.counters.duplicateUuids++;
        return;
      }
      this.seenUuids.add(uuid);
    }

    // Inline sidechain chains in a main transcript are diverted (§4.2.9).
    if (this.mode === 'main' && rec['isSidechain'] === true) {
      this.sidechain.feed(rec);
      return;
    }

    let type = asString(rec['type']);
    if (type === null && asRecord(rec['attachment']) !== null) type = 'attachment';

    // Index uuid → parentUuid; a compact_boundary bridges to logicalParentUuid.
    if (uuid !== null) {
      const bridged =
        type === 'system' && rec['subtype'] === 'compact_boundary' ? (asString(rec['logicalParentUuid']) ?? asString(rec['parentUuid'])) : asString(rec['parentUuid']);
      this.uuidParent.set(uuid, bridged);
    }

    switch (type) {
      case 'user':
        this.onUser(rec, seq, uuid, tsIso, tsMs, version);
        return;
      case 'assistant':
        this.onAssistant(rec, seq, uuid, tsIso, tsMs, version);
        return;
      case 'system':
        this.onSystem(rec, seq, tsIso, tsMs);
        return;
      case 'attachment':
        this.onAttachment(rec, seq);
        return;
      case 'pr-link':
        this.onPrLink(rec, seq);
        return;
      case 'summary':
        // Legacy `type:'summary'` lines with `leafUuid` are ignored (§4.2.9).
        bump(this.counters.legacyShapes, 'summary');
        return;
      case 'ai-title': {
        const title = asString(rec['aiTitle']);
        if (title !== null && this.title === null) this.title = title;
        return;
      }
      default:
        if (type === null || !RECOGNISED_TYPES.has(type)) bump(this.counters.unknownRecordTypes, type ?? '(untyped)');
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Groups and attribution
  // -------------------------------------------------------------------------

  /** Walks `parentUuid` links to a user line with a promptId (memoised, §4.2.3 step 5). */
  private walkPrompt(from: string | null): string | null {
    const path: string[] = [];
    let cur = from;
    let out: string | null = null;
    let hops = 0;
    while (cur !== null && hops++ < 1_000_000) {
      const memo = this.promptMemo.get(cur);
      if (memo !== undefined) {
        out = memo;
        break;
      }
      const prompt = this.uuidPrompt.get(cur);
      if (prompt !== undefined) {
        out = prompt;
        break;
      }
      path.push(cur);
      const parent = this.uuidParent.get(cur);
      if (parent === undefined) break;
      cur = parent;
    }
    for (const u of path) this.promptMemo.set(u, out);
    return out;
  }

  private ensureGroup(promptId: string, seq: number, tsIso: string | null, tsMs: number | null, version: string | null): number {
    const existing = this.groupByPrompt.get(promptId);
    if (existing !== undefined) {
      if (existing !== this.currentGroup) this.counters.reorderedEvents++;
      this.currentGroup = existing;
      return existing;
    }
    const gi = this.groups.length;
    this.groups.push({
      promptId,
      trigger: null,
      userText: null,
      hasAssistant: false,
      sawMeta: false,
      classifiedUserLines: 0,
      seqStart: seq,
      seqEnd: seq,
      tsMin: tsIso,
      tsMax: tsIso,
      tsMinMs: tsMs,
      tsMaxMs: tsMs,
      firstUserVersion: version,
      notif: null,
      interruptSeqs: [],
      durationMs: null,
    });
    this.groupByPrompt.set(promptId, gi);
    this.currentGroup = gi;
    return gi;
  }

  private extendGroup(gi: number, seq: number, tsIso: string | null, tsMs: number | null): void {
    const g = this.groups[gi];
    if (g === undefined) return;
    g.seqStart = Math.min(g.seqStart, seq);
    g.seqEnd = Math.max(g.seqEnd, seq);
    if (tsMs !== null && tsIso !== null) {
      if (g.tsMinMs === null || tsMs < g.tsMinMs) {
        g.tsMinMs = tsMs;
        g.tsMin = tsIso;
      }
      if (g.tsMaxMs === null || tsMs > g.tsMaxMs) {
        g.tsMaxMs = tsMs;
        g.tsMax = tsIso;
      }
    }
  }

  /** Resolves a record without its own promptId: walk first, then file order (§4.2.3 step 5). */
  private resolveByWalk(parentUuid: string | null): { gi: number; walked: boolean } {
    const pid = this.walkPrompt(parentUuid);
    if (pid !== null) {
      const gi = this.groupByPrompt.get(pid);
      if (gi !== undefined) return { gi, walked: true };
    }
    return { gi: this.currentGroup, walked: false };
  }

  // -------------------------------------------------------------------------
  // Record handlers
  // -------------------------------------------------------------------------

  private onUser(rec: Record<string, unknown>, seq: number, uuid: string | null, tsIso: string | null, tsMs: number | null, version: string | null): void {
    const cwd = asString(rec['cwd']);
    if (cwd !== null) this.lastUserCwd = cwd;
    const promptId = asString(rec['promptId']);
    if (uuid !== null && promptId !== null) this.uuidPrompt.set(uuid, promptId);

    const message = asRecord(rec['message']);
    const content = message?.['content'];
    if (hasToolResultBlock(content) || rec['toolUseResult'] !== undefined) {
      this.onToolResults(rec, seq, uuid, tsIso, tsMs, version, promptId, content);
      return;
    }

    const cls = classifyUserLine(rec);
    if (cls.kind === 'results') return; // unreachable (handled above); kept for safety
    if (typeof rec['interruptedMessageId'] === 'string') this.interruptedMessageIds.add(rec['interruptedMessageId']);

    // A legacy conversation-root human/skill prompt (§4.2.9) carries no
    // promptId; anchor its turn under its own uuid so the walk reaches it.
    // Real transcripts always give human prompts a promptId, so this only
    // fires for a `parentUuid: null` root (never for a mid-chain stray).
    let effectivePromptId = promptId;
    if (effectivePromptId === null && uuid !== null && asString(rec['parentUuid']) === null && (cls.trigger === 'human' || cls.trigger === 'skill')) {
      effectivePromptId = uuid;
      this.uuidPrompt.set(uuid, uuid);
    }

    if (effectivePromptId === null) {
      // Never starts or ends a turn (§4.2.3 step 5): attach to the walked
      // group (then file order) for ranges / interrupt marking only.
      const { gi } = this.resolveByWalk(asString(rec['parentUuid']));
      if (uuid !== null) this.promptMemo.set(uuid, this.groups[gi]?.promptId ?? null);
      if (gi >= 0) {
        this.extendGroup(gi, seq, tsIso, tsMs);
        if (cls.trigger === 'interrupt') this.groups[gi]?.interruptSeqs.push(seq);
      }
      return;
    }

    const gi = this.ensureGroup(effectivePromptId, seq, tsIso, tsMs, version);
    this.extendGroup(gi, seq, tsIso, tsMs);
    const g = this.groups[gi];
    if (g === undefined) return;
    g.classifiedUserLines++;
    switch (cls.trigger) {
      case 'meta':
        g.sawMeta = true; // a meta-only group is still a continuation segment
        return; // meta lines never set the group trigger
      case 'interrupt':
        g.interruptSeqs.push(seq);
        if (g.trigger === null) g.trigger = 'interrupt';
        return;
      case 'notification': {
        if (g.trigger === null) g.trigger = 'notification';
        if (g.notif === null) {
          const text = cls.text;
          const parsed = parseTaskNotification(text ?? '');
          g.notif = {
            taskId: parsed.taskId,
            toolUseId: parsed.toolUseId,
            status: parsed.status,
            text: text === null ? null : text.slice(0, NOTIFICATION_TEXT_CAP),
          };
        }
        return;
      }
      case 'compact':
        if (g.trigger === null) g.trigger = 'compact';
        return;
      case 'local-command':
        if (g.trigger === null) g.trigger = 'local-command';
        return;
      case 'skill':
        if (g.trigger === null) {
          g.trigger = 'skill';
          g.userText = skillUserText(cls.text);
        }
        return;
      case 'human':
        if (g.trigger === null) {
          g.trigger = 'human';
          g.userText = cls.text;
        }
        if (!this.firstHumanSeen) {
          this.firstHumanSeen = true;
          this.firstHumanCwd = cwd;
          this.firstHumanGitBranch = asString(rec['gitBranch']);
        }
        return;
    }
  }

  private onToolResults(
    rec: Record<string, unknown>,
    seq: number,
    uuid: string | null,
    tsIso: string | null,
    tsMs: number | null,
    version: string | null,
    promptId: string | null,
    content: unknown,
  ): void {
    let gi: number;
    if (promptId !== null) {
      gi = this.ensureGroup(promptId, seq, tsIso, tsMs, version);
    } else {
      const resolved = this.resolveByWalk(asString(rec['parentUuid']));
      gi = resolved.gi;
      if (uuid !== null) this.promptMemo.set(uuid, this.groups[gi]?.promptId ?? null);
    }
    if (gi >= 0) this.extendGroup(gi, seq, tsIso, tsMs);

    const blocks = Array.isArray(content) ? content : [];
    let toolUseResultUsed = false;
    for (const item of blocks) {
      const block = asRecord(item);
      if (block === null) continue;
      const blockType = asString(block['type']);
      if (blockType !== 'tool_result') {
        if (blockType !== 'text') bump(this.counters.unknownContentBlocks, blockType ?? '(untyped)');
        continue;
      }
      // Unknown inner content blocks of the result (images, tool_reference, …).
      const inner = block['content'];
      if (Array.isArray(inner)) {
        for (const innerItem of inner) {
          const innerBlock = asRecord(innerItem);
          const innerType = innerBlock === null ? null : asString(innerBlock['type']);
          if (innerType !== null && innerType !== 'text') bump(this.counters.unknownContentBlocks, innerType);
        }
      }
      const toolUseId = asString(block['tool_use_id']);
      if (toolUseId === null) continue;
      if (this.resolvedToolIds.has(toolUseId)) {
        this.counters.duplicateToolResults++;
        continue;
      }
      this.resolvedToolIds.add(toolUseId);
      // Forward attribution: a promptId on the result line rescues the
      // orphaned assistant that opened this tool_use (its upward parent was
      // cut). Its usage and tool call move to this group.
      if (promptId !== null && gi >= 0) {
        const orphanMi = this.orphanToolUse.get(toolUseId);
        if (orphanMi !== undefined) {
          const orphanMsg = this.messages[orphanMi];
          if (orphanMsg !== undefined && !orphanMsg.resolved) {
            orphanMsg.resolved = true;
            orphanMsg.groupIndex = gi;
            orphanMsg.lastGroupIndex = gi;
            const callIdx = this.pendingTools.get(toolUseId);
            if (callIdx !== undefined) this.toolCallGroup[callIdx] = gi;
          }
          this.orphanToolUse.delete(toolUseId);
        }
      }
      const idx = this.pendingTools.get(toolUseId);
      if (idx === undefined) continue; // result without a recorded tool_use (window cut)
      this.pendingTools.delete(toolUseId);
      const call = this.toolCalls[idx];
      if (call === undefined) continue;
      const hasToolUseResult = 'toolUseResult' in rec && !toolUseResultUsed;
      const seed = completeToolCall(
        call,
        {
          ts: tsIso ?? '',
          content: block['content'],
          isError: block['is_error'] === true,
          hasToolUseResult,
          toolUseResult: hasToolUseResult ? rec['toolUseResult'] : undefined,
          toolDenialKind: rec['toolDenialKind'],
        },
        this.toolDiag,
      );
      if (hasToolUseResult) toolUseResultUsed = true;
      if (seed !== null) this.seeds.push(seed);
    }
  }

  private onAssistant(rec: Record<string, unknown>, seq: number, uuid: string | null, tsIso: string | null, tsMs: number | null, version: string | null): void {
    const message = asRecord(rec['message']);
    if (message === null) {
      bump(this.counters.unknownRecordTypes, 'assistant(no-message)');
      return;
    }
    const model = asString(message['model']) ?? '';
    const apiError = rec['isApiErrorMessage'] === true;
    const synthetic = model === '<synthetic>' || apiError;
    const agentId = this.mode === 'subagent' ? asString(rec['agentId']) : null;

    // Core-shape counters (§12.2 exit 4, read by `readers/problems.ts`): a
    // non-synthetic assistant line must carry `message.model` and a usable
    // `message.usage`. Zero on all real data; a warning count like every
    // other unknown-record diagnostic.
    if (!synthetic) {
      if (model === '') bump(this.counters.unknownRecordTypes, 'assistant(no-model)');
      if (!isRawUsage(message['usage'])) bump(this.counters.unknownRecordTypes, 'assistant(no-usage)');
    }

    const resolved = this.resolveByWalk(asString(rec['parentUuid']));
    const gi = resolved.gi;
    if (uuid !== null) this.promptMemo.set(uuid, resolved.walked ? (this.groups[gi]?.promptId ?? null) : null);
    if (gi >= 0) {
      this.extendGroup(gi, seq, tsIso, tsMs);
      const g = this.groups[gi];
      if (g !== undefined) g.hasAssistant = true;
    }

    if (synthetic) {
      this.counters.excludedSyntheticLines++;
      const error = asString(rec['error']);
      if (error !== null || apiError) {
        const entry: { error: string; status?: number } = { error: error ?? 'api-error' };
        const status = asNumber(rec['apiErrorStatus']);
        if (status !== null) entry.status = status;
        this.apiErrors.push(entry);
      }
    } else if (model !== '' && !this.models.includes(model)) {
      this.models.push(model);
    }

    const key = asString(message['id']) ?? asString(rec['requestId']) ?? uuid ?? `line-${seq}`;
    let mi = this.messageIndex.get(key);
    if (mi === undefined) {
      mi = this.messages.length;
      this.messageIndex.set(key, mi);
      this.messages.push({
        key,
        requestId: asString(rec['requestId']),
        model,
        usage: null,
        completed: false,
        maxOut: 0,
        seq,
        ts: tsIso ?? '',
        agentId,
        groupIndex: gi,
        stopReason: null,
        resolved: resolved.walked,
        excluded: false,
        sidechain: false,
        texts: [],
        uuids: [],
        lastSeq: seq,
        lastTs: tsIso ?? '',
        lastGroupIndex: gi,
        version,
      });
    }
    const msg = this.messages[mi];
    if (msg === undefined) return;
    msg.lastSeq = seq;
    msg.lastTs = tsIso ?? msg.lastTs;
    // A later line of the message that resolved upward fixes the attribution.
    if (resolved.walked) {
      msg.resolved = true;
      msg.groupIndex = gi;
      msg.lastGroupIndex = gi;
    } else if (msg.resolved) {
      msg.lastGroupIndex = msg.groupIndex; // keep the known-good group
    } else {
      msg.lastGroupIndex = gi;
    }
    if (version !== null) msg.version = version;
    if (uuid !== null) msg.uuids.push(uuid);
    if (synthetic) msg.excluded = true;
    if (rec['isSidechain'] === true && this.mode === 'main') msg.sidechain = true;
    if (model !== '') msg.model = model;
    const stopReason = asString(message['stop_reason']);
    if (stopReason !== null) msg.stopReason = stopReason;

    const content = message['content'];
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = asRecord(content[i]);
        if (block === null) continue;
        const blockType = asString(block['type']);
        if (blockType === 'text') {
          const text = asString(block['text']);
          if (text !== null && text !== '') noteMessageText(msg, seq, text);
          continue;
        }
        if (blockType === 'thinking' || blockType === 'redacted_thinking') continue;
        if (blockType === 'tool_use') {
          if (synthetic) continue; // synthetic lines never open tool calls
          this.onToolUse(block, seq, i, gi, agentId, tsIso, msg.resolved ? -1 : mi);
          continue;
        }
        // `fallback` (§4.2.3 step 8), `tool_reference`, images, … — counted, ignored.
        bump(this.counters.unknownContentBlocks, blockType ?? '(untyped)');
      }
    }

    const usage = message['usage'];
    if (!synthetic && isRawUsage(usage)) {
      if (usage.cache_creation === undefined && (usage.cache_creation_input_tokens ?? 0) > 0) {
        bump(this.counters.legacyShapes, 'no-cache-breakdown');
      }
      noteUsageLine(msg, { usage, stopReason, model, seq, ts: tsIso ?? '', agentId, groupIndex: gi });
    }
  }

  private onToolUse(block: Record<string, unknown>, seq: number, blockIndex: number, gi: number, agentId: string | null, tsIso: string | null, orphanMsgIndex: number): void {
    const id = asString(block['id']) ?? `tooluse-${seq}-${blockIndex}`;
    const rawName = asString(block['name']) ?? '(unnamed)';
    const mapped = legacyToolName(rawName);
    if (mapped.legacyShape !== null) bump(this.counters.legacyShapes, mapped.legacyShape);
    if (this.pendingTools.has(id) || this.resolvedToolIds.has(id)) return; // first tool_use per id wins
    // An orphaned assistant (upward walk cut by a windowed fixture) can be
    // attributed forward when its tool_result carries a promptId (§4.2.3 step 5).
    if (orphanMsgIndex >= 0) this.orphanToolUse.set(id, orphanMsgIndex);
    const call = newToolCall({
      seq,
      id,
      tool: mapped.tool,
      input: block['input'],
      agentId,
      // §4.5.3: the nearest preceding user line's cwd, never the assistant line's own.
      cwd: this.lastUserCwd ?? this.firstCwd ?? '',
      startedAt: tsIso ?? '',
    });
    this.pendingTools.set(id, this.toolCalls.length);
    this.toolCalls.push(call);
    this.toolCallGroup.push(gi);
  }

  private onSystem(rec: Record<string, unknown>, seq: number, tsIso: string | null, tsMs: number | null): void {
    const subtype = asString(rec['subtype']);
    switch (subtype) {
      case 'turn_duration': {
        const duration = asNumber(rec['durationMs']) ?? 0;
        this.activeMs = (this.activeMs ?? 0) + duration;
        const { gi } = this.resolveByWalk(asString(rec['parentUuid']));
        if (gi >= 0) {
          this.extendGroup(gi, seq, tsIso, tsMs);
          const g = this.groups[gi];
          if (g !== undefined) g.durationMs = (g.durationMs ?? 0) + duration;
        }
        return;
      }
      case 'compact_boundary': {
        const meta = asRecord(rec['compactMetadata']);
        const compaction: Compaction = {
          seq,
          trigger: (meta === null ? null : asString(meta['trigger'])) ?? 'unknown',
          preTokens: (meta === null ? null : asNumber(meta['preTokens'])) ?? 0,
          postTokens: (meta === null ? null : asNumber(meta['postTokens'])) ?? 0,
        };
        const dropped = meta === null ? null : asNumber(meta['cumulativeDroppedTokens']);
        if (dropped !== null) compaction.cumulativeDroppedTokens = dropped;
        const duration = meta === null ? null : asNumber(meta['durationMs']);
        if (duration !== null) compaction.durationMs = duration;
        this.compactions.push(compaction);
        this.compactionGroups.push(this.currentGroup);
        return;
      }
      case 'local_command':
      case 'away_summary':
      case 'informational': {
        const { gi } = this.resolveByWalk(asString(rec['parentUuid']));
        if (gi >= 0) this.extendGroup(gi, seq, tsIso, tsMs);
        return;
      }
      case 'model_refusal_fallback': {
        const originalModel = asString(rec['originalModel']);
        const fallbackModel = asString(rec['fallbackModel']);
        if (originalModel !== null && fallbackModel !== null) {
          const fallback: RefusalFallback = { seq, originalModel, fallbackModel };
          const category = asString(rec['apiRefusalCategory']);
          if (category !== null) fallback.category = category;
          this.refusalFallbacks.push(fallback);
          if (!this.models.includes(fallbackModel)) this.models.push(fallbackModel);
          const requestId = asString(rec['requestId']);
          if (requestId !== null) this.refusalByRequest[requestId] = originalModel;
        }
        const retracted = rec['retractedMessageUuids'];
        if (Array.isArray(retracted)) {
          for (const r of retracted) {
            const id = asString(r);
            if (id !== null) this.retracted.add(id);
          }
        }
        return;
      }
      default:
        if (subtype === null || !RECOGNISED_SUBTYPES.has(subtype)) bump(this.counters.unknownSubtypes, subtype ?? '(none)');
    }
  }

  private onAttachment(rec: Record<string, unknown>, seq: number): void {
    const attachment = asRecord(rec['attachment']);
    const type = attachment === null ? null : asString(attachment['type']);
    if (type === null) {
      bump(this.counters.unknownAttachmentTypes, '(untyped)');
      return;
    }
    if (type === 'edited_text_file') {
      const path = asString(attachment?.['filename']);
      if (path !== null) this.editedFiles.push({ seq, path });
      return;
    }
    if (!KNOWN_ATTACHMENTS.has(type)) bump(this.counters.unknownAttachmentTypes, type);
  }

  private onPrLink(rec: Record<string, unknown>, seq: number): void {
    const prNumber = asNumber(rec['prNumber']);
    const prUrl = asString(rec['prUrl']);
    if (prNumber === null || prUrl === null) return;
    this.prRefs.push({
      seq,
      prNumber,
      prUrl,
      prRepository: asString(rec['prRepository']) ?? '',
      time: asString(rec['timestamp']) ?? '',
    });
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  private buildSubagentInfos(): SubagentInfo[] {
    const infos: SubagentInfo[] = [];
    for (const seed of this.seeds) {
      if (seed.tool === 'Agent' && seed.agentId !== null) {
        const info: SubagentInfo = {
          agentId: seed.agentId,
          parentAgentId: null,
          spawnedBy: { tool: 'Agent', toolUseId: seed.toolUseId },
          toolCalls: 0,
          startedAt: seed.startedAt,
          endedAt: seed.endedAt,
          finished: !seed.isAsync,
        };
        if (seed.description !== null) info.description = seed.description;
        if (seed.resolvedModel !== null) info.model = seed.resolvedModel;
        infos.push(info);
        continue;
      }
      if (seed.tool === 'Workflow' && seed.runId !== null) {
        // Workflow transcript directories are named `wf_<runId>` (§4.2.6);
        // S07 links files to this record by that key or by `transcriptDir`.
        // Observed runIds already carry the `wf_` prefix (2.1.241); prefix
        // only when absent so the key always equals the directory name.
        const info: SubagentInfo = {
          agentId: seed.runId.startsWith('wf_') ? seed.runId : `wf_${seed.runId}`,
          parentAgentId: null,
          spawnedBy: { tool: 'Workflow', runId: seed.runId, toolUseId: seed.toolUseId },
          agentType: 'workflow',
          toolCalls: 0,
          startedAt: seed.startedAt,
          endedAt: seed.endedAt,
          finished: false,
        };
        const description = seed.workflowName ?? seed.description ?? seed.transcriptDir;
        if (description !== null) info.description = description;
        infos.push(info);
      }
    }
    return infos;
  }

  /**
   * Assembles the `Session`. Pure over the accumulated state (idempotent):
   * `finish()` may be called again after further `feed()`s and everything —
   * turns, finals, usage, diagnostics — is recomputed.
   */
  finish(): Session {
    const assembled = assembleTurns(this.groups, this.messages, this.retracted, this.compactionGroups, this.mode);

    // Usage rows (§4.2.7) and totals.
    const rows: UsageRow[] = [];
    const rowMeta: { thinking: number; groupIndex: number }[] = [];
    let incompleteMessages = 0;
    for (const msg of this.messages) {
      if (msg.excluded || msg.usage === null) continue;
      const row = buildUsageRow(msg, this.refusalByRequest);
      if (row === null) continue;
      if (row.incomplete === true && this.interruptedMessageIds.has(row.messageId)) {
        // §4.2.2: an interrupted stream is billed once and flagged
        // `interrupted` — a known interruption, not one of §4.2.7's
        // unknown-output incomplete responses.
        delete row.incomplete;
        row.interrupted = true;
      }
      if (row.incomplete === true) incompleteMessages++;
      rows.push(row);
      rowMeta.push({ thinking: thinkingOf(msg.usage), groupIndex: msg.groupIndex });
    }
    const order = rows.map((_, i) => i).sort((a, b) => (rows[a]?.seq ?? 0) - (rows[b]?.seq ?? 0));
    const usageRows = order.map((i) => rows[i]).filter((r): r is UsageRow => r !== undefined);
    const totals = emptyTotals();
    for (const i of order) {
      const row = rows[i];
      const meta = rowMeta[i];
      if (row === undefined || meta === undefined) continue;
      addRowToTotals(totals, row, meta.thinking);
      const ti = assembled.groupTurn[meta.groupIndex];
      if (ti !== undefined && ti >= 0) {
        const turn = assembled.turns[ti];
        if (turn !== undefined) {
          addRowToTotals(turn.usage, row, meta.thinking);
          turn.apiCalls++;
        }
      }
    }

    // Tool-call turn attribution.
    for (let i = 0; i < this.toolCalls.length; i++) {
      const call = this.toolCalls[i];
      if (call === undefined) continue;
      const gi = this.toolCallGroup[i] ?? -1;
      call.turnIndex = gi >= 0 ? (assembled.groupTurn[gi] ?? -1) : -1;
    }

    // Orphans: assistant messages whose attribution was never found — neither
    // the upward parentUuid walk nor a forward tool_result promptId (§4.2.3
    // step 5). Zero on the materialised real fixtures.
    const orphanAssistantLines = this.messages.reduce((n, m) => n + (m.resolved ? 0 : 1), 0);

    // Diagnostics (fresh copies so finish() stays idempotent).
    const c = this.counters;
    const legacyShapes = { ...c.legacyShapes };
    const chains = this.sidechain.chainCount();
    if (chains > 0) legacyShapes['inline-sidechain'] = chains;
    const notes: string[] = [];
    if (this.pendingTools.size > 0) notes.push(`${this.pendingTools.size} tool call(s) without a result (no-result)`);
    const diagnostics: Diagnostics = {
      unknownRecordTypes: { ...c.unknownRecordTypes },
      unknownSubtypes: { ...c.unknownSubtypes },
      unknownToolShapes: { ...c.unknownToolShapes },
      unknownContentBlocks: { ...c.unknownContentBlocks },
      unknownCodexPayloads: {},
      badLines: c.badLines,
      lineSeparatorChars: c.lineSeparatorChars,
      reorderedEvents: c.reorderedEvents,
      duplicateUuids: c.duplicateUuids,
      duplicateToolResults: c.duplicateToolResults,
      negativeDeltas: 0,
      orphanAssistantLines,
      notificationPrompts: assembled.notificationPrompts,
      localCommandPrompts: assembled.localCommandPrompts,
      incompleteMessages,
      bashWithoutToolUseResult: c.bashWithoutToolUseResult,
      legacyShapes,
      subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
      notes,
      interimFinals: assembled.interimFinalsTotal,
      emptySessions: 0,
      excludedSyntheticLines: c.excludedSyntheticLines,
      unknownAttachmentTypes: { ...c.unknownAttachmentTypes },
      journals: 0,
      unrecognisedFiles: 0,
      orphanSessionDirs: 0,
      emptyProjects: 0,
      corruptCache: 0,
      copilotTranscriptUnparsed: 0,
      records: c.records,
    };

    const sessionId = this.sessionId ?? this.ref.sessionId;
    const models = [...this.models];
    let primaryModel = '';
    let bestOut = -1;
    const candidates = [...models, ...Object.keys(totals.byModel).filter((m) => !models.includes(m))];
    for (const model of candidates) {
      const sub = totals.byModel[model];
      if (sub !== undefined && sub.output > bestOut) {
        bestOut = sub.output;
        primaryModel = model;
      }
    }
    if (primaryModel === '') primaryModel = models[0] ?? 'unknown';

    const startedAt = this.tsMinIso ?? '';
    const endedAt = this.tsMaxIso ?? '';
    const durationMs = this.tsMinMs !== null && this.tsMaxMs !== null ? this.tsMaxMs - this.tsMinMs : 0;
    const spansDays = this.tsMinMs !== null && this.tsMaxMs !== null ? calendarDaysBetween(this.tsMinMs, this.tsMaxMs, 'utc') + 1 : 0;

    const session: Session = {
      harness: 'claude-code',
      harnessVersion: this.harnessVersion,
      harnessVersions: [...this.harnessVersions],
      sessionId,
      shortId: shortId('claude-code', sessionId),
      source: 'transcript',
      transcriptPath: this.ref.path !== '' ? this.ref.path : null,
      cwd: this.firstHumanCwd ?? this.firstCwd ?? '',
      cwds: [...this.cwds],
      repoRoot: null, // the pipeline fills it (S18)
      gitBranch: this.firstHumanGitBranch,
      title: this.title,
      models,
      primaryModel,
      startedAt,
      endedAt,
      durationMs,
      activeMs: this.activeMs,
      turns: assembled.turns,
      preamble: assembled.preamble,
      toolCalls: [...this.toolCalls],
      ledger: emptyLedger(),
      usage: totals,
      cost: neutralCost(totals),
      compactions: [...this.compactions],
      subagents: this.buildSubagentInfos(),
      prRefs: [...this.prRefs],
      apiErrors: this.apiErrors.map((e) => ({ ...e })),
      refusalFallbacks: this.refusalFallbacks.map((f) => ({ ...f })),
      diagnostics,
      usageRows,
      tokenDeltas: [],
      kind: c.records === 0 ? 'empty' : assembled.turns.length === 0 ? 'no-turns' : 'normal',
      records: c.records,
      spansDays,
      editedFiles: this.editedFiles.map((e) => ({ ...e })),
    };

    // Notification effects: exit codes and subagent completions (§4.2.3 step 4).
    const applySegments = (segments: readonly Segment[]): void => {
      for (const seg of segments) {
        if (seg.trigger === 'notification') applyNotification(session, seg);
      }
    };
    applySegments(session.preamble);
    for (const turn of session.turns) applySegments(turn.segments);

    return session;
  }

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  /** Serialises everything needed to continue feeding after `bytesParsed` (§4.9). */
  serialize(): string {
    const state: SerializedState = {
      v: 1,
      mode: this.mode,
      nextSeq: this.nextSeq,
      counters: this.counters,
      activeMs: this.activeMs,
      title: this.title,
      harnessVersion: this.harnessVersion,
      harnessVersions: this.harnessVersions,
      sessionId: this.sessionId,
      models: this.models,
      cwds: this.cwds,
      firstCwd: this.firstCwd,
      lastUserCwd: this.lastUserCwd,
      firstHumanSeen: this.firstHumanSeen,
      firstHumanCwd: this.firstHumanCwd,
      firstHumanGitBranch: this.firstHumanGitBranch,
      tsMinIso: this.tsMinIso,
      tsMaxIso: this.tsMaxIso,
      tsMinMs: this.tsMinMs,
      tsMaxMs: this.tsMaxMs,
      lastTsMs: this.lastTsMs,
      uuidParent: Object.fromEntries(this.uuidParent),
      uuidPrompt: Object.fromEntries(this.uuidPrompt),
      promptMemo: Object.fromEntries(this.promptMemo),
      seenUuids: [...this.seenUuids],
      resolvedToolIds: [...this.resolvedToolIds],
      pendingTools: Object.fromEntries(this.pendingTools),
      toolCalls: this.toolCalls,
      toolCallGroup: this.toolCallGroup,
      groups: this.groups,
      groupByPrompt: Object.fromEntries(this.groupByPrompt),
      currentGroup: this.currentGroup,
      messages: this.messages,
      messageIndex: Object.fromEntries(this.messageIndex),
      compactions: this.compactions,
      compactionGroups: this.compactionGroups,
      prRefs: this.prRefs,
      editedFiles: this.editedFiles,
      apiErrors: this.apiErrors,
      refusalFallbacks: this.refusalFallbacks,
      refusalByRequest: this.refusalByRequest,
      retracted: [...this.retracted],
      interruptedMessageIds: [...this.interruptedMessageIds],
      seeds: this.seeds,
      orphanToolUse: Object.fromEntries(this.orphanToolUse),
      sidechain: this.sidechain.state(),
    };
    return JSON.stringify(state);
  }

  /** Restores a builder from `serialize()` output. Throws on a foreign or corrupt state. */
  static resume(state: string, ref: SessionRef, opts: BuilderOptions): SessionBuilder {
    const parsed = JSON.parse(state) as SerializedState;
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('SessionBuilder.resume: unsupported state');
    if (parsed.mode !== opts.mode) throw new Error('SessionBuilder.resume: mode mismatch');
    const b = new SessionBuilder(ref, opts);
    b.nextSeq = parsed.nextSeq;
    Object.assign(b.counters, parsed.counters);
    b.activeMs = parsed.activeMs;
    b.title = parsed.title;
    b.harnessVersion = parsed.harnessVersion;
    b.harnessVersions = [...parsed.harnessVersions];
    b.sessionId = parsed.sessionId;
    b.models = [...parsed.models];
    b.cwds = [...parsed.cwds];
    b.firstCwd = parsed.firstCwd;
    b.lastUserCwd = parsed.lastUserCwd;
    b.firstHumanSeen = parsed.firstHumanSeen;
    b.firstHumanCwd = parsed.firstHumanCwd;
    b.firstHumanGitBranch = parsed.firstHumanGitBranch;
    b.tsMinIso = parsed.tsMinIso;
    b.tsMaxIso = parsed.tsMaxIso;
    b.tsMinMs = parsed.tsMinMs;
    b.tsMaxMs = parsed.tsMaxMs;
    b.lastTsMs = parsed.lastTsMs;
    for (const [k, v] of Object.entries(parsed.uuidParent)) b.uuidParent.set(k, v);
    for (const [k, v] of Object.entries(parsed.uuidPrompt)) b.uuidPrompt.set(k, v);
    for (const [k, v] of Object.entries(parsed.promptMemo)) b.promptMemo.set(k, v ?? null);
    for (const u of parsed.seenUuids) b.seenUuids.add(u);
    for (const id of parsed.resolvedToolIds) b.resolvedToolIds.add(id);
    for (const [k, v] of Object.entries(parsed.pendingTools)) b.pendingTools.set(k, v);
    b.toolCalls.push(...parsed.toolCalls);
    b.toolCallGroup.push(...parsed.toolCallGroup);
    b.groups.push(...parsed.groups);
    for (const [k, v] of Object.entries(parsed.groupByPrompt)) b.groupByPrompt.set(k, v);
    b.currentGroup = parsed.currentGroup;
    b.messages.push(...parsed.messages);
    for (const [k, v] of Object.entries(parsed.messageIndex)) b.messageIndex.set(k, v);
    b.compactions.push(...parsed.compactions);
    b.compactionGroups.push(...parsed.compactionGroups);
    b.prRefs.push(...parsed.prRefs);
    b.editedFiles.push(...parsed.editedFiles);
    b.apiErrors.push(...parsed.apiErrors);
    b.refusalFallbacks.push(...parsed.refusalFallbacks);
    Object.assign(b.refusalByRequest, parsed.refusalByRequest);
    for (const r of parsed.retracted) b.retracted.add(r);
    for (const id of parsed.interruptedMessageIds) b.interruptedMessageIds.add(id);
    b.seeds.push(...parsed.seeds);
    for (const [k, v] of Object.entries(parsed.orphanToolUse ?? {})) b.orphanToolUse.set(k, v);
    b.sidechain = new SidechainCollector(parsed.sidechain);
    return b;
  }
}
