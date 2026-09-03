/**
 * Evidence construction and formatting (S17, §4.8, §5.2).
 *
 * The reconcile rows attach `EvidenceRef`s to every judgement; a ref's `label`
 * never contains a formatted time (§4.8 cross-cutting rule vii — `at` is the
 * ISO-8601 UTC instant and renderers format it). `evidenceStrings` is the
 * renderer-facing side: it merges consecutive refs that share a label, appends
 * the `(HH:MM)` clock(s) derived from `at`, adds the `agent:<id>` /
 * `workflow:<runId>` suffix (rule iii) and finally appends the judgement's
 * notes to the last string — so every rendered evidence string carries a time
 * (`Edit ×3 (17:31, 17:32)`, `uv run pytest → exit 0 · 41 passed (23:41)`,
 * `ruff → exit 1 (23:44) · 2 errors, never re-run`). Absence facts point at
 * the final message and therefore carry its time (`no git commit in log
 * (23:58)`).
 */
import type { EvidenceRef, Judgement, SubagentInfo, ToolCall, Turn, WriteFact } from '../model/types.js';
import { sanitizeForCell } from '../util/sanitize.js';
import { formatClock, parseIso, type Tz } from '../util/time.js';

/** Longest label kept before an ellipsis (labels sit in an 80-column receipt). */
const LABEL_MAX = 80;

/** Sanitises a transcript-derived fragment for use inside an evidence label. */
export function evidenceLabel(text: string): string {
  const clean = sanitizeForCell(text);
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 1)}…` : clean;
}

/** Extra fields of a ref under `exactOptionalPropertyTypes`. */
export interface RefExtras {
  toolCallId?: string;
  agentId?: string | null;
}

/** Builds one `EvidenceRef`; `at` is ISO-8601 UTC (§3). */
export function makeRef(seq: number, at: string, label: string, extras: RefExtras = {}): EvidenceRef {
  const ref: EvidenceRef = { seq, label, at };
  if (extras.toolCallId !== undefined) ref.toolCallId = extras.toolCallId;
  if (extras.agentId !== undefined) ref.agentId = extras.agentId;
  return ref;
}

/** A ref pointing at one tool call (time = the call's start). */
export function callRef(call: ToolCall, label: string): EvidenceRef {
  return makeRef(call.seq, call.startedAt, label, { toolCallId: call.id, agentId: call.agentId });
}

/**
 * A ref for an absence fact ("no git commit in log"): it points at the turn's
 * final message (`finalSeq`, falling back to the turn end) and carries the
 * final message's time (§4.8 — absence facts use the time of the final).
 */
export function absenceRef(turn: Turn, label: string): EvidenceRef {
  return makeRef(turn.finalSeq ?? turn.seqEnd, turn.endedAt, label);
}

/**
 * Refs for a group of verifying writes, grouped by tool: `Edit ×3` emits two
 * refs sharing the label (first and last write) so `evidenceStrings` renders
 * `Edit ×3 (17:31, 17:32)`; a single write emits `Write` once. `fallbackAt`
 * covers a write whose tool call is unknown (never the case for tool/patch
 * writes; defensive for inferred ones).
 */
export function writeRefs(
  writes: readonly WriteFact[],
  callById: ReadonlyMap<string, ToolCall>,
  fallbackAt: string
): EvidenceRef[] {
  const groups = new Map<string, WriteFact[]>();
  for (const w of writes) {
    const tool = callById.get(w.toolCallId)?.tool ?? 'write';
    const list = groups.get(tool);
    if (list === undefined) groups.set(tool, [w]);
    else list.push(w);
  }
  const out: EvidenceRef[] = [];
  for (const [tool, group] of groups) {
    const label = group.length > 1 ? `${evidenceLabel(tool)} ×${group.length}` : evidenceLabel(tool);
    const first = group[0] as WriteFact;
    const last = group[group.length - 1] as WriteFact;
    for (const w of group.length > 1 ? [first, last] : [first]) {
      const call = callById.get(w.toolCallId);
      out.push(makeRef(w.seq, call?.startedAt ?? fallbackAt, label, { toolCallId: w.toolCallId, agentId: w.agentId }));
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Formatting options for `evidenceStrings`. */
export interface EvidenceFormat {
  /** Clock timezone; tests and JSON use `'utc'` (the default). */
  tz?: Tz;
  /** Reference day for day-crossing clocks (defaults to each ref's own day, so times render as bare `HH:MM`). */
  refDayMs?: number;
  /** Session subagents, for the `workflow:<runId>` form of the agent suffix. */
  subagents?: readonly SubagentInfo[];
}

/** `agent:<id>` / `workflow:<runId>` suffix for a subagent-attributed ref (§4.8 iii). */
export function agentSuffix(agentId: string | null | undefined, subagents: readonly SubagentInfo[] = []): string {
  if (agentId === null || agentId === undefined) return '';
  const info = subagents.find((s) => s.agentId === agentId);
  const runId = info?.spawnedBy.runId;
  if (info?.spawnedBy.tool === 'Workflow' && runId !== undefined) return ` workflow:${evidenceLabel(runId)}`;
  const short = agentId.length > 7 ? agentId.slice(0, 7) : agentId;
  return ` agent:${evidenceLabel(short)}`;
}

/** `HH:MM` (or `Mon D HH:MM` across days) of one ISO instant. */
function clockOf(at: string, tz: Tz, refDayMs: number | undefined): string {
  const ms = parseIso(at);
  if (ms === null) return '??:??';
  return formatClock(ms, tz, refDayMs ?? ms);
}

/**
 * The renderer-facing evidence strings of one judgement: consecutive refs
 * sharing a label (and agent) merge into `label (t1, t2)` with duplicate
 * clock readings collapsed; the judgement's notes append to the last string
 * as ` · note`. Judgements without evidence yield `[]` (their notes belong
 * to ALSO-SAID style lines, not evidence).
 */
export function evidenceStrings(judgement: Judgement, fmt: EvidenceFormat = {}): string[] {
  const tz = fmt.tz ?? 'utc';
  const groups: { label: string; suffix: string; times: string[] }[] = [];
  for (const ref of judgement.evidence) {
    const suffix = agentSuffix(ref.agentId, fmt.subagents);
    const time = clockOf(ref.at, tz, fmt.refDayMs);
    const prev = groups[groups.length - 1];
    if (prev !== undefined && prev.label === ref.label && prev.suffix === suffix) {
      if (prev.times[prev.times.length - 1] !== time) prev.times.push(time);
    } else {
      groups.push({ label: ref.label, suffix, times: [time] });
    }
  }
  const out = groups.map((g) => `${g.label}${g.suffix} (${g.times.join(', ')})`);
  if (out.length > 0 && judgement.notes.length > 0) {
    const last = out.length - 1;
    out[last] = `${out[last] as string}${judgement.notes.map((n) => ` · ${n}`).join('')}`;
  }
  return out;
}
