/**
 * Session-id helpers: the version-aware short id (§4.1, Appendix E) and the
 * path-safe session id used for ledger and state file names (§9).
 */
import { sha256 } from './hash.js';

const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([1-8])([0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/i;
const SAFE_SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The RFC 4122/9562 version nibble of a UUID when it is 4 or 7; `null` for
 * every other string (other versions, missing dashes, wrong variant).
 */
export function uuidVersion(id: string): 4 | 7 | null {
  const m = UUID_RE.exec(id);
  if (m === null) return null;
  const version = m[3];
  if (version === '4') return 4;
  if (version === '7') return 7;
  return null;
}

/**
 * The printed short id (§4.1): the first 8 hex of a UUIDv4 (users recognise
 * Claude Code files by prefix), the **last** 8 hex of a UUIDv7 (Codex ids
 * start with a timestamp that changes every 65.5 s), and the first 8 hex of
 * `sha256(harness + ':' + id)` for anything else. Widening to 12 hex on a
 * collision is the pipeline's job.
 */
export function shortId(harness: string, id: string): string {
  const version = uuidVersion(id);
  if (version === 4) return id.slice(0, 8).toLowerCase();
  const hex = id.replace(/-/g, '').toLowerCase();
  if (version === 7) return hex.slice(-8);
  return sha256(`${harness}:${id}`).slice(0, 8);
}

/**
 * A session id that is safe to use as a file name inside a directory (§9):
 * the id itself when it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, else
 * `'h' + sha256(id).slice(0, 32)`. Rejects path separators, `..`, leading
 * dots, backslashes, whitespace, empty and over-long ids.
 */
export function safeSid(sid: string): string {
  return SAFE_SID_RE.test(sid) ? sid : `h${sha256(sid).slice(0, 32)}`;
}
