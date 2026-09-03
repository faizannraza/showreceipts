/**
 * The `--hash-paths` pass (ARCHITECTURE §11.2, S18): a generic final walk
 * over a JSON-ish value that rewrites every absolute path embedded in any
 * string field and leaves relative ones alone. Paths inside the session's
 * working directory become relative (`src/x.ts`, the cwd itself `.`);
 * everything else becomes `p:<8 hex>/<basename>` where the hex is
 * `sha256(salt · path)` — the salt is never written into the output, so the
 * mapping cannot be reversed without it. §11.2 also requires bare
 * username/home tokens to disappear: callers pass them as `extraTokens` and
 * they are rewritten to `u:<8 hex>` after the path pass. S21 (HTML report)
 * and S22 (export) import this pass and never extend it beyond that
 * parameter (W3 integration decision).
 *
 * Pure: no fs, no env, no clock. The walk copies — the input is never
 * mutated — and only string *values* are rewritten (object keys are shapes,
 * not data).
 */
import { shortHash } from './hash.js';
import { basename, isUnder, toPosix } from './paths.js';

/**
 * One absolute-path token inside a string: `~/…`, `/seg/…`, `C:\…` or
 * `C:/…`, with `[\w.@#+%$=-]` segment characters. The lookbehind rejects a
 * token glued to a word character, `.`, `:`, `/`, `\`, `~` or `-`, which
 * keeps URL tails (`https://host/x`), relative paths (`src/x.ts`), dates
 * (`18/05`) and `$VAR/x` remainders unrewritten.
 */
const PATH_TOKEN_RE = /(?<![\w.:~/\\-])(?:~|[A-Za-z]:)?(?:[/\\][\w.@#+%$=-]+)+[/\\]?/g;

/** Hex length of the hashed directory component (`p:<8 hex>/basename`). */
const HASH_LEN = 8;

/** Normalises the cwd the relative rule compares against. */
function normalCwd(cwd: string): string {
  const p = toPosix(cwd.trim());
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Rewrites one matched path token (§11.2: inside cwd → relative, outside → `p:<hex>/basename`). */
function rewriteToken(token: string, salt: string, cwd: string): string {
  let p = toPosix(token);
  const trailingSlash = p.length > 1 && p.endsWith('/');
  if (trailingSlash) p = p.slice(0, -1);
  if (cwd !== '' && cwd !== '/') {
    if (p === cwd) return '.';
    if (isUnder(p, cwd)) return p.slice(cwd.length + 1) + (trailingSlash ? '/' : '');
  }
  return `p:${shortHash(`${salt}\u0000${p}`, HASH_LEN)}/${basename(p)}`;
}

/** Escapes a literal for embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles the `extraTokens` rewrites (§11.2 bare username/home tokens):
 * deduplicated, longest first (so a home path wins over the username inside
 * it), boundary-guarded against letters/digits/underscore so a token inside a
 * longer word never matches. Tokens shorter than 2 characters are ignored —
 * a 1-character "username" would mangle ordinary prose.
 */
function compileTokens(tokens: readonly string[]): RegExp[] {
  const kept = [...new Set(tokens.filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  return kept.map((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, 'gu'));
}

/** Rewrites every absolute-path token, then every remaining bare extra token, inside one string. */
function rewriteString(s: string, salt: string, cwd: string, tokenRes: readonly RegExp[]): string {
  let out = s.replace(PATH_TOKEN_RE, (token) => rewriteToken(token, salt, cwd));
  for (const re of tokenRes) {
    out = out.replace(re, (token) => `u:${shortHash(`${salt}\u0001${token}`, HASH_LEN)}`);
  }
  return out;
}

function walk(value: unknown, salt: string, cwd: string, tokenRes: readonly RegExp[]): unknown {
  if (typeof value === 'string') return rewriteString(value, salt, cwd, tokenRes);
  if (Array.isArray(value)) return value.map((item) => walk(item, salt, cwd, tokenRes));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const walked = walk(item, salt, cwd, tokenRes);
      if (walked !== undefined) out[key] = walked;
    }
    return out;
  }
  return value;
}

/**
 * Returns a deep copy of `obj` with every absolute path in every string
 * field rewritten (§11.2): paths under `cwd` become relative (the cwd itself
 * `.`), all other absolute paths — `~/…` and drive-letter paths included —
 * become `p:<8 hex>/<basename>` salted with `salt`. Relative paths, URLs and
 * non-string values pass through unchanged; object keys are never rewritten;
 * the salt never appears in the output. `extraTokens` (§11.2 bare
 * username/home tokens) are rewritten to `u:<8 hex>` wherever they appear as
 * standalone tokens — after the path pass, so a username surviving as a
 * hashed basename or inside a URL is caught too.
 */
export function hashStrings<T>(obj: T, salt: string, cwd: string, extraTokens: readonly string[] = []): T {
  return walk(obj, salt, normalCwd(cwd), compileTokens(extraTokens)) as T;
}
