/**
 * Receipt files at stop time (§9, S27): writes `last-receipt.md` (S21
 * Markdown) and `last-receipt.json` into the last-receipt directory — the
 * repository's `.showreceipts/` when the hook's cwd is inside a git
 * worktree, else `<home>/last/<harness>/` — and appends exactly one summary
 * line to `<home>/receipts.log`. All files are written atomically (temp +
 * rename) `0600` in `0700` directories, and the whole receipt is masked
 * first. S28 and S29 import this module for their stop flows.
 */
import { join } from 'node:path';
import type { Harness, Receipt } from '../model/types.js';
import { renderMarkdownReceipt } from '../render/md.js';
import { appendLine, atomicWriteFile, ensureDir } from '../util/fs.js';
import { stableStringify } from '../util/json.js';
import { maskDeep } from '../util/mask.js';
import { sanitizeForCell } from '../util/sanitize.js';
import type { Tz } from '../util/time.js';
import { lastReceiptDir } from './paths.js';

/** Inputs of {@link writeReceiptFiles}. */
export interface ReceiptFilesInput {
  receipt: Receipt;
  /** The hook process's working directory (decides repo vs home location). */
  cwd: string;
  /** The showreceipts home (`receipts.log`, and the fallback location). */
  home: string;
  harness: Harness;
  /** The path-safe session id (signature parity with the S27 path builders). */
  safeSid: string;
  /** Time zone for the Markdown render (default `utc` — deterministic). */
  tz?: Tz;
}

/** Where {@link writeReceiptFiles} wrote. */
export interface ReceiptFilesResult {
  dir: string;
  mdPath: string;
  jsonPath: string;
  logPath: string;
}

/**
 * Writes `last-receipt.md` and `last-receipt.json` (atomic, `0600`) into the
 * §9 last-receipt directory and appends one
 * `t · harness · shortId · verdict counts · path` line to
 * `<home>/receipts.log` — exactly one append per call. The receipt is
 * masked before either render; the JSON is `stableStringify`d so identical
 * receipts produce identical bytes.
 */
export function writeReceiptFiles(input: ReceiptFilesInput): ReceiptFilesResult {
  const { receipt, cwd, home, harness } = input;
  const dir = lastReceiptDir(cwd, home, harness, input.safeSid);
  ensureDir(dir, 0o700);
  const masked = maskDeep(receipt);
  const mdPath = join(dir, 'last-receipt.md');
  const jsonPath = join(dir, 'last-receipt.json');
  atomicWriteFile(mdPath, renderMarkdownReceipt(masked, { tz: input.tz ?? 'utc' }), { mode: 0o600 });
  atomicWriteFile(jsonPath, `${stableStringify(masked)}\n`, { mode: 0o600 });
  ensureDir(home, 0o700);
  const logPath = join(home, 'receipts.log');
  const counts = masked.counts;
  const summary = `${masked.verdict} v${counts.VERIFIED} u${counts.UNVERIFIED} c${counts.CONTRADICTED}`;
  const line = sanitizeForCell(`${masked.endedAt} · ${harness} · ${masked.shortId} · ${summary} · ${mdPath}`);
  appendLine(logPath, `${line}\n`);
  return { dir, mdPath, jsonPath, logPath };
}
