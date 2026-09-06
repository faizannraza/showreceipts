/**
 * Hook stdin (§9): fd 0 is read to EOF unconditionally — a hook must never
 * exit before draining, or the harness may see EPIPE — buffered up to
 * 32 MiB. Over the cap only the head is kept (the rest is drained and
 * counted); an over-cap or unparsable payload is salvaged by regex from its
 * first 64 KiB. A TTY stdin (a human ran `showreceipts hook` by hand) is
 * treated as `{}` without reading, and so is an empty pipe.
 */
import fs from 'node:fs';
import { isatty } from 'node:tty';

/** The stdin buffer cap (§9, Appendix E: 32 MiB — 17× the largest observed event). */
export const STDIN_MAX_BYTES = 32 * 1024 * 1024;
/** How much of the head is kept for regex salvage on overflow/unparsable payloads. */
export const SALVAGE_HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 64 * 1024;
const EAGAIN_RETRIES = 2500; // ×2 ms ≈ 5 s of patience per single stall (slow CI runners)

/** Fields regex-salvaged from the first 64 KiB of an overflowed or unparsable payload (§9). */
export interface StdinSalvage {
  /** `hook_event_name`. */
  hookEventName?: string;
  /** `conversation_id` | `session_id` | `sessionId`, in that precedence. */
  sid?: string;
  /** `generation_id` | `turn_id`. */
  tid?: string;
  /** `tool_name` | `toolName`. */
  toolName?: string;
  /** `"command"`. */
  command?: string;
  /** `"file_path"`. */
  filePath?: string;
}

/** What one stdin drain produced. */
export interface StdinRead {
  /** The parsed payload; `{}` for a TTY or empty stdin; `null` when over the cap or unparsable. */
  json: unknown | null;
  /** Regex-salvaged fields (only populated when `json` is `null`). */
  salvage: StdinSalvage;
  /** Total bytes drained from the descriptor. */
  bytes: number;
  /** The payload exceeded the cap. */
  overflow: boolean;
  /** The drain ended on a read error (never a plain EOF): its code and the bytes drained by then. */
  error?: { code: string; bytes: number };
}

/** Test seams; production uses the defaults (fd 0, real TTY check, 32 MiB / 64 KiB). */
export interface ReadStdinOptions {
  fd?: number;
  isTTY?: boolean;
  maxBytes?: number;
  salvageBytes?: number;
}

function isTtySafe(fd: number): boolean {
  try {
    return isatty(fd);
  } catch {
    return false;
  }
}

/** Synchronous ~`ms` pause for EAGAIN retries (no timers: the read loop is synchronous). */
function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: retry without pausing
  }
}

const KEY_VALUE_TAIL = '\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"';

/** The first matching key's JSON-unescaped string value, in key order. */
function firstMatch(text: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const m = new RegExp(`"${key}"${KEY_VALUE_TAIL}`).exec(text);
    if (m !== null) {
      const raw = m[1] as string;
      try {
        return JSON.parse(`"${raw}"`) as string;
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

/**
 * Regex salvage over the head of an overflowed/unparsable payload (§9):
 * `hook_event_name`, `conversation_id|session_id|sessionId`,
 * `generation_id|turn_id`, `tool_name|toolName`, `"command"`, `"file_path"`.
 */
export function salvageFields(head: string): StdinSalvage {
  const salvage: StdinSalvage = {};
  const event = firstMatch(head, ['hook_event_name']);
  if (event !== undefined) salvage.hookEventName = event;
  const sid = firstMatch(head, ['conversation_id', 'session_id', 'sessionId']);
  if (sid !== undefined) salvage.sid = sid;
  const tid = firstMatch(head, ['generation_id', 'turn_id']);
  if (tid !== undefined) salvage.tid = tid;
  const tool = firstMatch(head, ['tool_name', 'toolName']);
  if (tool !== undefined) salvage.toolName = tool;
  const command = firstMatch(head, ['command']);
  if (command !== undefined) salvage.command = command;
  const filePath = firstMatch(head, ['file_path']);
  if (filePath !== undefined) salvage.filePath = filePath;
  return salvage;
}

/**
 * Drains the descriptor to EOF and parses the payload (§9). Never throws:
 * a TTY is `{}` without reading; an empty stream is `{}`; a payload over
 * `maxBytes` is drained to the end (so the writer never blocks), counted,
 * and salvaged from its first `salvageBytes`; unparsable JSON is salvaged
 * the same way. Read errors (EBADF, a stuck non-blocking pipe after the
 * EAGAIN retries) end the drain with whatever arrived.
 */
export function readStdin(options: ReadStdinOptions = {}): StdinRead {
  const fd = options.fd ?? 0;
  if (options.isTTY ?? isTtySafe(fd)) return { json: {}, salvage: {}, bytes: 0, overflow: false };
  const maxBytes = options.maxBytes ?? STDIN_MAX_BYTES;
  const salvageBytes = options.salvageBytes ?? SALVAGE_HEAD_BYTES;
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  let retries = 0;
  let endedOn: string | undefined;
  const scratch = Buffer.allocUnsafe(CHUNK_BYTES);
  for (;;) {
    let read: number;
    try {
      read = fs.readSync(fd, scratch, 0, CHUNK_BYTES, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      // EAGAIN — a non-blocking pipe with nothing buffered yet — always
      // retries within the budget. Any OTHER error while ZERO bytes have
      // arrived gets the same patience (except a true end: win32 'EOF', or
      // a dead descriptor 'EBADF'): treating the first transient error as
      // end-of-drain answered `{}` and silently deposited the event in an
      // unknown-sid ledger (the S31 concurrency drop). Once bytes have
      // arrived, or the budget is spent, the drain ends with what came.
      const retryable = code === 'EAGAIN' || (total === 0 && code !== 'EOF' && code !== 'EBADF');
      if (retryable && retries < EAGAIN_RETRIES) {
        retries += 1;
        sleepMs(2);
        continue;
      }
      if (code !== 'EOF') endedOn = code; // win32 'EOF' is a normal end, not an error
      break; // EOF (win32 pipes), EBADF, EIO, or a pipe that never becomes readable
    }
    if (read <= 0) break;
    total += read;
    // Progress resets the EAGAIN patience: the retry budget bounds one
    // silent STALL, never the whole drain. A slow writer feeding 33 MiB
    // through a pipe (macOS CI under load) stalls many times; counting
    // those stalls cumulatively ended the drain early, the process exited,
    // and the still-writing harness took an EPIPE — the exact failure the
    // §9 contract forbids.
    retries = 0;
    if (kept < maxBytes) {
      chunks.push(Buffer.from(scratch.subarray(0, read)));
      kept += read;
    }
  }
  // The §9 hook runtime logs `error` to hook.log so a dropped event is
  // visible post-hoc; a clean EOF never sets it.
  const withError = (r: StdinRead): StdinRead => {
    if (endedOn !== undefined) r.error = { code: endedOn, bytes: total };
    return r;
  };
  if (total === 0) return withError({ json: {}, salvage: {}, bytes: 0, overflow: false });
  const body = Buffer.concat(chunks);
  if (total > maxBytes) {
    const head = body.subarray(0, salvageBytes).toString('utf8');
    return withError({ json: null, salvage: salvageFields(head), bytes: total, overflow: true });
  }
  const text = body.toString('utf8');
  try {
    return withError({ json: JSON.parse(text) as unknown, salvage: {}, bytes: total, overflow: false });
  } catch {
    const head = body.subarray(0, salvageBytes).toString('utf8');
    return withError({ json: null, salvage: salvageFields(head), bytes: total, overflow: false });
  }
}
