/**
 * Filesystem helpers for everything showreceipts writes under its own home:
 * atomic replace (temp file in the same directory + `rename`), private
 * directories, the single-`appendFileSync` ledger append (Appendix C) and
 * tolerant readers. The default import of `node:fs` is deliberate — tests spy
 * on the module object to assert the write contracts.
 */
import fs from 'node:fs';
import { dirname, join, basename } from 'node:path';

const MODE_MASK = 0o777;
let tempCounter = 0;

function tempPathFor(target: string): string {
  tempCounter += 1;
  return join(dirname(target), `.${basename(target)}.${process.pid}.${tempCounter}.tmp`);
}

/** `fs.statSync` that returns `null` for a missing or unreadable path. */
export function statOrNull(path: string): fs.Stats | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

/** `fs.realpathSync` falling back to the input when the path does not resolve. */
export function realpathOrSelf(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** Creates `path` (and its parents) as a private directory; mode is applied to the leaf on creation. */
export function ensureDir(path: string, mode = 0o700): void {
  const existing = statOrNull(path);
  if (existing !== null && existing.isDirectory()) return;
  fs.mkdirSync(path, { recursive: true, mode });
  fs.chmodSync(path, mode);
}

export interface AtomicWriteOptions {
  /** Mode for a new file (default `0o600`); an existing file keeps its mode unless `mode` is given. */
  mode?: number;
}

/**
 * Writes `data` to a temp file in the target's directory and renames it over
 * `path`, so readers see either the old or the new content, never a partial
 * one. The mode is applied with `chmod` after writing (immune to the umask);
 * when the target exists and no `mode` is given, its mode is preserved.
 */
export function atomicWriteFile(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const existing = statOrNull(path);
  const mode = options.mode ?? (existing === null ? 0o600 : existing.mode & MODE_MASK);
  const temp = tempPathFor(path);
  try {
    fs.writeFileSync(temp, data, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, path);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // the temp file was never created or is already gone
    }
    throw err;
  }
}

/**
 * Appends one already-serialised line to a ledger with exactly one
 * `fs.appendFileSync(path, buf, {flag: 'a', mode: 0o600})` — `O_APPEND`
 * makes it a single `write(2)` at EOF, so concurrent hooks never tear lines.
 * The caller includes the trailing `\n`.
 */
export function appendLine(path: string, buf: Buffer | string): void {
  fs.appendFileSync(path, buf, { flag: 'a', mode: 0o600 });
}

/** Parses a JSON file; `undefined` when it is missing, unreadable or malformed. */
export function readJsonFile(path: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
