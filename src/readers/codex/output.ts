/**
 * The Codex tool-output grammar (ARCHITECTURE §4.3.3).
 *
 * Four parsers are tried in order:
 *  1. the unified-exec header (`Chunk ID: …` / `Wall time: …` /
 *     `Process exited with code N` | `Process running with session ID N` /
 *     `Original token count: N` / `Output:` + body) — the header is parsed
 *     only up to the first `Output:` line;
 *  2. a JSON string `{output, metadata{exit_code, duration_seconds}}`
 *     (the `shell_command` dialects use it too);
 *  3. the plain header (`Exit code: N` + `Wall time: F seconds` + `Output:`);
 *  4. the failure prefixes `exec_command failed:` / `write_stdin failed:` /
 *     `shell_command failed:` (exit from an embedded `exit_code: N`;
 *     `Codex(Sandbox(Denied` ⇒ a sandbox denial — never a run, never a
 *     danger/network fact).
 * No match ⇒ `parser:'none'`, exit unknown, never green (the reader counts it
 * in `unknownCodexPayloads`).
 *
 * Harness truncation (§4.3.3): a body starting `Total output lines: N` is
 * stripped of that marker line, and any `…N tokens truncated…` marker line is
 * removed, before runner parsers ever see the body; both set
 * `truncated:true` (receipts say "(output truncated by Codex)").
 */
import { isRecord, parseJsonSafe } from '../../util/json.js';

const OUTPUT_LINE_RE = /^Output:\r?$/m;
const CHUNK_ID_RE = /^Chunk ID: (\S+)/;
const WALL_TIME_RE = /^Wall time: ([\d.]+) seconds$/m;
const EXITED_RE = /^Process exited with code (-?\d+)$/m;
const RUNNING_RE = /^Process running with session ID (\d+)$/m;
const ORIGINAL_TOKENS_RE = /^Original token count: (\d+)$/m;
const PLAIN_EXIT_RE = /^Exit code: (-?\d+)$/m;
const FAILURE_PREFIX_RE = /^(exec_command|write_stdin|shell_command) failed:/;
const EMBEDDED_EXIT_RE = /exit_code: (-?\d+)/;
const SANDBOX_DENIED_MARKER = 'Codex(Sandbox(Denied';
const TOTAL_LINES_RE = /^Total output lines: (\d+)\r?\n?/;
/** The `…N tokens truncated…` marker (U+2026 ellipses), matched per line. */
const TOKENS_TRUNCATED_RE = /…\d+ tokens truncated…/;

/** Which parser matched a raw output string. */
export type CodexOutputParser = 'unified' | 'json' | 'plain' | 'failure' | 'none';

/** The parse of one Codex tool output (§4.3.3). */
export interface CodexOutput {
  parser: CodexOutputParser;
  /** The output body (after the header), truncation marker lines stripped. */
  body: string;
  /**
   * The exit code exactly as reported (`-1` included — the caller maps `-1`
   * to `exitCode:null` + `terminated`); `null` when none was reported.
   */
  exitCode: number | null;
  /** `harness` for header/JSON exits, `parsed` for embedded failure exits, else `unknown`. */
  exitCodeSource: 'harness' | 'parsed' | 'unknown';
  /** A failure-prefixed output. */
  isError: boolean;
  /** `Codex(Sandbox(Denied` appeared — never a run, never a danger/network fact. */
  denied?: 'sandbox-denied';
  /** `Process running with session ID N` — the process is still alive. */
  running?: boolean;
  /** The unified-exec session id of a running process. */
  execSessionId?: number;
  chunkId?: string;
  /** `Wall time` / `duration_seconds`, in milliseconds. */
  wallTimeMs?: number;
  /** The header's `Original token count` value. */
  originalTokens?: number;
  /** A harness truncation marker was found (and stripped from `body`). */
  truncated: boolean;
}

/** Strips the harness truncation markers from a body (§4.3.3). */
function stripTruncationMarkers(body: string): { body: string; truncated: boolean } {
  let truncated = false;
  let out = body;
  const total = TOTAL_LINES_RE.exec(out);
  if (total !== null) {
    truncated = true;
    out = out.slice(total[0].length);
  }
  if (TOKENS_TRUNCATED_RE.test(out)) {
    truncated = true;
    out = out
      .split('\n')
      .filter((line) => !TOKENS_TRUNCATED_RE.test(line))
      .join('\n');
  }
  return { body: out, truncated };
}

/** Splits a raw output at its first `Output:` line; `null` when there is none. */
function splitAtOutput(raw: string): { head: string; body: string } | null {
  const m = OUTPUT_LINE_RE.exec(raw);
  if (m === null) return null;
  const bodyStart = m.index + m[0].length + 1; // past the marker line and its `\n`
  return { head: raw.slice(0, m.index), body: bodyStart >= raw.length ? '' : raw.slice(bodyStart) };
}

/**
 * Parses one raw Codex tool output through the §4.3.3 grammar. Never throws;
 * an unrecognisable output comes back as `parser:'none'` with the raw text as
 * body and an unknown exit.
 */
export function parseCodexOutput(raw: string): CodexOutput {
  // (1) unified-exec header — parsed only up to the first `Output:` line.
  const split = splitAtOutput(raw);
  if (split !== null && CHUNK_ID_RE.test(split.head)) {
    const exited = EXITED_RE.exec(split.head);
    const running = RUNNING_RE.exec(split.head);
    if (exited !== null || running !== null) {
      const { body, truncated } = stripTruncationMarkers(split.body);
      const out: CodexOutput = {
        parser: 'unified',
        body,
        exitCode: exited !== null ? Number(exited[1]) : null,
        exitCodeSource: exited !== null ? 'harness' : 'unknown',
        isError: false,
        truncated,
      };
      const chunk = CHUNK_ID_RE.exec(split.head);
      if (chunk?.[1] !== undefined) out.chunkId = chunk[1];
      const wall = WALL_TIME_RE.exec(split.head);
      if (wall?.[1] !== undefined) out.wallTimeMs = Math.round(Number(wall[1]) * 1000);
      const orig = ORIGINAL_TOKENS_RE.exec(split.head);
      if (orig?.[1] !== undefined) out.originalTokens = Number(orig[1]);
      if (running !== null) {
        out.running = true;
        out.execSessionId = Number(running[1]);
      }
      return out;
    }
  }

  // (2) JSON string `{output, metadata{exit_code, duration_seconds}}`.
  if (raw.trimStart().startsWith('{')) {
    const json = parseJsonSafe(raw);
    if (isRecord(json) && typeof json['output'] === 'string' && isRecord(json['metadata'])) {
      const exit = json['metadata']['exit_code'];
      if (typeof exit === 'number' && Number.isFinite(exit)) {
        const { body, truncated } = stripTruncationMarkers(json['output']);
        const out: CodexOutput = {
          parser: 'json',
          body,
          exitCode: exit,
          exitCodeSource: 'harness',
          isError: false,
          truncated,
        };
        const duration = json['metadata']['duration_seconds'];
        if (typeof duration === 'number' && Number.isFinite(duration)) out.wallTimeMs = Math.round(duration * 1000);
        return out;
      }
    }
  }

  // (3) plain header: `Exit code: N` + `Wall time: F seconds` + `Output:`.
  if (split !== null) {
    const exit = PLAIN_EXIT_RE.exec(split.head);
    const wall = WALL_TIME_RE.exec(split.head);
    if (exit !== null && wall !== null) {
      const { body, truncated } = stripTruncationMarkers(split.body);
      const out: CodexOutput = {
        parser: 'plain',
        body,
        exitCode: Number(exit[1]),
        exitCodeSource: 'harness',
        isError: false,
        truncated,
      };
      if (wall[1] !== undefined) out.wallTimeMs = Math.round(Number(wall[1]) * 1000);
      return out;
    }
  }

  // (4) failure prefixes.
  if (FAILURE_PREFIX_RE.test(raw)) {
    const embedded = EMBEDDED_EXIT_RE.exec(raw);
    const out: CodexOutput = {
      parser: 'failure',
      body: raw,
      exitCode: embedded?.[1] !== undefined ? Number(embedded[1]) : null,
      exitCodeSource: embedded !== null ? 'parsed' : 'unknown',
      isError: true,
      truncated: false,
    };
    if (raw.includes(SANDBOX_DENIED_MARKER)) out.denied = 'sandbox-denied';
    return out;
  }

  // No match: exit unknown, never green (the reader counts the diagnostic).
  return { parser: 'none', body: raw, exitCode: null, exitCodeSource: 'unknown', isError: false, truncated: false };
}
