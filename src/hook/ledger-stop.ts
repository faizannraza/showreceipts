/**
 * Stop-time receipts for ledger harnesses (§9 "Ledger stops", S29): on a
 * stop-class event the dialect hands its pending Appendix C lines here; this
 * module re-reads the session's ledger with the §9 race guard, parses it
 * through the S09 reader (pending lines appended in memory, prepared exactly
 * as `record.ts` will write them), builds the S18 receipt (`cost.usd` is
 * `null` for every ledger session) and writes `last-receipt.{md,json}` +
 * `receipts.log` through S27 `receipt-files.ts`.
 *
 * Race guard (§9): if the last `agent-response`/`tool-post` for the current
 * `tid` is missing from the file, or the file mtime changed within the last
 * 100 ms, re-read after 150 ms up to 3 times; when the race persists the
 * receipt still renders, with `ledgerNote: 'stop raced a tool event'`.
 *
 * Every fs touch and the wait/clock pair are injectable seams so the race
 * loop is testable with a fake clock; production uses bounded `node:fs`
 * reads. The elapsed-time clock deliberately defaults to `Date.now` — the
 * race window measures real wall time between hook processes, while
 * `ctx.now` stays the frozen receipt clock.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { LedgerLine, Receipt, SessionRef } from '../model/types.js';
import { buildReceipt, type ReceiptOptions } from '../pipeline/receipt.js';
import { enrichSession } from '../pipeline/resolve-session.js';
import { readLedgerSession } from '../readers/ledger/reader.js';
import { isRecord, parseJsonSafe } from '../util/json.js';
import type { HookContext } from './dialect.js';
import { ledgerPath, safeSid } from './paths.js';
import { prepareLedgerLine } from './record.js';
import { writeReceiptFiles, type ReceiptFilesInput, type ReceiptFilesResult } from './receipt-files.js';

/** A ledger mtime younger than this (ms) means a tool event may still be in flight (§9). */
export const RACE_WINDOW_MS = 100;
/** Pause before each race re-read (§9). */
export const RACE_RETRY_DELAY_MS = 150;
/** Maximum race re-reads before rendering anyway (§9). */
export const RACE_RETRIES = 3;
/** The `Receipt.ledgerNote` appended when the race never settled (§9). */
export const RACED_NOTE = 'stop raced a tool event';

/** The price-table shape, reached through the pipeline layer (§0.5: hook never imports `cost/*`). */
type PriceTable = ReceiptOptions['prices'];

let bundledTable: PriceTable | null = null;

/**
 * The bundled price table, read as a data asset (`cost/prices.json` sits at
 * the same relative spot in `src/` and `dist/`). Only its `version` string
 * reaches a ledger receipt — `sessionCost` prices ledger sessions as
 * `usd: null` — so an unreadable table degrades to a stub, never a throw.
 */
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

/** Whole-file text of the ledger, or `null` when it does not exist / cannot be read. */
function readTextFs(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** `mtimeMs` of the ledger file, or `null` when it cannot be statted. */
function mtimeFs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Bounded head read for the Copilot final-text fallback (never loads a whole transcript). */
function readHeadFs(path: string, maxBytes: number): string | null {
  try {
    // §9 self-timeout invariant: the stdin-supplied transcript path may name
    // a FIFO — `openSync` on one blocks the event loop forever, so only
    // regular files are opened (`statSync` on a FIFO does not block).
    if (!statSync(path).isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Real timer sleep (the race loop's production wait). */
function sleepFs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Injectable seams; production uses the fs/timer defaults. */
export interface LedgerStopSeams {
  /** Ledger file text (`null` = missing/unreadable). */
  readLedgerText?: (path: string) => string | null;
  /** Ledger file `mtimeMs` (`null` = missing/unstattable). */
  mtimeMs?: (path: string) => number | null;
  /** Elapsed-time clock for the mtime window (defaults to `Date.now`). */
  monotonicMs?: () => number;
  /** Race-loop wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Receipt-file writer (S27 `receipt-files.ts` by default; tests pass a spy). */
  writeFiles?: (input: ReceiptFilesInput) => ReceiptFilesResult;
  /** Copilot transcript head reader handed to the S09 reader. */
  readTranscriptHead?: (path: string, maxBytes: number) => string | null;
  /** Price table override (bundled `prices.json` by default). */
  prices?: PriceTable;
}

/** Inputs of {@link runLedgerStop}. */
export interface LedgerStopInput {
  ctx: HookContext;
  /** The effective raw session id (payload sid, or the runtime's synthetic `unknown-…`). */
  sid: string;
  /**
   * Current turn id when the dialect guarantees a pre-stop line carries it
   * (Cursor `generation_id`: `afterAgentResponse` always precedes `stop`).
   * When set, a file with no `agent-response`/`tool-post` for this tid
   * counts as racing.
   */
  tid?: string | undefined;
  /** Lines this event will append (the runtime performs the appends; the receipt includes them). */
  pendingLines?: readonly LedgerLine[];
  seams?: LedgerStopSeams;
}

/** What {@link runLedgerStop} produced. */
export interface LedgerStopResult {
  receipt: Receipt;
  /** Where the receipt files landed; `null` when no home is known or the write failed. */
  files: ReceiptFilesResult | null;
  /** The race guard exhausted its re-reads (`ledgerNote` carries {@link RACED_NOTE}). */
  raced: boolean;
  /** The receipt has no scoreable final text (strict nudges must stay silent). */
  effectsOnly: boolean;
  /** The reader could not recover a Copilot final text from the stop transcript. */
  copilotTranscriptUnparsed: number;
}

/** True when the ledger text carries an `agent-response`/`tool-post` line for `tid`. */
function hasTurnEvidence(text: string, tid: string): boolean {
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (s === '') continue;
    const json = parseJsonSafe(s);
    if (!isRecord(json)) continue;
    const e = json['e'];
    if ((e === 'agent-response' || e === 'tool-post') && json['tid'] === tid) return true;
  }
  return false;
}

/**
 * Runs the §9 ledger-stop flow: race-guarded ledger read → S09 parse (with
 * the pending lines appended in memory) → S18 receipt (`cost.usd: null`) →
 * `last-receipt.{md,json}` + one `receipts.log` append through S27
 * `receipt-files.ts`. Never throws on fs trouble: a missing ledger builds
 * the receipt from the pending lines alone, and a failed receipt-file write
 * only nulls `files`. The caller (each dialect) turns the result into its
 * harness-specific stdout.
 */
export async function runLedgerStop(input: LedgerStopInput): Promise<LedgerStopResult> {
  const { ctx } = input;
  const seams = input.seams ?? {};
  const readText = seams.readLedgerText ?? readTextFs;
  const mtimeOf = seams.mtimeMs ?? mtimeFs;
  const monotonic = seams.monotonicMs ?? ((): number => Date.now());
  const sleep = seams.sleep ?? sleepFs;

  let path: string | null = null;
  if (ctx.home !== '') {
    try {
      path = ledgerPath(ctx.home, ctx.harness, input.sid);
    } catch {
      path = null; // hostile sid: build from pending lines alone
    }
  }

  // --- §9 race guard: re-read after 150 ms up to 3 times ---
  let text = path === null ? null : readText(path);
  let raced = false;
  if (path !== null) {
    for (let attempt = 0; ; attempt += 1) {
      const missing = input.tid !== undefined && (text === null || !hasTurnEvidence(text, input.tid));
      const mtime = mtimeOf(path);
      const recent = mtime !== null && monotonic() - mtime < RACE_WINDOW_MS;
      if (!missing && !recent) break;
      if (attempt >= RACE_RETRIES) {
        raced = true;
        break;
      }
      await sleep(RACE_RETRY_DELAY_MS);
      text = readText(path);
    }
  }

  // --- Pending lines, prepared exactly as record.ts will append them ---
  const pending = (input.pendingLines ?? []).map((line) => JSON.stringify(prepareLedgerLine(line))).join('\n');
  const base = text ?? '';
  let full = base;
  if (pending !== '') {
    if (full !== '' && !full.endsWith('\n')) full += '\n';
    full += `${pending}\n`;
  }

  const name = path ?? `${ctx.harness}/${safeSid(input.sid)}.jsonl`;
  const ref: SessionRef = {
    harness: ctx.harness,
    sessionId: input.sid,
    path: name,
    size: Buffer.byteLength(full, 'utf8'),
    mtimeMs: (path === null ? null : mtimeOf(path)) ?? 0,
    subagentManifest: [],
    ledger: true,
  };
  const session = enrichSession(
    readLedgerSession(ref, {
      home: ctx.home,
      lines: { kind: 'text', text: full, name },
      readTranscriptHead: seams.readTranscriptHead ?? readHeadFs,
    }),
  );
  if (raced) {
    session.ledgerNote = session.ledgerNote === undefined ? RACED_NOTE : `${session.ledgerNote}; ${RACED_NOTE}`;
  }

  const receipt = buildReceipt(session, {
    now: ctx.now,
    prices: seams.prices ?? bundledPrices(),
    homeDir: ctx.env['HOME'] ?? '',
  });

  const writeFiles = seams.writeFiles ?? writeReceiptFiles;
  let files: ReceiptFilesResult | null = null;
  if (ctx.home !== '') {
    try {
      files = writeFiles({
        receipt,
        cwd: ctx.cwd,
        home: ctx.home,
        harness: ctx.harness,
        safeSid: safeSid(input.sid),
        displayHome: ctx.env['HOME'] ?? '',
      });
    } catch (err) {
      ctx.debug(`${ctx.harness} ${ctx.event}: receipt files not written (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return {
    receipt,
    files,
    raced,
    effectsOnly: receipt.finalText.trim() === '',
    copilotTranscriptUnparsed: session.diagnostics.copilotTranscriptUnparsed,
  };
}
