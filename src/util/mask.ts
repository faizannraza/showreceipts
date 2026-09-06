/**
 * Secret masking (§4.9): applied to every string before it is written to the
 * cache, a ledger, a receipt or a report. Over-masking is always preferred to
 * leaking, so the patterns are broad and the replacement is a fixed token.
 */

export const MASK = '«masked»';

/** A match whose whole extent is replaced by `MASK`. */
const WHOLE: readonly RegExp[] = [
  // PEM blocks (any private-key label), through the END line or to the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // OpenAI / Anthropic style keys (`sk-…`, `sk-ant-…`, `sk-proj-…`).
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens: classic, OAuth, server/user/refresh, fine-grained.
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[abops]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Bearer credentials.
  /\bBearer [A-Za-z0-9._-]{20,}/gi,
];

/**
 * `key=value` assignments whose key names a credential (§4.9:
 * `(password|passwd|secret|token)=\S+`): the value — a quoted string or
 * everything up to whitespace — is masked, the key kept. The key prefix is
 * bounded (`{0,64}`) so the scan stays linear: an unbounded `*` here
 * backtracks quadratically on long unbroken alphanumeric runs (minified
 * code, base64 blobs) — observed at ~150 s for a 300 KiB run — which would
 * bust the §9 hook budgets. A longer key still matches through its last
 * ≤ 64 prefix characters, so the value is masked either way.
 */
const KEY_VALUE = /([A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token))=("[^"]*"|'[^']*'|\S+)/gi;
/** A quote/backtick run closing an unquoted value (`curl "…?token=x"`): kept so the surrounding literal stays balanced. */
const CLOSING_DELIMITERS = /["'`]+$/;

/**
 * Hint prefilters: each alternative is a substring every match of one of the
 * patterns above must contain, so a string rejected by both hints can contain
 * no secret and is returned untouched. Masking runs over every parsed session
 * (tens of MB on real corpora) and the expensive patterns — `KEY_VALUE`
 * retries its `{0,64}` key prefix at every position — measured 32–51 MB/s;
 * with the hints, secret-free strings (99.9 % of real strings) pass at
 * 250–760 MB/s (7.8× on a real 26 MB corpus), and outputs are byte-identical.
 */
const WHOLE_HINT_CS = /-----BEGIN [A-Z ]*PRIVATE KEY|sk-|gh[pousr]_|github_pat_|AKIA|xox[abops]-|AIza/;
const BEARER_HINT = /Bearer /i;
const KEY_VALUE_HINT = /(?:password|passwd|secret|token)=/i;

/** Replaces every credential-shaped substring of `s` with `«masked»`. */
export function maskSecrets(s: string): string {
  const whole = WHOLE_HINT_CS.test(s) || BEARER_HINT.test(s);
  const keyValue = KEY_VALUE_HINT.test(s);
  if (!whole && !keyValue) return s;
  let out = s;
  if (whole) for (const re of WHOLE) out = out.replace(re, MASK);
  if (keyValue) {
    out = out.replace(KEY_VALUE, (_m, key: string, value: string) => {
      const closing = /^["']/.test(value) ? '' : (CLOSING_DELIMITERS.exec(value)?.[0] ?? '');
      return `${key}=${MASK}${closing}`;
    });
  }
  return out;
}

/**
 * Applies `maskSecrets` to every string inside a JSON-like value: strings,
 * arrays and objects. Any object is walked by its own enumerable string keys
 * and rebuilt as a plain record (so a `Date`, `Map` or class instance does
 * not survive — callers pass JSON-shaped data only, which is all that is ever
 * written to disk); numbers, booleans, `null` and `undefined` are returned
 * unchanged. Produces a new structure; the input is never mutated.
 */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskDeep(item)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskDeep(item);
    return out as T;
  }
  return value;
}
