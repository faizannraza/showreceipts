/**
 * Turn building (ARCHITECTURE §4.2.3, Appendix E "continuation segments"):
 * user-line classification, promptId grouping, group disposition (turn /
 * continuation segment / local-command prompt) and final-message selection.
 * The `SessionBuilder` (builder.ts) feeds the serialisable `GroupState` /
 * `MessageState` records; `assembleTurns` is a pure function over them, so a
 * resumed builder reproduces the single-pass result exactly.
 */
import type { Segment, Trigger, Turn } from '../../model/types.js';
import { asRecord, asString } from './records.js';
import { emptyTotals, type UsageGroupState } from './usage.js';

/** One promptId group as accumulated during the feed (serialisable). */
export interface GroupState {
  promptId: string;
  /** Trigger of the first classified non-meta user line; `null` until one arrives. */
  trigger: Trigger | null;
  /** The human prompt / skill argument text (never notification text). */
  userText: string | null;
  hasAssistant: boolean;
  /** A `meta` / `<system-reminder>` line was seen (a meta-only group is still a continuation segment). */
  sawMeta: boolean;
  /** Classified (non-result) user lines seen. */
  classifiedUserLines: number;
  seqStart: number;
  seqEnd: number;
  tsMin: string | null;
  tsMax: string | null;
  /** Parsed epoch ms of `tsMin`/`tsMax` (comparisons never trust string order). */
  tsMinMs: number | null;
  tsMaxMs: number | null;
  /** `version` of the group's first user line (turn fallback harness version). */
  firstUserVersion: string | null;
  /** Parsed `<task-notification>` fields (trigger `notification` groups). */
  notif: { taskId: string | null; toolUseId: string | null; status: string | null; text: string | null } | null;
  /** Seqs of interrupt user lines attached to this group (with or without promptId). */
  interruptSeqs: number[];
  /** Σ `system/turn_duration.durationMs` attributed to this group; `null` when none. */
  durationMs: number | null;
}

/** One assistant message (grouped by `message.id`) as accumulated during the feed (serialisable). */
export interface MessageState extends UsageGroupState {
  /** Last non-null `stop_reason` seen for the message. */
  stopReason: string | null;
  /** Attribution to a promptId group was found (upward walk, or a forward tool_result link). */
  resolved: boolean;
  /** Synthetic (`<synthetic>` model) or API-error message — never a final, never usage. */
  excluded: boolean;
  /** `isSidechain: true` on any line (never a final). */
  sidechain: boolean;
  /** Non-empty `text` blocks in file order. */
  texts: { seq: number; text: string }[];
  /** Line uuids of the message (retraction check). */
  uuids: string[];
  lastSeq: number;
  lastTs: string;
  /** Group of the message's last line (final attribution + `finalTrigger`). */
  lastGroupIndex: number;
  /** `version` of the message's last line (turn harness version via the final). */
  version: string | null;
}

/** How one user line classifies (§4.2.3 step 3). */
export type UserClass = { kind: 'results' } | { kind: 'trigger'; trigger: Exclude<Trigger, 'relogin'>; text: string | null };

/**
 * The plain text of a message content value: the string itself, or the
 * non-empty `text` blocks of a block list joined with `\n\n`; `null` when
 * neither yields text.
 */
export function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block !== null && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** True when the content list contains a `tool_result` block. */
export function hasToolResultBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const block = asRecord(item);
    return block !== null && block['type'] === 'tool_result';
  });
}

/** Content that is exactly one (or more) `<system-reminder>` wrapper and nothing else. */
function isSystemReminderOnly(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>');
}

/**
 * Classifies one user line in the §4.2.3 order: `tool_result` content →
 * results; else interrupt → compact → notification → meta → local-command →
 * skill → human. One deliberate deviation from the listed order: the
 * notification check runs before `isMeta`, because every observed
 * `task-notification` line also carries `isMeta: true` (Appendix A) and the
 * `notification` trigger would otherwise be unreachable.
 */
export function classifyUserLine(rec: Record<string, unknown>): UserClass {
  const message = asRecord(rec['message']);
  const content = message?.['content'];
  if (hasToolResultBlock(content)) return { kind: 'results' };
  const text = contentText(content);
  if (typeof rec['interruptedMessageId'] === 'string' || (text !== null && text.startsWith('[Request interrupted'))) {
    return { kind: 'trigger', trigger: 'interrupt', text };
  }
  if (rec['isCompactSummary'] === true) return { kind: 'trigger', trigger: 'compact', text };
  const origin = asRecord(rec['origin']);
  const originKind = origin === null ? null : asString(origin['kind']);
  if (originKind === 'task-notification' || (text !== null && text.startsWith('<task-notification>'))) {
    return { kind: 'trigger', trigger: 'notification', text };
  }
  const companion = rec['turnCompanion'];
  if (rec['isMeta'] === true || (companion !== undefined && companion !== false && companion !== null) || isSystemReminderOnly(text)) {
    return { kind: 'trigger', trigger: 'meta', text };
  }
  if (text !== null && (text.startsWith('<local-command-caveat>') || text.startsWith('<local-command-stdout>'))) {
    return { kind: 'trigger', trigger: 'local-command', text };
  }
  if (text !== null && (text.startsWith('<command-message>') || text.startsWith('<command-name>'))) {
    return { kind: 'trigger', trigger: 'skill', text };
  }
  const promptSource = asString(rec['promptSource']);
  if (originKind === 'human' || promptSource === 'typed' || promptSource === 'suggestion_accepted') {
    return { kind: 'trigger', trigger: 'human', text };
  }
  if (rec['origin'] === undefined && rec['promptSource'] === undefined && text !== null) {
    return { kind: 'trigger', trigger: 'human', text };
  }
  return { kind: 'trigger', trigger: 'meta', text };
}

/** `<command-args>` when non-empty, else the `<command-name>`, else the raw text (skill turns). */
export function skillUserText(text: string | null): string | null {
  if (text === null) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  if (args !== undefined && args !== '') return args;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name !== undefined && name !== '') return name;
  return text;
}

/** What `assembleTurns` produces (per-turn usage/apiCalls are filled by the builder afterwards). */
export interface AssembledTurns {
  turns: Turn[];
  preamble: Segment[];
  /** groupIndex → turnIndex; `-1` for preamble segments and local-command prompts. */
  groupTurn: number[];
  /** The final message chosen per turn (`null` when the turn has none). */
  finalsByTurn: (MessageState | null)[];
  localCommandPrompts: number;
  notificationPrompts: number;
  interimFinalsTotal: number;
}

function isEligibleFinal(msg: MessageState, retracted: ReadonlySet<string>): boolean {
  if (msg.excluded || msg.sidechain) return false;
  if (msg.stopReason !== 'end_turn') return false;
  if (msg.model === '<synthetic>') return false;
  if (msg.uuids.some((u) => retracted.has(u))) return false;
  return msg.texts.some((t) => t.text.trim() !== '');
}

function groupSegment(group: GroupState, trigger: Trigger): Segment {
  const seg: Segment = { trigger, promptId: group.promptId, seqStart: group.seqStart, seqEnd: group.seqEnd };
  if (group.notif !== null) {
    if (group.notif.text !== null) seg.text = group.notif.text;
    if (group.notif.taskId !== null) seg.taskId = group.notif.taskId;
    if (group.notif.toolUseId !== null) seg.toolUseId = group.notif.toolUseId;
    if (group.notif.status !== null) seg.status = group.notif.status;
  }
  return seg;
}

const SEGMENT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>(['notification', 'compact', 'meta', 'interrupt']);

/**
 * Builds the turn list from the accumulated groups and messages (§4.2.3
 * steps 4–8). Group disposition, in order: `human` groups open a turn;
 * `skill` groups with ≥ 1 assistant line open a turn; `notification` /
 * `compact` / `meta` / `interrupt` groups are continuation segments on the
 * most recent turn (or the session preamble before the first turn); any
 * other group with an assistant line is also a continuation segment; the
 * rest — local-command-only groups and assistant-less non-human groups —
 * are local-command prompts, not turns. Finals are never computed in
 * `subagent` mode.
 */
export function assembleTurns(
  groups: readonly GroupState[],
  messages: readonly MessageState[],
  retracted: ReadonlySet<string>,
  compactionGroupIndexes: readonly number[],
  mode: 'main' | 'subagent',
): AssembledTurns {
  const turns: Turn[] = [];
  const preamble: Segment[] = [];
  const groupTurn: number[] = [];
  const turnGroups: number[][] = [];
  let localCommandPrompts = 0;
  let notificationPrompts = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (group === undefined) continue;
    // Disposition trigger: the first non-meta line's trigger, else `meta`
    // when only meta/<system-reminder> lines were seen (still a continuation).
    const trigger = group.trigger ?? (group.sawMeta ? 'meta' : null);
    const opensTurn = trigger === 'human' || (trigger === 'skill' && group.hasAssistant);
    if (opensTurn) {
      const kind: Turn['kind'] = trigger === 'human' ? 'human' : 'skill';
      const turn: Turn = {
        index: turns.length,
        kind,
        promptId: group.promptId,
        userText: group.userText,
        echoHashes: [],
        segments: [groupSegment(group, kind)],
        seqStart: group.seqStart,
        seqEnd: group.seqEnd,
        startedAt: '',
        endedAt: '',
        durationMs: null,
        finalText: null,
        finalSeq: null,
        finalMessageId: null,
        finalTrigger: null,
        interimFinals: 0,
        harnessVersion: group.firstUserVersion,
        model: null,
        isDone: false,
        interrupted: false,
        compactions: 0,
        opaqueWriteCommands: 0,
        opaqueTestCommands: 0,
        usage: emptyTotals(),
        costUsd: null,
        apiCalls: 0,
        finalStopReason: null,
      };
      groupTurn.push(turns.length);
      turnGroups.push([gi]);
      turns.push(turn);
      continue;
    }
    const isSegment = (trigger !== null && SEGMENT_TRIGGERS.has(trigger)) || group.hasAssistant;
    if (isSegment) {
      const segTrigger: Trigger = trigger ?? 'meta';
      const seg = groupSegment(group, segTrigger);
      if (segTrigger === 'notification') notificationPrompts++;
      if (turns.length === 0) {
        preamble.push(seg);
        groupTurn.push(-1);
      } else {
        const turnIndex = turns.length - 1;
        turns[turnIndex]?.segments.push(seg);
        turnGroups[turnIndex]?.push(gi);
        groupTurn.push(turnIndex);
      }
      continue;
    }
    localCommandPrompts++;
    groupTurn.push(-1);
  }

  // Per-turn ranges, durations, interrupt segments and compaction counts.
  const maxInterruptByTurn: number[] = turns.map(() => -1);
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const gis = turnGroups[ti];
    if (turn === undefined || gis === undefined) continue;
    let durations: number | null = null;
    let startMs = Infinity;
    let endMs = -Infinity;
    let startIso = '';
    let endIso = '';
    for (const gi of gis) {
      const group = groups[gi];
      if (group === undefined) continue;
      turn.seqStart = Math.min(turn.seqStart, group.seqStart);
      turn.seqEnd = Math.max(turn.seqEnd, group.seqEnd);
      if (group.tsMinMs !== null && group.tsMinMs < startMs) {
        startMs = group.tsMinMs;
        startIso = group.tsMin ?? '';
      }
      if (group.tsMaxMs !== null && group.tsMaxMs > endMs) {
        endMs = group.tsMaxMs;
        endIso = group.tsMax ?? '';
      }
      if (group.durationMs !== null) durations = (durations ?? 0) + group.durationMs;
      for (const seq of group.interruptSeqs) {
        maxInterruptByTurn[ti] = Math.max(maxInterruptByTurn[ti] ?? -1, seq);
        if (group.trigger !== 'interrupt') {
          turn.segments.push({ trigger: 'interrupt', promptId: group.promptId, seqStart: seq, seqEnd: seq });
        }
      }
      if (group.trigger === 'interrupt') maxInterruptByTurn[ti] = Math.max(maxInterruptByTurn[ti] ?? -1, group.seqEnd);
    }
    turn.startedAt = startIso;
    turn.endedAt = endIso;
    turn.durationMs = durations;
    for (const gi of compactionGroupIndexes) {
      if (groupTurn[gi] === ti) turn.compactions++;
    }
  }

  // Finals (§4.2.3 step 6) — never computed in subagent mode.
  const finalsByTurn: (MessageState | null)[] = turns.map(() => null);
  let interimFinalsTotal = 0;
  if (mode === 'main') {
    const byTurn: MessageState[][] = turns.map(() => []);
    for (const msg of messages) {
      const ti = groupTurn[msg.lastGroupIndex];
      if (ti === undefined || ti < 0) continue;
      byTurn[ti]?.push(msg);
    }
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      const msgs = byTurn[ti];
      if (turn === undefined || msgs === undefined) continue;
      msgs.sort((a, b) => a.lastSeq - b.lastSeq);
      const eligible = msgs.filter((m) => isEligibleFinal(m, retracted));
      const final = eligible[eligible.length - 1] ?? null;
      finalsByTurn[ti] = final;
      turn.interimFinals = Math.max(0, eligible.length - 1);
      interimFinalsTotal += turn.interimFinals;
      if (final !== null) {
        const texts = [...final.texts]
          .sort((a, b) => a.seq - b.seq)
          .map((t) => t.text)
          .filter((t) => t !== '');
        turn.finalText = texts.join('\n\n');
        turn.finalSeq = final.lastSeq;
        turn.finalMessageId = final.key;
        turn.finalStopReason = final.stopReason;
        turn.model = final.model;
        if (final.version !== null) turn.harnessVersion = final.version;
        const finalGroup = groups[final.lastGroupIndex];
        if (finalGroup !== undefined && groupTurn[final.lastGroupIndex] === ti) {
          const isBase = turnGroups[ti]?.[0] === final.lastGroupIndex;
          turn.finalTrigger = isBase ? (turn.kind as Trigger) : (finalGroup.trigger ?? 'meta');
        } else {
          turn.finalTrigger = turn.kind as Trigger;
        }
      }
      turn.isDone = turn.finalText !== null;
      // Interrupted (§4.2.3 step 6): last real assistant message stopped at
      // `tool_use`/`null`, or an interrupt segment closes the turn.
      const real = msgs.filter((m) => !m.excluded && !m.sidechain);
      const lastMsg = real[real.length - 1];
      const lastStop = lastMsg?.stopReason ?? null;
      const closedByInterrupt = (maxInterruptByTurn[ti] ?? -1) > (turn.finalSeq ?? lastMsg?.lastSeq ?? -1);
      turn.interrupted = (lastMsg !== undefined && (lastStop === null || lastStop === 'tool_use')) || closedByInterrupt;
    }
  }

  return { turns, preamble, groupTurn, finalsByTurn, localCommandPrompts, notificationPrompts, interimFinalsTotal };
}
