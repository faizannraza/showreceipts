/**
 * Deterministic JSON: `stableStringify` (recursive key sort, compact,
 * `undefined` dropped, `-0` → `0`) is what every receipt, cache entry and
 * report payload is serialised with (§3 invariants, §11.1).
 */

/** True for a non-null, non-array object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toJsonValue(v: unknown): unknown {
  if (typeof v === 'object' && v !== null) {
    const candidate = (v as { toJSON?: unknown }).toJSON;
    if (typeof candidate === 'function') return (candidate as () => unknown).call(v);
  }
  return v;
}

function stringifyValue(value: unknown, seen: Set<object>): string | undefined {
  const v = toJsonValue(value);
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) return 'null';
      return Object.is(v, -0) ? '0' : String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('stableStringify: BigInt values are not serialisable');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  if (v === null) return 'null';
  const obj = v as object;
  if (seen.has(obj)) throw new TypeError('stableStringify: circular structure');
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    const items = obj.map((item) => stringifyValue(item, seen) ?? 'null');
    out = `[${items.join(',')}]`;
  } else {
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const encoded = stringifyValue((obj as Record<string, unknown>)[key], seen);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    out = `{${parts.join(',')}}`;
  }
  seen.delete(obj);
  return out;
}

/**
 * `JSON.stringify` with sorted object keys at every depth and no whitespace.
 * `undefined`, functions and symbols are dropped from objects and become
 * `null` in arrays (as in `JSON.stringify`); non-finite numbers become
 * `null`; `-0` becomes `0`; `toJSON` is honoured (dates serialise as ISO).
 * A top-level value that would be dropped (`undefined`, a function) throws
 * rather than returning an empty string: receipts are always objects.
 */
export function stableStringify(v: unknown): string {
  const out = stringifyValue(v, new Set());
  if (out === undefined) throw new TypeError('stableStringify: top-level value is not serialisable');
  return out;
}

/** `JSON.parse` that returns `undefined` instead of throwing on malformed text. */
export function parseJsonSafe(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
