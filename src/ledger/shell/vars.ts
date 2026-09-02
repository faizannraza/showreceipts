/**
 * Literal shell-variable tracking (§4.5.4). `NAME=value` assignments whose
 * value is literal (single- or double-quoted is fine, but no `$`, backtick or
 * `$(`) earlier in the same command substitute `$NAME`/`${NAME}` in redirect
 * targets, `cd` arguments and `cp/mv/sed` operands. Anything else left in a
 * target — `$…`, `$(…)`, a backtick or a glob — makes it `resolved:false`
 * with the raw text kept. The process environment is never read here.
 */

/** The lexeme facts substitution needs (structurally `segments.ts`'s `Word`). */
export interface WordLike {
  /** Dequoted text (`"$OUT"` → `$OUT`). */
  text: string;
  /** The unquoted portion only (`OUT="/tmp/a"` → `OUT=`). */
  scan: string;
  /** A `$NAME`/`${NAME}`-style expansion appears in an expandable position. */
  dollar: boolean;
  /** A `$(…)`, `` `…` `` or process substitution appears in the word. */
  subst: boolean;
  /** An unquoted glob character (`*`, `?`, `[`) appears in the word. */
  glob: boolean;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One `NAME=value` word; `literal` values enter the substitution map. */
export interface Assignment {
  name: string;
  value: string;
  /** The value contains no `$`, backtick or `$(` (quotes are fine). */
  literal: boolean;
}

/**
 * Parses a `NAME=value` word (the `NAME=` part must be unquoted, so `"a=b"`
 * is not an assignment). Returns `null` for anything else.
 */
export function parseAssignment(word: WordLike): Assignment | null {
  const eq = word.text.indexOf('=');
  if (eq <= 0) return null;
  const name = word.text.slice(0, eq);
  if (!NAME_RE.test(name)) return null;
  if (!word.scan.startsWith(`${name}=`)) return null;
  return { name, value: word.text.slice(eq + 1), literal: !word.dollar && !word.subst };
}

/**
 * Replaces every `$NAME` / `${NAME}` whose name is in `vars` with its value;
 * unknown names are left untouched (they make the result unresolved).
 */
export function substitute(text: string, vars: ReadonlyMap<string, string>): string {
  return text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (whole, braced?: string, bare?: string) => {
    const name = braced ?? bare ?? '';
    const value = vars.get(name);
    return value === undefined ? whole : value;
  });
}

/** A resolved (or knowingly unresolved) target string. */
export interface ResolvedText {
  text: string;
  resolved: boolean;
}

/**
 * Resolves a redirect target / `cd` argument / operand word against the known
 * literal variables: substitutes `$NAME`/`${NAME}`, then flags the result
 * unresolved when a command substitution, a glob, a backtick or any `$`
 * remains (§4.5.4). The raw (substituted) text is always kept.
 */
export function resolveWord(word: WordLike, vars: ReadonlyMap<string, string>): ResolvedText {
  if (word.subst) return { text: word.text, resolved: false };
  const text = word.dollar ? substitute(word.text, vars) : word.text;
  const resolved = !word.glob && !/[$`]/.test(text);
  return { text, resolved };
}
