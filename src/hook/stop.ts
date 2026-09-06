/**
 * Stop-time receipt flow for the transcript harnesses (§9 "Stop-time flow",
 * S28): locate the transcript (Claude Code `transcript_path`; Codex
 * `transcript_path` or the `<codexHome>/sessions/**` rollout whose name ends
 * `-<session_id>.jsonl`, `archived_sessions` included) → subagent Stops
 * answer `{}` and never touch `last-receipt.*` → parse through the S27b
 * cache with incremental tail parsing (`lookupByPath` + `resumeSession`;
 * the recursive subagent scan runs every time, depth ≤ 4) → select the turn
 * whose `promptId` equals stdin `prompt_id` (fallback: the last turn) →
 * flush guard with re-reads (3 × 150 ms) only for a trailing
 * `tool_use`/`stop_reason: null` line or a missing tail → when still
 * unflushed, build anyway with `last_assistant_message` as `finalText`
 * (`finalTextSource: 'stop-hook'`, `incompleteAtStop: true`, the "ledger
 * may be ~0.5 s stale" note; Codex adds the usage note to `cost.notes`) →
 * receipt files through S27 `receipt-files.ts`. `{}` is never the answer
 * merely because of flush state.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { cacheKey, createCache, trimForCache, type CacheEntry } from '../cache/cache.js';
import type { Receipt, Session, SessionRef, Turn } from '../model/types.js';
import { buildReceipt, type ReceiptOptions } from '../pipeline/receipt.js';
import { redactBuilderState } from '../pipeline/redact-state.js';
import { enrichSession } from '../pipeline/resolve-session.js';
import {
  readClaudeCodeSession,
  resumeSession,
  type ClaudeCodeReadOptions,
  type ClaudeCodeReadResult,
  type ResumeAnchor,
} from '../readers/claude-code/reader.js';
import { readCodexSession, type ReadCodexResult } from '../readers/codex/reader.js';
import { realpathOrSelf, statOrNull } from '../util/fs.js';
import { isRecord, parseJsonSafe } from '../util/json.js';
import { TOOL_VERSION } from '../version.js';
import { safeSid } from './paths.js';
import { writeReceiptFiles, type ReceiptFilesInput, type ReceiptFilesResult } from './receipt-files.js';

/** Re-reads after the first unflushed parse (§9: 3 × 150 ms). */
export const REREAD_ATTEMPTS = 3;
/** Pause before each flush-guard re-read (§9). */
export const REREAD_DELAY_MS = 150;
/** The `ledgerNote` an unflushed receipt carries (§9 footer). */
export const STALE_NOTE = 'ledger may be ~0.5 s stale';
/** The `cost.notes` entry of an unflushed Codex receipt (§9). */
export const CODEX_USAGE_NOTE = 'last request usage not yet flushed';
/** A Claude Code subagent transcript path (§9 subagent detection). */
export const SUBAGENT_PATH_RE = /\/subagents\/.*agent-[0-9a-f]+\.jsonl$/;

/** Subagent files the recursive scan accepts (§4.1; mirrors discovery). */
const AGENT_JSONL_RE = /^agent-[0-9a-f]+\.jsonl$/;
const AGENT_META_RE = /^agent-[0-9a-f]+\.meta\.json$/;
const JOURNAL_NAME = 'journal.jsonl';
/** Recursive subagent scan depth cap (§4.1). */
const SUBAGENT_DEPTH = 4;
/** Codex `sessions/YYYY/MM/DD/rollout-*.jsonl` is depth 4; headroom for archives. */
const CODEX_DEPTH = 6;
/** Bytes read from the head/tail of a transcript for the guards. */
const PEEK_BYTES = 64 * 1024;
/** A rollout filename; the capture is the trailing uuid (= session id). */
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The price-table shape, reached through the pipeline layer (§0.5). */
type PriceTable = ReceiptOptions['prices'];

let bundledTable: PriceTable | null = null;

/** The bundled price table (same relative spot in `src/` and `dist/`); a stub on read failure. */
function bundledPrices(): PriceTable {
  if (bundledTable === null) {
    try {
      bundledTable = JSON.parse(readFileSync(new URL('../cost/prices.json', import.meta.url), 'utf8')) as PriceTable;
    } catch {
      bundledTable = { version: 'unknown', unit: 'USD per million tokens', defaults: {}, models: {} };
    }
  }
  return bundledTable;
}

/** Injectable seams; production uses the real readers, timer and receipt-file writer. */
export interface StopSeams {
  /** Flush-guard wait (fake clock in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Cold Claude Code parse. */
  readClaudeCode?: (ref: SessionRef, opts: ClaudeCodeReadOptions) => Promise<ClaudeCodeReadResult>;
  /** Incremental Claude Code parse from a cache anchor (the S27b resume path). */
  resumeClaudeCode?: (ref: SessionRef, anchor: ResumeAnchor, opts: ClaudeCodeReadOptions) => Promise<ClaudeCodeReadResult>;
  /** Codex rollout parse. */
  readCodex?: (ref: SessionRef, opts: { home: string }) => Promise<ReadCodexResult>;
  /** Receipt-file writer (S27 `receipt-files.ts` by default; tests pass a spy). */
  writeFiles?: (input: ReceiptFilesInput) => ReceiptFilesResult;
}

/** Inputs of {@link buildStopReceipt}. */
export interface StopReceiptInput {
  harness: 'claude-code' | 'codex';
  /** Stdin `transcript_path` (`null`/absent triggers the Codex rollout lookup). */
  transcriptPath: string | null;
  /** Stdin session id (raw); `null` when the payload carried none. */
  sessionId: string | null;
  /** Stdin `prompt_id` (Claude Code): selects the turn; fallback is the last turn. */
  promptId?: string | undefined;
  /** Stdin `last_assistant_message` — the flush-guard reference and the unflushed final text. */
  lastAssistantMessage?: string | undefined;
  /** Stdin `agent_id` — present ⇒ subagent Stop (Claude Code). */
  agentId?: string | undefined;
  /** The hook process's working directory (receipt-file location). */
  cwd: string;
  /** The showreceipts home (cache, receipt files); `''` writes nothing. */
  home: string;
  /** The user's home directory (reader `~` expansion, display paths). */
  userHome: string;
  /** `CODEX_HOME` for the rollout-by-suffix lookup. */
  codexHome?: string | undefined;
  now: Date;
  /** Effective price table (bundled `prices.json` by default). */
  prices?: PriceTable | undefined;
  /** Version part of the cache key (default {@link TOOL_VERSION}). */
  toolVersion?: string | undefined;
  /** `--no-cache` / `SHOWRECEIPTS_NO_CACHE=1`, resolved by the dialect. */
  noCache?: boolean | undefined;
  seams?: StopSeams | undefined;
}

/** What {@link buildStopReceipt} produced. */
export interface StopReceiptResult {
  /** `null` for subagent Stops and unlocatable transcripts (the dialect answers `{}`). */
  receipt: Receipt | null;
  /** The Stop belongs to a subagent — nothing was parsed or written. */
  subagent: boolean;
  /** The flush guard never settled; the receipt carries the stdin final text. */
  incompleteAtStop: boolean;
  /** Where the receipt files landed; `null` when nothing was written. */
  files: ReceiptFilesResult | null;
  /** The receipt has no scoreable final text (strict nudges stay silent). */
  effectsOnly: boolean;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Up to `maxBytes` from the head or tail of a file as UTF-8, or `null` when unreadable. */
function boundedRead(path: string, maxBytes: number, end: 'head' | 'tail'): string | null {
  try {
    const stat = statSync(path);
    // §9 self-timeout invariant: `open(2)` on a FIFO with no writer blocks in
    // the kernel — synchronously, so the watchdog timer could never fire.
    // `statSync` on a FIFO does not block; only regular files are read.
    if (!stat.isFile()) return null;
    const size = stat.size;
    const length = Math.min(maxBytes, size);
    const position = end === 'head' ? 0 : size - length;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, position);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** True when `text` (trailing whitespace ignored) ends with the stdin final message. */
function endsWithFinal(text: string, lastAssistantMessage: string): boolean {
  const needle = lastAssistantMessage.trim();
  if (needle === '') return true;
  return text.trimEnd().endsWith(needle);
}

/** The parsed JSON records of the last `n` complete lines of the file (bounded read). */
function tailRecords(path: string, n: number): unknown[] {
  const text = boundedRead(path, PEEK_BYTES, 'tail');
  if (text === null) return [];
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.slice(-n).map((line) => parseJsonSafe(line.trim()));
}

/** The first transcript record, or `null` (missing/unreadable/unparsable head). */
function firstRecord(path: string): unknown {
  const text = boundedRead(path, PEEK_BYTES, 'head');
  if (text === null) return null;
  const nl = text.indexOf('\n');
  return parseJsonSafe((nl === -1 ? text : text.slice(0, nl)).trim());
}

/** Message content of a Claude Code record (string, or the first text block). */
function messageText(rec: Record<string, unknown>): string | null {
  const message = rec['message'];
  if (!isRecord(message)) return null;
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content[0];
    if (isRecord(first) && typeof first['text'] === 'string') return first['text'];
  }
  return null;
}

type TailKind = 'interrupt' | 'stop-sequence' | 'other';

/** Classifies the last Claude Code transcript line for the flush guard. */
function classifyCcTail(path: string): TailKind {
  const records = tailRecords(path, 1);
  const rec = records[records.length - 1];
  if (!isRecord(rec)) return 'other';
  if (rec['type'] === 'user') {
    const text = messageText(rec);
    if (typeof rec['interruptedMessageId'] === 'string' || (text !== null && text.startsWith('[Request interrupted'))) {
      return 'interrupt';
    }
    return 'other';
  }
  if (rec['type'] === 'assistant') {
    const message = rec['message'];
    // A final Claude Code wrote but §4.2.3 never treats as eligible: the
    // reply was cut by a stop sequence or by the max-token limit. Either
    // way the transcript is flushed as far as it will ever be this turn.
    if (isRecord(message) && (message['stop_reason'] === 'stop_sequence' || message['stop_reason'] === 'max_tokens')) {
      return 'stop-sequence';
    }
  }
  return 'other';
}

type FlushState = 'flushed' | 'terminal' | 'pending';

/**
 * The §9 Claude Code flush guard: flushed when the selected turn's final has
 * a non-null `stop_reason !== 'tool_use'` and its text ends with the stdin
 * final; a tail final cut by `stop_sequence`/`max_tokens` or an interrupt
 * line is terminal (no re-reads, no override); anything else — a trailing
 * `tool_use`/`stop_reason: null` line or a missing tail — is pending.
 */
function ccFlushState(turn: Turn | undefined, lastAssistantMessage: string, path: string): FlushState {
  if (
    turn !== undefined &&
    turn.finalText !== null &&
    turn.finalStopReason !== null &&
    turn.finalStopReason !== 'tool_use' &&
    endsWithFinal(turn.finalText, lastAssistantMessage)
  ) {
    return 'flushed';
  }
  const tail = classifyCcTail(path);
  if (tail === 'interrupt' || tail === 'stop-sequence') return 'terminal';
  return 'pending';
}

/** The `{timestamp, type, payload}` frame of one rollout line, or `null`. */
function codexFrame(rec: unknown): { type: string; payload: Record<string, unknown> } | null {
  if (!isRecord(rec) || typeof rec['type'] !== 'string' || !isRecord(rec['payload'])) return null;
  return { type: rec['type'], payload: rec['payload'] };
}

/**
 * The §9 Codex flush guard: the tail must read
 * `agent_message → message(assistant) → token_count` with non-null `info`,
 * and the last `agent_message.message` must equal `last_assistant_message`.
 */
function codexFlushState(lastAssistantMessage: string, path: string): FlushState {
  const tail = tailRecords(path, 3).map(codexFrame);
  if (tail.length < 3) return 'pending';
  const [a, b, c] = [tail[0], tail[1], tail[2]];
  if (a === null || a === undefined || a.type !== 'event_msg' || a.payload['type'] !== 'agent_message') return 'pending';
  if (b === null || b === undefined || b.type !== 'response_item' || b.payload['type'] !== 'message' || b.payload['role'] !== 'assistant') {
    return 'pending';
  }
  if (c === null || c === undefined || c.type !== 'event_msg' || c.payload['type'] !== 'token_count' || !isRecord(c.payload['info'])) {
    return 'pending';
  }
  const message = a.payload['message'];
  const needle = lastAssistantMessage.trim();
  if (needle !== '' && (typeof message !== 'string' || message.trim() !== needle)) return 'pending';
  return 'flushed';
}

/** `readdirSync` with dirents sorted by name; `[]` when unreadable. */
function listDir(dir: string): { name: string; dir: boolean; file: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** Recursive subagent-manifest scan (§4.1: depth ≤ 4, `agent-*` and the journal only). */
function scanSubagentManifest(dir: string, relPrefix: string, depth: number, manifest: SessionRef['subagentManifest']): void {
  for (const entry of listDir(dir)) {
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.dir) {
      if (depth < SUBAGENT_DEPTH) scanSubagentManifest(join(dir, entry.name), rel, depth + 1, manifest);
      continue;
    }
    if (!entry.file) continue;
    if (AGENT_JSONL_RE.test(entry.name) || AGENT_META_RE.test(entry.name) || entry.name === JOURNAL_NAME) {
      const stat = statOrNull(join(dir, entry.name));
      if (stat !== null) manifest.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
}

/** Walks one Codex `sessions`/`archived_sessions` tree for `rollout-*-<sid>.jsonl` (by suffix, §9). */
function findRolloutIn(dir: string, suffix: string, depth: number, out: string[]): void {
  for (const entry of listDir(dir)) {
    if (entry.dir) {
      if (depth < CODEX_DEPTH) findRolloutIn(join(dir, entry.name), suffix, depth + 1, out);
      continue;
    }
    if (entry.file && entry.name.toLowerCase().startsWith('rollout-') && entry.name.toLowerCase().endsWith(suffix)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** The rollout for a session id under `<codexHome>/{sessions,archived_sessions}/**`, or `null`. */
export function findRollout(codexHome: string, sessionId: string): string | null {
  if (codexHome === '' || sessionId === '') return null;
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const found: string[] = [];
  for (const base of ['sessions', 'archived_sessions']) {
    findRolloutIn(join(codexHome, base), suffix, 1, found);
  }
  found.sort();
  return found[0] ?? null;
}

/** One parse pass over the located transcript. */
interface ParsedAttempt {
  session: Session;
  bytesParsed: number;
  tailHash: string;
  builderState?: string;
  /** False when the session came straight out of the cache (Codex warm hit). */
  fromReader: boolean;
  ref: SessionRef;
}

/** The turn `prompt_id` selects, else the last turn (§9). */
function selectStopTurn(session: Session, promptId: string | undefined): Turn | undefined {
  if (promptId !== undefined && promptId !== '') {
    const match = session.turns.find((turn) => turn.promptId === promptId);
    if (match !== undefined) return match;
  }
  return session.turns[session.turns.length - 1];
}

/**
 * Builds the §9 stop receipt for a transcript harness. Subagent Stops and
 * unlocatable transcripts return a `null` receipt (the dialect answers `{}`
 * and never touches `last-receipt.*`); every other outcome — flushed or not —
 * produces a receipt and writes the receipt files through S27
 * `receipt-files.ts` (one `receipts.log` line per call).
 */
export async function buildStopReceipt(input: StopReceiptInput): Promise<StopReceiptResult> {
  const seams = input.seams ?? {};
  const sleep = seams.sleep ?? realSleep;
  const toolVersion = input.toolVersion ?? TOOL_VERSION;
  const lastAssistantMessage = input.lastAssistantMessage ?? '';
  const none: StopReceiptResult = { receipt: null, subagent: false, incompleteAtStop: false, files: null, effectsOnly: true };

  // --- Locate the transcript (§9) ---
  let path = input.transcriptPath ?? '';
  if (input.harness === 'codex' && path === '') {
    path = findRollout(input.codexHome ?? '', input.sessionId ?? '') ?? '';
  }
  if (path === '') return none;

  // --- Subagent detection (§9): `{}` and never touch `last-receipt.*` ---
  if (input.harness === 'claude-code') {
    if (SUBAGENT_PATH_RE.test(path)) return { ...none, subagent: true };
    if (input.agentId !== undefined && input.agentId !== '') return { ...none, subagent: true };
    const head = firstRecord(path);
    if (isRecord(head) && typeof head['agentId'] === 'string' && head['agentId'] !== '') return { ...none, subagent: true };
  }

  const real = realpathOrSelf(path);
  const cache = createCache({
    dir: join(input.home === '' ? '.' : input.home, 'cache'),
    toolVersion,
    disabled: input.home === '' || input.noCache === true,
  });
  const cachedEntry: CacheEntry | null = input.harness === 'claude-code' ? cache.lookupByPath(real) : null;
  const anchor: ResumeAnchor | null = cachedEntry;

  const parseOnce = async (): Promise<ParsedAttempt | null> => {
    const stat = statOrNull(real);
    if (stat === null || !stat.isFile()) return null;
    if (input.harness === 'claude-code') {
      const sessionId = basename(real).replace(/\.jsonl$/, '');
      const subagentDir = join(dirname(real), sessionId, 'subagents');
      const subStat = statOrNull(subagentDir);
      const hasSubagents = subStat !== null && subStat.isDirectory();
      const manifest: SessionRef['subagentManifest'] = [];
      // §9: the recursive subagent scan runs on every Stop, cache hit or not.
      if (hasSubagents) scanSubagentManifest(subagentDir, `${sessionId}/subagents`, 1, manifest);
      manifest.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const ref: SessionRef = { harness: 'claude-code', sessionId, path: real, size: stat.size, mtimeMs: stat.mtimeMs, subagentManifest: manifest };
      const opts: ClaudeCodeReadOptions = { home: input.userHome };
      if (hasSubagents) {
        ref.subagentDir = subagentDir;
        opts.subagents = { kind: 'dir', path: subagentDir };
      }
      const result =
        anchor !== null
          ? await (seams.resumeClaudeCode ?? resumeSession)(ref, anchor, opts)
          : await (seams.readClaudeCode ?? readClaudeCodeSession)(ref, opts);
      return { session: result.session, bytesParsed: result.bytesParsed, tailHash: result.tailHash, builderState: result.builderState, fromReader: true, ref };
    }
    const rollout = ROLLOUT_RE.exec(basename(real));
    const sessionId = input.sessionId ?? (rollout?.[1] ?? basename(real).replace(/\.jsonl$/, '')).toLowerCase();
    const ref: SessionRef = { harness: 'codex', sessionId, path: real, size: stat.size, mtimeMs: stat.mtimeMs, subagentManifest: [] };
    const hit = cache.get(cacheKey(ref, toolVersion));
    if (hit !== null) {
      return { session: hit.session, bytesParsed: hit.bytesParsed, tailHash: hit.tailHash, fromReader: false, ref };
    }
    const result = await (seams.readCodex ?? readCodexSession)(ref, { home: input.userHome });
    return { session: result.session, bytesParsed: result.bytesParsed, tailHash: result.tailHash, fromReader: true, ref };
  };

  // --- Parse + flush guard (§9): re-read 3 × 150 ms only while pending ---
  let attempt: ParsedAttempt | null = null;
  let state: FlushState = 'pending';
  for (let i = 0; ; i += 1) {
    attempt = await parseOnce();
    if (attempt !== null) {
      state =
        input.harness === 'claude-code'
          ? ccFlushState(selectStopTurn(attempt.session, input.promptId), lastAssistantMessage, real)
          : codexFlushState(lastAssistantMessage, real);
      if (state !== 'pending') break;
    }
    if (i >= REREAD_ATTEMPTS) break;
    await sleep(REREAD_DELAY_MS);
  }
  if (attempt === null) return none;

  const session = enrichSession(attempt.session);
  if (session.subagent === true) return { ...none, subagent: true };

  // --- Cache put (before any stop-hook override reaches the session) ---
  if (attempt.fromReader && !cache.disabled) {
    try {
      const key = cacheKey(attempt.ref, toolVersion);
      // A resume whose file state (size, mtime, manifest) still matches the
      // anchor produced exactly the entry already stored under `key` —
      // re-serializing and re-writing it (multi-MB for large sessions,
      // measured ~1 s per Stop on a real 38 MB transcript) buys nothing.
      if (cachedEntry === null || cachedEntry.key !== key) {
        const entry: CacheEntry = { v: 1, key, session: trimForCache(session), bytesParsed: attempt.bytesParsed, tailHash: attempt.tailHash };
        if (attempt.builderState !== undefined) entry.builderState = redactBuilderState(attempt.builderState);
        cache.put(key, entry);
      }
    } catch {
      // a failed cache write never blocks a receipt
    }
  }

  // --- Turn selection + unflushed overrides (§9) ---
  const turn = selectStopTurn(session, input.promptId);
  const incompleteAtStop = state === 'pending';
  if (incompleteAtStop) {
    if (turn !== undefined && lastAssistantMessage !== '') {
      turn.finalText = lastAssistantMessage;
      turn.isDone = true;
      turn.finalTextSource = 'stop-hook';
      if (turn.finalSeq === null) turn.finalSeq = turn.seqEnd;
    }
    session.ledgerNote = session.ledgerNote === undefined ? STALE_NOTE : `${session.ledgerNote}; ${STALE_NOTE}`;
  }

  const receipt = buildReceipt(session, {
    now: input.now,
    prices: input.prices ?? bundledPrices(),
    homeDir: input.userHome,
    turnIndex: turn?.index,
  });
  if (incompleteAtStop) {
    receipt.incompleteAtStop = true;
    if (input.harness === 'codex' && !receipt.cost.notes.includes(CODEX_USAGE_NOTE)) receipt.cost.notes.push(CODEX_USAGE_NOTE);
  }

  // --- Receipt files (§9): last-receipt.{md,json} + one receipts.log line ---
  let files: ReceiptFilesResult | null = null;
  if (input.home !== '') {
    try {
      files = (seams.writeFiles ?? writeReceiptFiles)({
        receipt,
        cwd: input.cwd,
        home: input.home,
        harness: input.harness,
        safeSid: safeSid(input.sessionId ?? session.sessionId),
      });
    } catch {
      files = null; // an unwritable location never blocks the stdout answer
    }
  }

  return { receipt, subagent: false, incompleteAtStop, files, effectsOnly: receipt.finalText.trim() === '' };
}

/** Danger or integrity flags that keep even a NO_CLAIMS receipt audible (§9). */
export function hasWarningFlags(receipt: Receipt): boolean {
  return receipt.alsoDid.some((entry) => entry.warn === true) || receipt.judgements.some((j) => j.integrity !== undefined);
}

/** `mdPath` shown relative to the hook cwd when it lies inside it. */
function displayReceiptPath(mdPath: string, cwd: string): string {
  if (cwd !== '' && mdPath.startsWith(cwd + sep)) return mdPath.slice(cwd.length + 1);
  return mdPath;
}

/** The §9 verdict summary: `1 contradicted · 1 unverified · 3 verified` (zeros omitted). */
function verdictSummary(receipt: Receipt): string {
  const parts: string[] = [];
  if (receipt.counts.CONTRADICTED > 0) parts.push(`${receipt.counts.CONTRADICTED} contradicted`);
  if (receipt.counts.UNVERIFIED > 0) parts.push(`${receipt.counts.UNVERIFIED} unverified`);
  if (receipt.counts.VERIFIED > 0) parts.push(`${receipt.counts.VERIFIED} verified`);
  if (parts.length > 0) return parts.join(' · ');
  switch (receipt.kind) {
    case 'no-final':
      return 'no final message';
    case 'no-turns':
      return 'no assistant turns';
    default:
      return 'no claims recognized';
  }
}

/** The `systemMessage` text: `receipt: <summary> — <path>` (§9). */
export function summaryMessage(receipt: Receipt, files: ReceiptFilesResult | null, cwd: string): string {
  const summary = verdictSummary(receipt);
  return files === null ? `receipt: ${summary}` : `receipt: ${summary} — ${displayReceiptPath(files.mdPath, cwd)}`;
}

/**
 * The non-nudging stop stdout (§9): `{}` for a NO_CLAIMS receipt with no
 * danger/integrity flags (unless `--verbose` forces the message), else
 * `{"systemMessage": "receipt: …", "suppressOutput": true}`.
 */
export function stopStdout(receipt: Receipt, files: ReceiptFilesResult | null, opts: { verbose: boolean; cwd: string }): object {
  if (receipt.verdict === 'NO_CLAIMS' && !hasWarningFlags(receipt) && !opts.verbose) return {};
  return { systemMessage: summaryMessage(receipt, files, opts.cwd), suppressOutput: true };
}
