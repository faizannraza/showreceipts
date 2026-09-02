/**
 * Streaming byte-level JSONL reader (ARCHITECTURE §4.2.1).
 *
 * Lines are split on byte `0x0A` only — never on decoded strings — because
 * Claude Code writes U+2028/U+2029/NEL unescaped inside JSON strings and any
 * text-mode splitter (`node:readline`, `String.prototype.split` on
 * line-separator classes) breaks records mid-string. One trailing `0x0D` is
 * stripped per line (CRLF tolerance); the remainder of each chunk is carried
 * into the next, so memory holds at most one chunk plus the current carry.
 *
 * A cheap type sniff over the first {@link SNIFF_WINDOW} bytes lets bulky
 * bookkeeping records (the §4.2.1 count-only list) skip `JSON.parse`
 * entirely; `attachment` lines are still parsed when their raw bytes carry
 * the `edited_text_file` (human-edited-between-turns, §4.2.8) or
 * `hook_system_message` marker, and a caller-supplied `parseCountOnly`
 * closure can force any count-only type to parse (Claude Code parses
 * `ai-title` until a title is known).
 *
 * Byte offsets support incremental tail parsing (§4.9): `byteOffset` is the
 * absolute offset of each line's first byte, `bytesParsed` the absolute
 * offset just past the last *complete* (newline-terminated) line, and
 * `tailHash` the SHA-256 of the last `min(4096, bytesParsed)` bytes of the
 * parsed region — a trailing partial line is never included, so a resume
 * from `bytesParsed` neither re-reads nor skips a record.
 */
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { LineSource, RawLine } from '../model/types.js';
import { sha256 } from '../util/hash.js';

const NL = 0x0a;
const CR = 0x0d;
/** How many leading bytes of a line the type sniff inspects. */
const SNIFF_WINDOW = 256;
/** How many trailing bytes of the parsed region `tailHash` covers (§4.9). */
const TAIL_WINDOW = 4096;
/** Read-stream chunk size (§4.2.1: `highWaterMark: 1 << 20`). */
const CHUNK_SIZE = 1 << 20;
/** Default cap above which a line is reported bad without being decoded. */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);
/** UTF-8 bytes of U+2028 LINE SEPARATOR. */
const LINE_SEP = Buffer.from([0xe2, 0x80, 0xa8]);
/** UTF-8 bytes of U+2029 PARAGRAPH SEPARATOR. */
const PARA_SEP = Buffer.from([0xe2, 0x80, 0xa9]);
/** Raw-byte markers that make an `attachment` line worth parsing (§4.2.1/§4.2.8). */
const ATTACHMENT_PARSE_MARKERS: readonly Buffer[] = [
  Buffer.from('"type":"edited_text_file"'),
  Buffer.from('"type":"hook_system_message"'),
];
const SNIFF_RE = /"type":"([a-z_-]+)"/;

/**
 * Record types that are counted, never parsed, by default (§4.2.1). Callers
 * override per read via `countOnlyTypes`, or force a parse per line via
 * `parseCountOnly`.
 */
export const DEFAULT_COUNT_ONLY_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'agent-name',
  'atis-latch',
  'queue-operation',
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'frame-link',
]);

/** Options for {@link readJsonl}. */
export interface JsonlReadOptions {
  /** Absolute byte offset to start reading from (incremental resume, §4.9). Default `0`. */
  startOffset?: number;
  /** Sniff line types and apply count-only skipping. Default `true`; `false` parses every line (`sniffedType` stays `null`). */
  sniff?: boolean;
  /** Types to count without parsing. Default {@link DEFAULT_COUNT_ONLY_TYPES}. */
  countOnlyTypes?: ReadonlySet<string>;
  /** Called per count-only line; returning `true` parses it anyway (e.g. `ai-title` until a title is seen). */
  parseCountOnly?: (type: string) => boolean;
  /** Lines longer than this many bytes (content, terminator excluded) are reported `bad` without decoding. Default 64 MiB. */
  maxLineBytes?: number;
}

/** What one {@link readJsonl} pass observed (the generator's return value). */
export interface JsonlSummary {
  /** Lines that yielded a record: parsed OK or count-only. Bad lines are counted in `badLines` instead. */
  lines: number;
  /** Bytes read from the source by this call (from `startOffset` through EOF). */
  bytes: number;
  /** Lines whose JSON failed to parse (or exceeded `maxLineBytes`). Never throws. */
  badLines: number;
  /** Absolute offset just past the last newline-terminated line; a trailing partial line is excluded. */
  bytesParsed: number;
  /** SHA-256 (hex) of file bytes `[bytesParsed − min(4096, bytesParsed), bytesParsed)` (§4.9). */
  tailHash: string;
  /** Count of skipped lines per sniffed type. */
  countOnly: Record<string, number>;
  /** Occurrences of raw U+2028/U+2029 (UTF-8 `E2 80 A8`/`E2 80 A9`) in line bytes. */
  lineSeparatorChars: number;
  /** Byte length of the longest line seen (content only, `\r\n` excluded). */
  maxLineBytes: number;
  /** At least one line ended in `\r\n`. */
  crlf: boolean;
}

/**
 * Sniffs a line's record type from its first {@link SNIFF_WINDOW} bytes with
 * `/"type":"([a-z_-]+)"/`, without a full parse. Returns `null` when the
 * pattern does not appear inside the window (the caller then parses the line
 * normally). The window is decoded as latin1, so a multi-byte character cut
 * at byte 256 can never throw or shift the match.
 */
export function sniffType(buf: Buffer): string | null {
  const window = buf.length > SNIFF_WINDOW ? buf.subarray(0, SNIFF_WINDOW) : buf;
  const match = SNIFF_RE.exec(window.toString('latin1'));
  return match?.[1] ?? null;
}

/**
 * Splits `chunk` (prefixed by `carry`, the unterminated remainder of the
 * previous chunk) on `0x0A` bytes only. Returned line buffers exclude the
 * `0x0A` terminator but keep any trailing `0x0D` (the caller strips it);
 * `carry` is the bytes after the last newline, to prepend to the next chunk.
 * Exported for the hook salvage path, which splits stdin the same way.
 */
export function splitLines(chunk: Buffer, carry: Buffer): { lines: Buffer[]; carry: Buffer } {
  const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
  const lines: Buffer[] = [];
  let start = 0;
  let nl = buf.indexOf(NL, start);
  while (nl !== -1) {
    lines.push(buf.subarray(start, nl));
    start = nl + 1;
    nl = buf.indexOf(NL, start);
  }
  return { lines, carry: start === 0 ? buf : buf.subarray(start) };
}

/** Occurrences of `needle` in `buf` (non-overlapping; needles never overlap here). */
function countOccurrences(buf: Buffer, needle: Buffer): number {
  let count = 0;
  let at = buf.indexOf(needle);
  while (at !== -1) {
    count++;
    at = buf.indexOf(needle, at + needle.length);
  }
  return count;
}

/** Reads `length` bytes of a file starting at absolute offset `start` (tail-hash window). */
async function readFileRange(path: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return EMPTY;
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Streams a JSONL source line by line, yielding one {@link RawLine} per
 * non-blank physical line and returning a {@link JsonlSummary}.
 *
 * Guarantees:
 * - splitting happens on `0x0A` bytes only; raw U+2028/U+2029/NEL and `\r`
 *   inside strings survive intact (they are counted in `lineSeparatorChars`);
 * - `JSON.parse` failures (including raw control bytes such as NUL inside a
 *   string, which strict JSON rejects) yield `{bad: true}` and never throw;
 *   invalid UTF-8 decodes to U+FFFD replacement characters and still parses;
 * - a trailing line without a newline is classified like any other line but
 *   is excluded from `bytesParsed`/`tailHash`, so an incremental resume from
 *   `bytesParsed` re-reads it once complete and never skips a record;
 * - blank lines (empty, or a lone `\r`) are skipped without counting;
 * - `RawLine.bytes` is the bytes the line occupies in the source *including*
 *   its terminator, so `byteOffset + bytes` is always the next line's offset.
 */
export async function* readJsonl(src: LineSource, opts: JsonlReadOptions = {}): AsyncGenerator<RawLine, JsonlSummary, void> {
  const startOffset = opts.startOffset ?? 0;
  const sniff = opts.sniff ?? true;
  const countOnlyTypes = opts.countOnlyTypes ?? DEFAULT_COUNT_ONLY_TYPES;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const { parseCountOnly } = opts;

  let seq = 0;
  let lines = 0;
  let badLines = 0;
  let bytesRead = 0;
  /** Absolute offset of the next unprocessed byte. */
  let offset = startOffset;
  /** Absolute offset just past the last complete line. */
  let bytesParsed = startOffset;
  let largestLine = 0;
  let lineSeparatorChars = 0;
  let crlf = false;
  const countOnly: Record<string, number> = {};

  const textBuf = src.kind === 'text' ? Buffer.from(src.text, 'utf8') : null;

  const processLine = (raw: Buffer, terminated: boolean): RawLine | null => {
    const byteOffset = offset;
    const occupied = raw.length + (terminated ? 1 : 0);
    offset += occupied;
    if (terminated) bytesParsed = offset;
    let content = raw;
    if (terminated && content.length > 0 && content[content.length - 1] === CR) {
      content = content.subarray(0, content.length - 1);
      crlf = true;
    }
    if (content.length === 0) return null;
    lineSeparatorChars += countOccurrences(content, LINE_SEP) + countOccurrences(content, PARA_SEP);
    if (content.length > largestLine) largestLine = content.length;
    const sniffedType = sniff ? sniffType(content) : null;
    if (sniffedType !== null && countOnlyTypes.has(sniffedType)) {
      const parseAnyway =
        parseCountOnly?.(sniffedType) === true ||
        (sniffedType === 'attachment' && ATTACHMENT_PARSE_MARKERS.some((marker) => content.includes(marker)));
      if (!parseAnyway) {
        countOnly[sniffedType] = (countOnly[sniffedType] ?? 0) + 1;
        lines++;
        return { seq: seq++, bytes: occupied, byteOffset, sniffedType, countOnly: true };
      }
    }
    if (content.length > maxLineBytes) {
      badLines++;
      return { seq: seq++, bytes: occupied, byteOffset, sniffedType, bad: true };
    }
    try {
      const json: unknown = JSON.parse(content.toString('utf8'));
      lines++;
      return { seq: seq++, bytes: occupied, byteOffset, sniffedType, json };
    } catch {
      badLines++;
      return { seq: seq++, bytes: occupied, byteOffset, sniffedType, bad: true };
    }
  };

  let carry: Buffer = EMPTY;
  const consumeChunk = function* (chunk: Buffer): Generator<RawLine> {
    bytesRead += chunk.length;
    const split = splitLines(chunk, carry);
    carry = split.carry;
    for (const line of split.lines) {
      const out = processLine(line, true);
      if (out !== null) yield out;
    }
  };

  if (src.kind === 'text') {
    if (textBuf !== null && startOffset < textBuf.length) yield* consumeChunk(textBuf.subarray(startOffset));
  } else {
    const stream = createReadStream(src.path, { highWaterMark: CHUNK_SIZE, start: startOffset });
    for await (const data of stream) yield* consumeChunk(data as Buffer);
  }
  if (carry.length > 0) {
    const out = processLine(carry, false);
    if (out !== null) yield out;
  }

  const tailLength = Math.min(TAIL_WINDOW, bytesParsed);
  const tail =
    src.kind === 'text'
      ? (textBuf ?? EMPTY).subarray(bytesParsed - tailLength, bytesParsed)
      : await readFileRange(src.path, bytesParsed - tailLength, tailLength);

  return {
    lines,
    bytes: bytesRead,
    badLines,
    bytesParsed,
    tailHash: sha256(tail),
    countOnly,
    lineSeparatorChars,
    maxLineBytes: largestLine,
    crlf,
  };
}
