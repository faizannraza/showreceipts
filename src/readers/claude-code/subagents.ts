/**
 * Subagent merge (ARCHITECTURE §4.2.6, §4.2.7). Enumerates
 * `subagents/**\/agent-*.jsonl` (recursive, depth ≤ 4, symlinks never
 * followed), parses each file with a `SessionBuilder` in `subagent` mode
 * (finals never computed; `stop_reason: null` partials expected; the
 * last-completed-line usage rule), links every file to its spawning
 * `Agent`/`Workflow` call, attributes every line to the parent turn whose
 * `promptId` it carries, and inserts the events into the main sequence by
 * the running-maximum timestamp envelope (`model/timeline.ts`), renumbering
 * `seq` over the merged sequence.
 *
 * Linkage order (§4.2.6): `meta.toolUseId` → an `Agent` result's `agentId`
 * from the main file or any subagent file → the `Workflow` run whose
 * transcript directory contains the file → unlinked. `subagentFiles =
 * {direct, workflow, unlinked, missing}`; `missing` counts `Agent`/`Workflow`
 * results whose transcript files are absent or unreadable (S14 turns it into
 * `Ledger.incomplete`). `journal.jsonl` is counted, never parsed; anything
 * unrecognised is counted in `unrecognisedFiles`.
 *
 * A fork record (`fork-context-ref`) sets `isFork`, and usage rows whose
 * `message.id` already exists in the parent are `inherited: true` and never
 * billed — a subagent line never replaces a main-file group (§4.2.7).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markPostFinal, mergeTimeline, type SubagentTimeline } from '../../model/timeline.js';
import type { Diagnostics, LineSource, Session, SubagentInfo, ToolCall } from '../../model/types.js';
import { calendarDaysBetween, parseIso } from '../../util/time.js';
import { readJsonl } from '../jsonl.js';
import { SessionBuilder } from './builder.js';
import { asNumber, asRecord, asString, isRawUsage } from './records.js';
import { addRowToTotals, thinkingOf } from './usage.js';

/** Where subagent transcripts come from: a directory scan, or in-memory chains (§4.2.9 inline sidechains). */
export type SubagentSource = { kind: 'dir'; path: string } | { kind: 'memory'; files: Map<string, LineSource> };

/** Only these transcript names are read from disk (§4.2.6). */
const AGENT_FILE_RE = /^agent-[0-9a-f]+\.jsonl$/;
const AGENT_META_RE = /^agent-[0-9a-f]+\.meta\.json$/;
/** In-memory names come from our own collector (sidechain roots may be uuids). */
const MEMORY_FILE_RE = /^agent-.+\.jsonl$/;
const MEMORY_META_RE = /^agent-.+\.meta\.json$/;
/** Directory levels scanned below (and including) the scan root. */
const MAX_DEPTH = 4;

/** The tolerated `agent-<id>.meta.json` sidecar fields (§4.2.6). */
interface Meta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  model: string | null;
  parentAgentId: string | null;
  isFork: boolean;
}

interface EnumeratedFile {
  /** Basename (`agent-<id>.jsonl`). */
  name: string;
  source: LineSource;
  /** The `wf_*` directory segment the file sits under, when any. */
  wfDir: string | null;
  /** Absolute path of the sidecar meta file (dir sources). */
  metaPath: string | null;
}

/** The name of a transcript's sidecar meta file. */
function metaNameOf(name: string): string {
  return name.replace(/\.jsonl$/, '.meta.json');
}

/** The `wf_*` segment of a relative path under a `workflows/` directory, if any. */
function wfDirOf(parts: readonly string[]): string | null {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part !== undefined && part.startsWith('wf_') && parts[i - 1] === 'workflows') return part;
  }
  return null;
}

/**
 * Recursive directory scan: depth ≤ {@link MAX_DEPTH}, symlinks never
 * followed (directory entries are checked with lstat semantics, so a symlink
 * loop terminates trivially), only `agent-*.jsonl` names are read. Journals
 * are counted; sibling session transcripts at the scan root (the older
 * `<projectDir>/agent-*.jsonl` layout) are ignored; everything else counts
 * as unrecognised.
 */
function scanDir(root: string, counts: { journals: number; unrecognised: number }): EnumeratedFile[] {
  const out: EnumeratedFile[] = [];
  const walk = (dir: string, parts: string[], depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dir, name), [...parts, name], depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks (files or directories) are never followed.
        counts.unrecognised++;
        continue;
      }
      if (AGENT_FILE_RE.test(name)) {
        out.push({
          name,
          source: { kind: 'file', path: join(dir, name) },
          wfDir: wfDirOf(parts),
          metaPath: join(dir, metaNameOf(name)),
        });
        continue;
      }
      if (AGENT_META_RE.test(name)) continue; // read beside its transcript
      if (name === 'journal.jsonl') {
        counts.journals++;
        continue;
      }
      if (parts.length === 0 && name.endsWith('.jsonl')) continue; // sibling session transcripts (older layout)
      counts.unrecognised++;
    }
  };
  walk(root, [], 1);
  return out;
}

/** In-memory enumeration; meta sidecars are collected by name. */
function scanMemory(
  files: ReadonlyMap<string, LineSource>,
  counts: { journals: number; unrecognised: number },
  metas: Map<string, string>,
): EnumeratedFile[] {
  const out: EnumeratedFile[] = [];
  const names = [...files.keys()].sort();
  for (const name of names) {
    const src = files.get(name);
    if (src === undefined) continue;
    if (MEMORY_META_RE.test(name)) {
      const text = sourceText(src);
      if (text !== null) metas.set(name, text);
      continue;
    }
    if (MEMORY_FILE_RE.test(name)) {
      out.push({ name, source: src, wfDir: null, metaPath: null });
      continue;
    }
    if (name === 'journal.jsonl') {
      counts.journals++;
      continue;
    }
    counts.unrecognised++;
  }
  return out;
}

/** The text of a `LineSource` (reads the file for `kind: 'file'`); `null` when unreadable. */
function sourceText(src: LineSource): string | null {
  if (src.kind === 'text') return src.text;
  try {
    return readFileSync(src.path, 'utf8');
  } catch {
    return null;
  }
}

/** Parses a sidecar meta JSON tolerantly; malformed text yields `null`. */
function parseMeta(text: string | undefined | null): Meta | null {
  if (text === undefined || text === null) return null;
  try {
    const rec = asRecord(JSON.parse(text));
    if (rec === null) return null;
    return {
      agentType: asString(rec['agentType']),
      description: asString(rec['description']),
      toolUseId: asString(rec['toolUseId']),
      spawnDepth: asNumber(rec['spawnDepth']),
      model: asString(rec['model']),
      parentAgentId: asString(rec['parentAgentId']),
      isFork: rec['isFork'] === true,
    };
  } catch {
    return null;
  }
}

/** One parsed subagent transcript plus the per-line facts the merge needs. */
interface ParsedFile {
  /** Agent id from the filename (fallback: the first line's `agentId`). */
  id: string;
  wfDir: string | null;
  meta: Meta | null;
  session: Session;
  /** Line seq → the parent promptId it carries (inherited from the previous line). */
  promptBySeq: (string | null | undefined)[];
  /** Line seq → epoch ms (inherited from the previous line). */
  tsBySeq: (number | null | undefined)[];
  /** Assistant line seq → its usage's thinking tokens. */
  thinkingBySeq: Map<number, number>;
  /** A `fork-context-ref` line was seen. */
  fork: boolean;
  /** The last non-null assistant `stop_reason` (terminal `end_turn` ⇒ finished). */
  lastStop: string | null;
  /** How the file linked (filled during linkage). */
  link: { category: 'direct' | 'workflow' | 'unlinked'; runId: string | null; spawnToolUseId: string | null };
}

/** Streams one subagent file through a subagent-mode builder; `null` when unreadable. */
async function parseSubagentFile(file: EnumeratedFile, sessionId: string): Promise<ParsedFile | null> {
  const builder = new SessionBuilder(
    { harness: 'claude-code', sessionId, path: '', size: 0, mtimeMs: 0, subagentManifest: [] },
    { mode: 'subagent', home: '' },
  );
  const promptBySeq: (string | null)[] = [];
  const tsBySeq: (number | null)[] = [];
  const thinkingBySeq = new Map<number, number>();
  let curPrompt: string | null = null;
  let curTs: number | null = null;
  let fork = false;
  let lastStop: string | null = null;
  let lineAgentId: string | null = null;
  try {
    const gen = readJsonl(file.source, {});
    let step = await gen.next();
    while (!step.done) {
      const line = step.value;
      const rec = line.json === undefined ? null : asRecord(line.json);
      if (rec !== null) {
        const pid = asString(rec['promptId']);
        if (pid !== null) curPrompt = pid;
        const ts = asString(rec['timestamp']);
        if (ts !== null) {
          const ms = parseIso(ts);
          if (ms !== null) curTs = ms;
        }
        if (lineAgentId === null) lineAgentId = asString(rec['agentId']);
        if (rec['type'] === 'fork-context-ref') fork = true;
        if (rec['type'] === 'assistant') {
          const message = asRecord(rec['message']);
          const stop = message === null ? null : asString(message['stop_reason']);
          if (stop !== null) lastStop = stop;
          const synthetic = (message !== null && asString(message['model']) === '<synthetic>') || rec['isApiErrorMessage'] === true;
          const usage = message?.['usage'];
          if (!synthetic && isRawUsage(usage)) thinkingBySeq.set(line.seq, thinkingOf(usage));
        }
      }
      promptBySeq[line.seq] = curPrompt;
      tsBySeq[line.seq] = curTs;
      builder.feed(line);
      step = await gen.next();
    }
    builder.noteSummary(step.value);
  } catch {
    return null; // absent or unreadable → the caller counts it via `missing`
  }
  const idMatch = /^agent-(.+)\.jsonl$/.exec(file.name);
  return {
    id: idMatch?.[1] ?? lineAgentId ?? file.name,
    wfDir: file.wfDir,
    meta: null,
    session: builder.finish(),
    promptBySeq,
    tsBySeq,
    thinkingBySeq,
    fork,
    lastStop,
    link: { category: 'unlinked', runId: null, spawnToolUseId: null },
  };
}

/** Adds `src`'s counts into `dst` key-wise. */
function mergeCounts(dst: Record<string, number>, src: Readonly<Record<string, number>>): void {
  for (const [key, value] of Object.entries(src)) dst[key] = (dst[key] ?? 0) + value;
}

/** Folds one subagent file's parse-health diagnostics into the session's. */
function mergeDiagnostics(dst: Diagnostics, src: Diagnostics, agentId: string): void {
  dst.badLines += src.badLines;
  dst.lineSeparatorChars += src.lineSeparatorChars;
  dst.reorderedEvents += src.reorderedEvents;
  dst.duplicateUuids += src.duplicateUuids;
  dst.duplicateToolResults += src.duplicateToolResults;
  dst.bashWithoutToolUseResult += src.bashWithoutToolUseResult;
  dst.incompleteMessages += src.incompleteMessages;
  dst.orphanAssistantLines += src.orphanAssistantLines;
  dst.excludedSyntheticLines += src.excludedSyntheticLines;
  dst.records += src.records;
  mergeCounts(dst.unknownRecordTypes, src.unknownRecordTypes);
  mergeCounts(dst.unknownSubtypes, src.unknownSubtypes);
  mergeCounts(dst.unknownToolShapes, src.unknownToolShapes);
  mergeCounts(dst.unknownContentBlocks, src.unknownContentBlocks);
  mergeCounts(dst.unknownAttachmentTypes, src.unknownAttachmentTypes);
  mergeCounts(dst.legacyShapes, src.legacyShapes);
  for (const note of src.notes) dst.notes.push(`agent ${agentId}: ${note}`);
}

/** True when a workflow run id matches a `wf_*` directory name (either spelling). */
function runIdMatchesDir(runId: string, wfDir: string): boolean {
  return runId === wfDir || `wf_${runId}` === wfDir;
}

/**
 * Merges subagent transcripts into `session` (§4.2.6): parse, link,
 * attribute, place by the running-maximum timestamp envelope, renumber
 * `seq`, fold usage (inherited fork rows excluded) and diagnostics. Called
 * by `reader.ts` for the inline sidechain source (§4.2.9) and for the
 * discovered `subagents/` directory; safe to call more than once (counts
 * accumulate; `missing` is recomputed on every `dir` merge).
 */
export async function mergeSubagents(session: Session, source: SubagentSource): Promise<void> {
  const diag = session.diagnostics;
  const scanCounts = { journals: 0, unrecognised: 0 };
  const memMetas = new Map<string, string>();
  const enumerated = source.kind === 'dir' ? scanDir(source.path, scanCounts) : scanMemory(source.files, scanCounts, memMetas);
  diag.journals += scanCounts.journals;
  diag.unrecognisedFiles += scanCounts.unrecognised;

  // ---- Parse every file (unreadable files fall through to `missing`). ----
  const parsed: ParsedFile[] = [];
  for (const file of enumerated) {
    const p = await parseSubagentFile(file, session.sessionId);
    if (p === null) {
      // Enumerated but unreadable (open/read error): leave a trace instead
      // of letting the file vanish silently (S07 review); its run may also
      // be counted in `subagentFiles.missing`.
      diag.notes.push(`subagent file ${file.name} unreadable`);
      continue;
    }
    p.meta = source.kind === 'dir' ? parseMeta(file.metaPath === null ? null : sourceText({ kind: 'file', path: file.metaPath })) : parseMeta(memMetas.get(metaNameOf(file.name)));
    parsed.push(p);
  }

  // ---- Spawn seeds: session infos (S06) plus nested Agent/Workflow calls found inside subagent files. ----
  const infoById = new Map<string, SubagentInfo>();
  for (const info of session.subagents) infoById.set(info.agentId, info);
  /** Spawned agentId → the agentId of the subagent file whose call spawned it. */
  const ownerByAgentId = new Map<string, string>();
  for (const p of parsed) {
    for (const seed of p.session.subagents) {
      if (!infoById.has(seed.agentId)) {
        session.subagents.push(seed);
        infoById.set(seed.agentId, seed);
      }
      if (seed.spawnedBy.tool === 'Agent' && !ownerByAgentId.has(seed.agentId)) ownerByAgentId.set(seed.agentId, p.id);
    }
  }
  const infoByToolUseId = new Map<string, SubagentInfo>();
  for (const info of session.subagents) {
    const tuid = info.spawnedBy.toolUseId;
    if (tuid !== undefined && !infoByToolUseId.has(tuid)) infoByToolUseId.set(tuid, info);
  }
  const workflowInfos = session.subagents.filter((i) => i.spawnedBy.tool === 'Workflow' && i.spawnedBy.runId !== undefined);

  // ---- Linkage per §4.2.6, in order. ----
  for (const p of parsed) {
    const metaTuid = p.meta?.toolUseId ?? null;
    const via = metaTuid === null ? undefined : infoByToolUseId.get(metaTuid);
    const own = infoById.get(p.id);
    if (via !== undefined && via.spawnedBy.tool === 'Agent') {
      p.link = { category: 'direct', runId: null, spawnToolUseId: metaTuid };
    } else if (via !== undefined && via.spawnedBy.tool === 'Workflow') {
      p.link = { category: 'workflow', runId: via.spawnedBy.runId ?? null, spawnToolUseId: metaTuid };
    } else if (own !== undefined && own.spawnedBy.tool === 'Agent') {
      p.link = { category: 'direct', runId: null, spawnToolUseId: own.spawnedBy.toolUseId ?? null };
    } else if (p.wfDir !== null) {
      const wfDir = p.wfDir;
      const run = workflowInfos.find((i) => i.spawnedBy.runId !== undefined && runIdMatchesDir(i.spawnedBy.runId, wfDir));
      p.link = { category: 'workflow', runId: run?.spawnedBy.runId ?? p.wfDir, spawnToolUseId: run?.spawnedBy.toolUseId ?? null };
    } else if (p.meta?.agentType === 'workflow-subagent') {
      p.link = { category: 'workflow', runId: null, spawnToolUseId: null };
    } else {
      p.link = { category: 'unlinked', runId: null, spawnToolUseId: null };
    }

    // File info: create or complete the `SubagentInfo` keyed by the file's agent id.
    let info = infoById.get(p.id);
    if (info === undefined) {
      info = { agentId: p.id, parentAgentId: null, spawnedBy: { tool: 'unknown' }, toolCalls: 0, startedAt: '', endedAt: '', finished: false };
      session.subagents.push(info);
      infoById.set(p.id, info);
    }
    if (p.link.category === 'workflow' && info.spawnedBy.tool !== 'Workflow') {
      info.spawnedBy = p.link.runId === null ? { tool: 'Workflow' } : { tool: 'Workflow', runId: p.link.runId };
    } else if (p.link.category === 'unlinked' && info.spawnedBy.tool === 'unknown' && source.kind === 'memory') {
      info.spawnedBy = { tool: 'inline' }; // §4.2.9 inline sidechain chains
    }
    const meta = p.meta;
    if (meta !== null) {
      if (meta.agentType !== null) info.agentType = meta.agentType;
      if (meta.description !== null && info.description === undefined) info.description = meta.description;
      if (meta.spawnDepth !== null) info.spawnDepth = meta.spawnDepth;
      if (meta.model !== null && info.model === undefined) info.model = meta.model;
      if (meta.parentAgentId !== null) info.parentAgentId = meta.parentAgentId;
      if (meta.isFork) info.isFork = true;
    }
    if (p.fork) info.isFork = true;
    if (info.parentAgentId === null) info.parentAgentId = ownerByAgentId.get(p.id) ?? null;
    info.toolCalls = p.session.toolCalls.length;
    if (p.session.startedAt !== '') info.startedAt = p.session.startedAt;
    if (p.session.endedAt !== '') info.endedAt = p.session.endedAt;
    if (p.lastStop === 'end_turn') info.finished = true;

    if (p.link.category === 'direct') diag.subagentFiles.direct++;
    else if (p.link.category === 'workflow') diag.subagentFiles.workflow++;
    else if (source.kind === 'dir') diag.subagentFiles.unlinked++;
  }

  // ---- Turn attribution maps (§4.2.6): promptId → turn; continuation segments map to their enclosing turn. ----
  const turnByPrompt = new Map<string, number>();
  for (const turn of session.turns) {
    if (!turnByPrompt.has(turn.promptId)) turnByPrompt.set(turn.promptId, turn.index);
    for (const seg of turn.segments) {
      if (seg.promptId !== null && !turnByPrompt.has(seg.promptId)) turnByPrompt.set(seg.promptId, turn.index);
    }
  }
  for (const seg of session.preamble) {
    if (seg.promptId !== null && !turnByPrompt.has(seg.promptId)) turnByPrompt.set(seg.promptId, -1);
  }
  const mainCallById = new Map<string, ToolCall>();
  for (const call of session.toolCalls) mainCallById.set(call.id, call);
  const subCallLoc = new Map<string, { p: ParsedFile; seq: number }>();
  for (const p of parsed) {
    for (const call of p.session.toolCalls) if (!subCallLoc.has(call.id)) subCallLoc.set(call.id, { p, seq: call.seq });
  }
  /** The turn containing the spawning call (walks nested spawns; cycle-guarded). */
  const spawnTurnOf = (toolUseId: string | null, seen: Set<string>): number => {
    if (toolUseId === null) return -1;
    const mainCall = mainCallById.get(toolUseId);
    if (mainCall !== undefined) return mainCall.turnIndex;
    const loc = subCallLoc.get(toolUseId);
    if (loc === undefined || seen.has(loc.p.id)) return -1;
    seen.add(loc.p.id);
    const pid = loc.p.promptBySeq[loc.seq] ?? null;
    if (pid !== null) {
      const ti = turnByPrompt.get(pid);
      if (ti !== undefined) return ti;
    }
    return spawnTurnOf(loc.p.link.spawnToolUseId, seen);
  };

  // ---- Placement: one timeline event per entity-bearing line, at its (inherited) timestamp. ----
  const timelines: SubagentTimeline[] = [];
  for (const p of parsed) {
    const eventSeqs = new Set<number>();
    for (const call of p.session.toolCalls) eventSeqs.add(call.seq);
    for (const row of p.session.usageRows) eventSeqs.add(row.seq);
    for (const c of p.session.compactions) eventSeqs.add(c.seq);
    for (const r of p.session.prRefs) eventSeqs.add(r.seq);
    for (const e of p.session.editedFiles) eventSeqs.add(e.seq);
    for (const r of p.session.refusalFallbacks) eventSeqs.add(r.seq);
    const fallbackTs = parseIso(p.session.startedAt) ?? 0;
    timelines.push({
      agentId: p.id,
      events: [...eventSeqs].sort((a, b) => a - b).map((seq) => ({ seq, tsMs: p.tsBySeq[seq] ?? fallbackTs })),
    });
  }
  const { subSeqMaps } = mergeTimeline(session, timelines);

  // ---- Fold entities in, remapped and attributed. ----
  // §4.2.7's inherited rule matches against the *main file's* message ids
  // only: rows merged by an earlier call (inline sidechains, a prior dir
  // merge) carry an agentId and must never make a later file's rows
  // "inherited" (S07 review).
  const mainMessageIds = new Set(session.usageRows.filter((r) => r.agentId === null).map((r) => r.messageId));
  let minMs = parseIso(session.startedAt);
  let maxMs = parseIso(session.endedAt);
  let minIso = session.startedAt;
  let maxIso = session.endedAt;
  parsed.forEach((p, i) => {
    const map = subSeqMaps[i] ?? new Map<number, number>();
    let unknownNoted = false;
    const turnOf = (oldSeq: number): number => {
      const pid = p.promptBySeq[oldSeq] ?? null;
      if (pid !== null) {
        const ti = turnByPrompt.get(pid);
        if (ti !== undefined) return ti;
      }
      const ti = spawnTurnOf(p.link.spawnToolUseId, new Set([p.id]));
      if (ti < 0 && !unknownNoted) {
        unknownNoted = true;
        diag.notes.push(`agent ${p.id}: events with an unknown promptId attributed to the session (agentUnlinked)`);
      }
      return ti;
    };
    for (const call of p.session.toolCalls) {
      call.agentId ??= p.id;
      call.turnIndex = turnOf(call.seq);
      call.seq = map.get(call.seq) ?? call.seq;
      session.toolCalls.push(call);
    }
    for (const row of p.session.usageRows) {
      row.agentId ??= p.id;
      const thinking = p.thinkingBySeq.get(row.seq) ?? 0;
      const turnIndex = turnOf(row.seq);
      const inherited = mainMessageIds.has(row.messageId);
      if (inherited) row.inherited = true; // §4.2.7: a fork's copy of a parent message is never billed
      row.seq = map.get(row.seq) ?? row.seq;
      session.usageRows.push(row);
      if (!inherited) {
        addRowToTotals(session.usage, row, thinking);
        const turn = session.turns[turnIndex];
        if (turn !== undefined) {
          addRowToTotals(turn.usage, row, thinking);
          turn.apiCalls++;
        }
      }
    }
    for (const c of p.session.compactions) {
      c.seq = map.get(c.seq) ?? c.seq;
      session.compactions.push(c);
    }
    for (const r of p.session.prRefs) {
      r.seq = map.get(r.seq) ?? r.seq;
      session.prRefs.push(r);
    }
    for (const e of p.session.editedFiles) {
      e.seq = map.get(e.seq) ?? e.seq;
      session.editedFiles.push(e);
    }
    for (const r of p.session.refusalFallbacks) {
      r.seq = map.get(r.seq) ?? r.seq;
      session.refusalFallbacks.push(r);
    }
    for (const e of p.session.apiErrors) session.apiErrors.push(e);
    for (const m of p.session.models) if (!session.models.includes(m)) session.models.push(m);
    for (const c of p.session.cwds) if (!session.cwds.includes(c)) session.cwds.push(c);
    for (const v of p.session.harnessVersions) if (!session.harnessVersions.includes(v)) session.harnessVersions.push(v);
    mergeDiagnostics(diag, p.session.diagnostics, p.id);
    session.records += p.session.records;
    const subStart = parseIso(p.session.startedAt);
    if (subStart !== null && (minMs === null || subStart < minMs)) {
      minMs = subStart;
      minIso = p.session.startedAt;
    }
    const subEnd = parseIso(p.session.endedAt);
    if (subEnd !== null && (maxMs === null || subEnd > maxMs)) {
      maxMs = subEnd;
      maxIso = p.session.endedAt;
    }
  });

  session.toolCalls.sort((a, b) => a.seq - b.seq);
  session.usageRows.sort((a, b) => a.seq - b.seq);
  session.compactions.sort((a, b) => a.seq - b.seq);
  session.prRefs.sort((a, b) => a.seq - b.seq);
  session.editedFiles.sort((a, b) => a.seq - b.seq);
  session.refusalFallbacks.sort((a, b) => a.seq - b.seq);

  // ---- Session time range and neutral cost buckets follow the merged usage. ----
  if (minMs !== null && maxMs !== null) {
    session.startedAt = minIso;
    session.endedAt = maxIso;
    session.durationMs = maxMs - minMs;
    session.spansDays = calendarDaysBetween(minMs, maxMs, 'utc') + 1;
  }
  session.cost.apiCalls = session.usage.calls;
  session.cost.input = session.usage.input;
  session.cost.cacheRead = session.usage.cacheRead;
  session.cost.cacheWrite5m = session.usage.cacheWrite5m;
  session.cost.cacheWrite1h = session.usage.cacheWrite1h;
  session.cost.cacheWriteOther = session.usage.cacheWriteOther;
  session.cost.output = session.usage.output;
  session.cost.thinking = session.usage.thinking;

  // ---- `missing`: Agent/Workflow results whose transcript files are absent or unreadable. ----
  if (source.kind === 'dir') {
    const fileBacked = new Set(parsed.map((p) => p.id));
    const linkedRunIds = new Set<string>();
    for (const p of parsed) {
      if (p.link.category === 'workflow' && p.link.runId !== null) linkedRunIds.add(p.link.runId);
    }
    let missing = 0;
    for (const info of session.subagents) {
      if (info.spawnedBy.tool === 'Agent') {
        if (!fileBacked.has(info.agentId)) missing++;
      } else if (info.spawnedBy.tool === 'Workflow' && info.spawnedBy.runId !== undefined && info.agentId.startsWith('wf_')) {
        if (!linkedRunIds.has(info.spawnedBy.runId)) missing++;
      }
    }
    diag.subagentFiles.missing = missing;
  }

  markPostFinal(session);
}
