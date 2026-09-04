/**
 * Claude Code session reader (S06): streams the main transcript through
 * `readJsonl` into a `SessionBuilder`, resuming from a stored builder state
 * when the incremental-parse precondition holds (`size ≥ bytesParsed` and
 * the stored `tailHash` matches the on-disk bytes, §4.9), then hands the
 * session to `mergeSubagents` (S06 ships a no-op stub; S07 replaces it —
 * the recursive subagent scan runs on every call).
 *
 * Opens nothing but the transcript file: no `realpath`, no `process.env`,
 * and no `stat` beyond the size check the resume rule needs.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { LineSource, RawLine, Session, SessionRef } from '../../model/types.js';
import { sha256 } from '../../util/hash.js';
import { readJsonl } from '../jsonl.js';
import { SessionBuilder } from './builder.js';
import { mergeSubagents, type SubagentSource } from './subagents.js';

/** A previous read's resume anchor (from {@link ClaudeCodeReadResult}). */
export interface ClaudeCodeStartState {
  /** `SessionBuilder.serialize()` output. */
  state: string;
  /** Absolute offset just past the last complete line of that read. */
  bytesParsed: number;
  /** SHA-256 of the last `min(4096, bytesParsed)` bytes of the parsed region. */
  tailHash: string;
}

/** Options for {@link readClaudeCodeSession}. */
export interface ClaudeCodeReadOptions {
  /** Override the line source (tests, hooks); default: the transcript file at `ref.path`. */
  lines?: LineSource;
  /** Subagent transcripts to merge (S07); inline sidechain chains are merged regardless. */
  subagents?: SubagentSource;
  /** The injected home directory (never read from the environment). */
  home: string;
  /** Resume state; a full parse runs when the precondition fails. */
  startState?: ClaudeCodeStartState;
}

/** What one read produced. */
export interface ClaudeCodeReadResult {
  session: Session;
  bytesParsed: number;
  tailHash: string;
  /** Builder state for the next incremental read. */
  builderState: string;
}

/** UTF-8 bytes of U+2028 LINE SEPARATOR (mirrors the `readJsonl` stream counter). */
const LINE_SEP = Buffer.from([0xe2, 0x80, 0xa8]);
/** UTF-8 bytes of U+2029 PARAGRAPH SEPARATOR. */
const PARA_SEP = Buffer.from([0xe2, 0x80, 0xa9]);

/** Occurrences of raw U+2028/U+2029 in `buf`, exactly as `readJsonl` counts them. */
function countSeparators(buf: Buffer): number {
  let count = 0;
  for (const needle of [LINE_SEP, PARA_SEP]) {
    let at = buf.indexOf(needle);
    while (at !== -1) {
      count++;
      at = buf.indexOf(needle, at + needle.length);
    }
  }
  return count;
}

/** Bytes `[start, start + length)` of the source; short or failed reads return what was read. */
function readRange(src: LineSource, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  if (src.kind === 'text') return Buffer.from(src.text, 'utf8').subarray(start, start + length);
  try {
    const fd = openSync(src.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * SHA-256 of the `min(4096, bytesParsed)` bytes ending at `bytesParsed`, or
 * `null` when the source is shorter than `bytesParsed` or unreadable — the
 * caller then falls back to a full parse.
 */
function tailHashAt(src: LineSource, bytesParsed: number): string | null {
  const length = Math.min(4096, bytesParsed);
  try {
    if (src.kind === 'text') {
      const buf = Buffer.from(src.text, 'utf8');
      if (buf.length < bytesParsed) return null;
      return sha256(buf.subarray(bytesParsed - length, bytesParsed));
    }
    // The one stat the resume rule needs (§4.9): the size check.
    if (statSync(src.path).size < bytesParsed) return null;
    const fd = openSync(src.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, bytesParsed - length);
      return read === length ? sha256(buf) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Parses one Claude Code main transcript into a `Session` (§4.2). Resumes
 * from `opts.startState` when the on-disk tail still matches, else parses
 * from byte 0. After the parse, inline sidechain chains (§4.2.9) and — when
 * provided — the subagent source are handed to `mergeSubagents`.
 */
export async function readClaudeCodeSession(ref: SessionRef, opts: ClaudeCodeReadOptions): Promise<ClaudeCodeReadResult> {
  const src: LineSource = opts.lines ?? { kind: 'file', path: ref.path };
  let builder: SessionBuilder | null = null;
  let startOffset = 0;
  const start = opts.startState;
  if (start !== undefined && start.bytesParsed > 0) {
    const onDisk = tailHashAt(src, start.bytesParsed);
    if (onDisk !== null && onDisk === start.tailHash) {
      try {
        builder = SessionBuilder.resume(start.state, ref, { mode: 'main', home: opts.home });
        startOffset = start.bytesParsed;
      } catch {
        builder = null; // corrupt state → full parse
      }
    }
  }
  if (builder === null) {
    builder = new SessionBuilder(ref, { mode: 'main', home: opts.home });
    startOffset = 0;
  }
  const b = builder;
  const gen = readJsonl(src, {
    startOffset,
    parseCountOnly: (type) => type === 'ai-title' && !b.hasTitle(),
  });
  // One-line delay so the (possibly unterminated) final line can be held
  // back: `builderState` must describe exactly the complete lines up to
  // `bytesParsed` — a line boundary by construction (§4.9) — or a later
  // resume would re-feed the trailing partial line (duplicate uuids,
  // double-counted bad lines).
  let pending: RawLine | null = null;
  let step = await gen.next();
  while (!step.done) {
    if (pending !== null) b.feed(pending);
    pending = step.value;
    step = await gen.next();
  }
  const summary = step.value;
  let builderState: string;
  if (pending !== null && pending.byteOffset >= summary.bytesParsed) {
    // Trailing partial line: serialize the resume anchor first, then feed it
    // so the returned session still reflects the whole file. Its U+2028/29
    // occurrences (counted stream-level by `readJsonl`) are folded in
    // separately, on the same side of the boundary as the line itself.
    const sepPartial = countSeparators(readRange(src, summary.bytesParsed, pending.bytes));
    b.noteSummary({ lineSeparatorChars: summary.lineSeparatorChars - sepPartial });
    builderState = b.serialize();
    b.feed(pending);
    b.noteSummary({ lineSeparatorChars: sepPartial });
  } else {
    if (pending !== null) b.feed(pending);
    b.noteSummary(summary);
    builderState = b.serialize();
  }
  const session = b.finish();
  const inline = b.sidechainSource();
  if (inline !== null) await mergeSubagents(session, inline);
  if (opts.subagents !== undefined) await mergeSubagents(session, opts.subagents);
  return { session, bytesParsed: summary.bytesParsed, tailHash: summary.tailHash, builderState };
}

/**
 * The resume anchor a cache entry stores for the Stop path (§4.9, S27b). A
 * `cache/cache.ts CacheEntry` is structurally assignable to this shape.
 */
export interface ResumeAnchor {
  /** Absolute offset just past the last complete line of the previous parse (always a line boundary). */
  bytesParsed: number;
  /** `sha256` of the `min(4096, bytesParsed)` bytes preceding `bytesParsed`. */
  tailHash: string;
  /** `SessionBuilder.serialize()` output; absent (an entry from a non-resumable parse) → cold parse. */
  builderState?: string;
}

/**
 * Incremental Stop-path parse (S27b): continues the turn builder, uuid index
 * and usage-dedupe state from `entry` when the stored `tailHash` still
 * matches the on-disk bytes at `entry.bytesParsed`; any mismatch (rewrite,
 * truncation, rotation) or a corrupt/absent `builderState` falls back to a
 * cold parse. Subagent files (`opts.subagents`) are always rescanned either
 * way. The appended tail is streamed from the source itself, so the caller
 * only supplies the anchor from `lookupByPath` — and must `realpath` a hook's
 * `transcript_path` to the discovery spelling *before* that lookup, or the
 * resume path will always miss (W1 merge note).
 */
export async function resumeSession(ref: SessionRef, entry: ResumeAnchor, opts: ClaudeCodeReadOptions): Promise<ClaudeCodeReadResult> {
  const { builderState } = entry;
  if (builderState === undefined) return readClaudeCodeSession(ref, opts);
  return readClaudeCodeSession(ref, {
    ...opts,
    startState: { state: builderState, bytesParsed: entry.bytesParsed, tailHash: entry.tailHash },
  });
}
