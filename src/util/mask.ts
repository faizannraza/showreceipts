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

/** `key=value` assignments whose key names a credential (§4.9: `(password|passwd|secret|token)=\S+`): the value — a quoted string or everything up to whitespace — is masked, the key kept. */
const KEY_VALUE = /([A-Za-z0-9_-]*(?:password|passwd|secret|token))=("[^"]*"|'[^']*'|\S+)/gi;
/** A quote/backtick run closing an unquoted value (`curl "…?token=x"`): kept so the surrounding literal stays balanced. */
const CLOSING_DELIMITERS = /["'`]+$/;

/** Replaces every credential-shaped substring of `s` with `«masked»`. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const re of WHOLE) out = out.replace(re, MASK);
  out = out.replace(KEY_VALUE, (_m, key: string, value: string) => {
    const closing = /^["']/.test(value) ? '' : (CLOSING_DELIMITERS.exec(value)?.[0] ?? '');
    return `${key}=${MASK}${closing}`;
  });
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
