/**
 * Structural validator for the §12.3 `--json` shapes (S23c). Parses the
 * annotated ` ```schema <Name> ` blocks of `docs/receipt-schema.md` and
 * checks objects against them: required keys present, primitive types
 * correct, enum choices known, references resolved. Extra keys are
 * tolerated — a schema names the guaranteed surface, not a closed set.
 * Used by S24–S26, S30 and S31.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The default schema document. */
export const SCHEMA_DOC_PATH = fileURLToPath(new URL('../../docs/receipt-schema.md', import.meta.url));

/** A parsed spec: an annotation string, a one-element array, or an object of specs. */
export type Spec = string | Spec[] | { [key: string]: Spec };

/** The parsed schema document. */
export interface SchemaDoc {
  schemas: ReadonlyMap<string, Spec>;
}

const FENCE_RE = /^```schema[ \t]+([A-Za-z][\w-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/**
 * Loads and parses every ` ```schema <Name> ` block of the document. A block
 * whose body is not valid JSON throws with the block's name.
 */
export function loadSchemaDoc(path: string = SCHEMA_DOC_PATH): SchemaDoc {
  const text = readFileSync(path, 'utf8');
  const schemas = new Map<string, Spec>();
  for (const match of text.matchAll(FENCE_RE)) {
    const name = match[1] as string;
    const body = match[2] as string;
    let spec: unknown;
    try {
      spec = JSON.parse(body);
    } catch (err) {
      throw new Error(`receipt-schema: block '${name}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (schemas.has(name)) throw new Error(`receipt-schema: duplicate block '${name}'`);
    schemas.set(name, spec as Spec);
  }
  if (schemas.size === 0) throw new Error(`receipt-schema: no \`\`\`schema blocks found in ${path}`);
  return { schemas };
}

/** The names of every block in the document, in order. */
export function schemaNames(doc: SchemaDoc): string[] {
  return [...doc.schemas.keys()];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits a union spec on top-level `|` (never inside `(…)`). */
function splitUnion(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const ENUM_RE = /^enum\((.*)\)$/;
const RECORD_RE = /^record\((.*)\)$/;
const REF_RE = /^[A-Z][\w-]*$/;

/** True when `value` matches one atom of a string spec. Throws on an unparsable atom or unknown reference. */
function matchesAtom(doc: SchemaDoc, atom: string, value: unknown, depth: number): boolean {
  switch (atom) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'true':
      return value === true;
    case 'false':
      return value === false;
    case 'any':
      return true;
    case 'object':
      return isPlainObject(value);
    default:
      break;
  }
  if (atom.startsWith('const:')) return value === atom.slice('const:'.length);
  const enumMatch = ENUM_RE.exec(atom);
  if (enumMatch !== null) {
    return typeof value === 'string' && (enumMatch[1] as string).split('|').includes(value);
  }
  const recordMatch = RECORD_RE.exec(atom);
  if (recordMatch !== null) {
    if (!isPlainObject(value)) return false;
    return Object.values(value).every((v) => matchesSpec(doc, recordMatch[1] as string, v, depth + 1));
  }
  if (REF_RE.test(atom)) {
    const target = doc.schemas.get(atom);
    if (target === undefined) throw new Error(`receipt-schema: unknown reference '${atom}'`);
    return matchesSpec(doc, target, value, depth + 1);
  }
  throw new Error(`receipt-schema: unparsable spec atom '${atom}'`);
}

/** Pure probe: does `value` match `spec`? */
function matchesSpec(doc: SchemaDoc, spec: Spec, value: unknown, depth = 0): boolean {
  if (depth > 64) throw new Error('receipt-schema: reference cycle');
  if (typeof spec === 'string') {
    return splitUnion(spec).some((atom) => matchesAtom(doc, atom, value, depth));
  }
  if (Array.isArray(spec)) {
    const element = spec[0];
    if (element === undefined) throw new Error('receipt-schema: empty array spec');
    return Array.isArray(value) && value.every((v) => matchesSpec(doc, element, v, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  for (const [rawKey, keySpec] of Object.entries(spec)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    if (!(key in value)) {
      if (optional) continue;
      return false;
    }
    if (!matchesSpec(doc, keySpec, value[key], depth + 1)) return false;
  }
  return true;
}

/** A short description of a value for error messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `'${value.length > 48 ? `${value.slice(0, 48)}…` : value}'`;
  if (typeof value === 'object') return 'object';
  return `${typeof value} ${String(value)}`;
}

/** Recursive check with per-path error messages. */
function check(doc: SchemaDoc, spec: Spec, value: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 64) throw new Error('receipt-schema: reference cycle');
  if (typeof spec === 'string') {
    const atoms = splitUnion(spec);
    // A single reference alias recurses for precise inner errors.
    if (atoms.length === 1 && REF_RE.test(atoms[0] as string) && !(atoms[0] as string).startsWith('const')) {
      const target = doc.schemas.get(atoms[0] as string);
      if (target === undefined) {
        errors.push(`${path}: unknown schema reference '${atoms[0] as string}'`);
        return;
      }
      check(doc, target, value, path, errors, depth + 1);
      return;
    }
    if (!atoms.some((atom) => matchesAtom(doc, atom, value, depth))) {
      errors.push(`${path}: expected ${spec}, got ${describe(value)}`);
    }
    return;
  }
  if (Array.isArray(spec)) {
    const element = spec[0];
    if (element === undefined) throw new Error('receipt-schema: empty array spec');
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array, got ${describe(value)}`);
      return;
    }
    value.forEach((v, i) => {
      check(doc, element, v, `${path}[${i}]`, errors, depth + 1);
    });
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected object, got ${describe(value)}`);
    return;
  }
  for (const [rawKey, keySpec] of Object.entries(spec)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    if (!(key in value)) {
      if (!optional) errors.push(`${path}.${key}: missing key`);
      continue;
    }
    check(doc, keySpec, value[key], `${path}.${key}`, errors, depth + 1);
  }
}

/**
 * Validates `value` against the named schema. Returns `[]` when it conforms,
 * else one `path: message` line per problem. Throws only for a broken
 * document (unknown name, unparsable atom, cycle).
 */
export function validateAgainst(doc: SchemaDoc, name: string, value: unknown): string[] {
  const spec = doc.schemas.get(name);
  if (spec === undefined) throw new Error(`receipt-schema: no schema named '${name}'`);
  const errors: string[] = [];
  check(doc, spec, value, name, errors);
  return errors;
}

/** Every reference named inside a spec (for the resolution self-test). */
export function referencesOf(spec: Spec): string[] {
  const out = new Set<string>();
  const walk = (s: Spec): void => {
    if (typeof s === 'string') {
      for (const atom of splitUnion(s)) {
        const record = RECORD_RE.exec(atom);
        if (record !== null) {
          walk(record[1] as string);
          continue;
        }
        if (REF_RE.test(atom)) out.add(atom);
      }
      return;
    }
    if (Array.isArray(s)) {
      for (const el of s) walk(el);
      return;
    }
    for (const v of Object.values(s)) walk(v);
  };
  walk(spec);
  return [...out];
}
