/**
 * Appendix C ledger writer (S27): builds, truncates, masks and appends one
 * hook-captured ledger line per event.
 *
 * Write contract (Appendix C): the whole line (JSON + `\n`) is serialised
 * into one Buffer and appended with exactly one
 * `fs.appendFileSync(path, buf, {flag:'a', mode:0o600})` — `O_APPEND` makes
 * it a single `write(2)` at EOF, so concurrent hooks never tear lines; never
 * open+seek, never read-modify-write, never rename-replace, no locks.
 * `mkdirSync(dir, {recursive:true, mode:0o700})` runs before the first
 * append. Field truncation: `agent-response`/`stop.text` ≤ 64 KiB,
 * `out.text` head/tail ≤ 16 KiB, `prompt.text` ≤ 16 KiB, `in.raw` ≤ 4 KiB,
 * `in.edits` ≤ 32 entries of ≤ 4 KiB each — old and new half a budget each
 * (`editsTruncated`), `error` ≤ 16 KiB; hard cap
 * 256 KiB per serialised line after truncation (a line still over it after a
 * generic 4 KiB string clamp degrades to `gap{reason:'oversize'}`).
 */
import { dirname } from 'node:path';
import type { Harness, LedgerLine, LedgerToolInput } from '../model/types.js';
import { appendLine, ensureDir } from '../util/fs.js';
import { sha256 } from '../util/hash.js';
import { isRecord, stableStringify } from '../util/json.js';
import { maskDeep } from '../util/mask.js';
import type { StdinSalvage } from './stdin.js';

export const AGENT_RESPONSE_MAX_BYTES = 64 * 1024;
export const OUT_TEXT_MAX_BYTES = 16 * 1024;
export const PROMPT_MAX_BYTES = 16 * 1024;
export const IN_RAW_MAX_BYTES = 4 * 1024;
/** Cap per `in.edits` entry (Appendix C: each ≤ 4 KiB) — old and new get half each. */
export const EDIT_MAX_BYTES = 4 * 1024;
export const EDITS_MAX = 32;
const EDIT_STRING_MAX_BYTES = EDIT_MAX_BYTES / 2;
export const LINE_MAX_BYTES = 256 * 1024;
const STOP_TEXT_MAX_BYTES = 64 * 1024;
const ERROR_MAX_BYTES = 16 * 1024;
const SUBAGENT_TEXT_MAX_BYTES = 16 * 1024;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Cuts `s` to at most `max` UTF-8 bytes on a code-point boundary (never splits a sequence). */
export function truncateUtf8(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = Math.max(0, max);
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** The last ≤ `max` UTF-8 bytes of `s`, starting on a code-point boundary. */
function tailUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let start = buf.length - Math.max(0, max);
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/**
 * Head/tail truncation (Appendix C `out.text`): keeps the first and last
 * halves of the byte budget around an elision marker; the result never
 * exceeds `max` UTF-8 bytes.
 */
export function headTail(s: string, max: number): { text: string; truncated: boolean } {
  const total = byteLength(s);
  if (total <= max) return { text: s, truncated: false };
  const marker = `\n…[${total} bytes total, truncated]…\n`;
  const budget = max - byteLength(marker);
  if (budget < 2) return { text: truncateUtf8(s, Math.max(0, max)), truncated: true };
  const head = truncateUtf8(s, Math.ceil(budget / 2));
  const tail = tailUtf8(s, Math.floor(budget / 2));
  return { text: `${head}${marker}${tail}`, truncated: true };
}

/**
 * The Appendix C fallback tool id for harnesses that supply none (Gemini,
 * Copilot): `'h' + sha256(t + tool + stableStringify(in)).slice(0, 12)` —
 * stable for identical `(t, tool, in)`.
 */
export function fallbackToolId(t: string, tool: string, input: LedgerToolInput): string {
  return `h${sha256(t + tool + stableStringify(input)).slice(0, 12)}`;
}

function truncateToolInput(input: LedgerToolInput): void {
  if (input.raw !== undefined) input.raw = truncateUtf8(input.raw, IN_RAW_MAX_BYTES);
  if (input.edits !== undefined) {
    let truncated = input.edits.length > EDITS_MAX;
    const edits = input.edits.slice(0, EDITS_MAX).map((edit) => {
      const cutOld = truncateUtf8(edit.old, EDIT_STRING_MAX_BYTES);
      const cutNew = truncateUtf8(edit.new, EDIT_STRING_MAX_BYTES);
      if (cutOld !== edit.old || cutNew !== edit.new) truncated = true;
      return { old: cutOld, new: cutNew };
    });
    input.edits = edits;
    if (truncated) input.editsTruncated = true;
  }
}

/**
 * Applies the Appendix C per-field truncation caps to a (deep-cloned copy
 * of a) ledger line. Never mutates its argument; `out.bytes` is left as the
 * dialect set it (the original size), only `out.text` shrinks.
 */
export function truncateLedgerLine(line: LedgerLine): LedgerLine {
  const out = structuredClone(line);
  switch (out.e) {
    case 'prompt':
      out.text = truncateUtf8(out.text, PROMPT_MAX_BYTES);
      break;
    case 'agent-response':
      out.text = truncateUtf8(out.text, AGENT_RESPONSE_MAX_BYTES);
      break;
    case 'tool-post': {
      truncateToolInput(out.in);
      const cut = headTail(out.out.text, OUT_TEXT_MAX_BYTES);
      out.out.text = cut.text;
      if (cut.truncated) out.out.truncated = true;
      break;
    }
    case 'tool-fail':
      truncateToolInput(out.in);
      out.error = truncateUtf8(out.error, ERROR_MAX_BYTES);
      break;
    case 'stop':
      if (out.text !== undefined) out.text = truncateUtf8(out.text, STOP_TEXT_MAX_BYTES);
      break;
    case 'subagent-stop':
      if (out.agent.text !== undefined) out.agent.text = truncateUtf8(out.agent.text, SUBAGENT_TEXT_MAX_BYTES);
      if (out.agent.summary !== undefined) out.agent.summary = truncateUtf8(out.agent.summary, EDIT_MAX_BYTES);
      break;
    case 'session-start':
    case 'session-end':
    case 'gap':
      break;
  }
  return out;
}

/** Common keys first (Appendix C order), then the event's own keys in construction order. */
const COMMON_ORDER: readonly string[] = ['v', 't', 'h', 'e', 'sid', 'tid', 'cwd', 'hv', 'model', 'exitSource'];

function serializeLine(line: LedgerLine): string {
  const rec = line as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of COMMON_ORDER) {
    if (rec[key] !== undefined) ordered[key] = rec[key];
  }
  for (const [key, value] of Object.entries(rec)) {
    if (!COMMON_ORDER.includes(key) && value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/** Emergency clamp for the 256 KiB hard cap: every string cut to 4 KiB. */
function clampStrings(value: unknown): unknown {
  if (typeof value === 'string') return truncateUtf8(value, EDIT_MAX_BYTES);
  if (Array.isArray(value)) return value.map((item) => clampStrings(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clampStrings(item);
    return out;
  }
  return value;
}

/**
 * Field truncation → masking → the 256 KiB hard cap. A line still over the
 * cap after the generic string clamp (pathological array payloads) degrades
 * to `gap{reason:'oversize', bytes}` so the append contract always holds.
 * `bytes` on that degradation gap is the serialised size of the clamped line
 * that still broke the cap (the only size knowable here) — unlike stdin
 * salvage gaps, whose `bytes` count the stdin bytes drained.
 */
export function prepareLedgerLine(line: LedgerLine): LedgerLine {
  let out = maskDeep(truncateLedgerLine(line));
  if (byteLength(serializeLine(out)) <= LINE_MAX_BYTES) return out;
  out = clampStrings(out) as LedgerLine;
  const bytes = byteLength(serializeLine(out));
  if (bytes <= LINE_MAX_BYTES) return out;
  return { v: 1, t: line.t, h: line.h, e: 'gap', sid: line.sid, reason: 'oversize', bytes };
}

/**
 * Appends one event to the ledger file: {@link prepareLedgerLine}, then
 * `mkdirSync(dir, {recursive:true, mode:0o700})` when the directory is
 * missing, then exactly one `appendFileSync(path, buf, {flag:'a',
 * mode:0o600})`. Returns the line as written (for tests and callers that
 * log it).
 */
export function appendLedgerLine(path: string, line: LedgerLine): LedgerLine {
  const prepared = prepareLedgerLine(line);
  ensureDir(dirname(path), 0o700);
  appendLine(path, Buffer.from(`${serializeLine(prepared)}\n`, 'utf8'));
  return prepared;
}

/** Inputs of {@link salvageLedgerLine}. */
export interface SalvageLineInput {
  /** ISO UTC timestamp of the invocation (`ctx.now`). */
  t: string;
  harness: Harness;
  /** The raw session id (salvaged, or the synthetic `unknown-…`). */
  sid: string;
  salvage: StdinSalvage;
  /** Total stdin bytes drained. */
  bytes: number;
  reason: 'oversize' | 'unparsable';
}

/**
 * The ledger line recorded for an over-cap or unparsable stdin payload
 * (§9): with a salvaged `tool_name`, a `tool-post` carrying
 * `out:{text:'', bytes, truncated:true}` and `exitSource:'unknown'` (plus
 * `in.command`/`in.path` when salvaged); without one, `gap{reason, bytes}`.
 */
export function salvageLedgerLine(input: SalvageLineInput): LedgerLine {
  const { t, harness, sid, salvage, bytes, reason } = input;
  if (salvage.toolName === undefined) {
    const gap: LedgerLine = { v: 1, t, h: harness, e: 'gap', sid, reason, bytes };
    if (salvage.tid !== undefined) gap.tid = salvage.tid;
    return gap;
  }
  const toolIn: LedgerToolInput = {};
  if (salvage.command !== undefined) toolIn.command = salvage.command;
  if (salvage.filePath !== undefined) toolIn.path = salvage.filePath;
  const post: Extract<LedgerLine, { e: 'tool-post' }> = {
    v: 1,
    t,
    h: harness,
    e: 'tool-post',
    sid,
    exitSource: 'unknown',
    id: fallbackToolId(t, salvage.toolName, toolIn),
    tool: salvage.toolName,
    kind: salvage.command !== undefined ? 'shell' : 'other',
    in: toolIn,
    out: { text: '', bytes, truncated: true },
  };
  if (salvage.tid !== undefined) post.tid = salvage.tid;
  return post;
}
