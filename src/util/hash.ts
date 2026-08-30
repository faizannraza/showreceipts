/** Hashing helpers over `node:crypto` (hex digests; strings are hashed as UTF-8). */
import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string (UTF-8) or a Buffer. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-1 hex digest of a string (UTF-8) or a Buffer (claim ids, §3 invariants). */
export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** The first `n` hex characters of `sha256(input)` (`n` is clamped to 1…64). */
export function shortHash(input: string | Buffer, n: number): string {
  const length = Math.min(64, Math.max(1, Math.floor(n)));
  return sha256(input).slice(0, length);
}
