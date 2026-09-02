/**
 * PATH grammar and subject resolution (ARCHITECTURE §4.7 step 6).
 *
 * A PATH token is
 *  (a) a backticked token containing `/` or a known extension, or ending in `/`
 *      — but backticked content containing whitespace, `<`, `>`, `=` or `$` is
 *      a snippet, never a PATH;
 *  (b) a bare token containing `/`, no spaces, no `://`, whose last segment has
 *      a known extension or which starts with `/ ./ ../ ~/` or a known top
 *      directory, or equals a ledger path/dirname — rejected when any segment
 *      is purely numeric/version-like or ≤ 2 chars, the token contains
 *      `+ , < > ( ) % = |`, or starts with `U+`;
 *  (c) a bare token with a known extension, excluding URLs, bare domains,
 *      versions, decimals and the product stoplist;
 *  (d) a bare basename of a ledger path.
 *
 * Pure functions: no fs, no env, no ledger access.
 */

/** Known file extensions accepted by cases (a)–(c) (§4.7 step 6c). */
export const EXTENSIONS: readonly string[] = [
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.toml', '.md', '.txt', '.ipynb',
  '.rs', '.go', '.java', '.kt', '.rb', '.php', '.cs', '.swift', '.dart', '.ex', '.exs', '.sh', '.css', '.scss',
  '.html', '.sql', '.env', '.lock', '.cfg', '.ini', '.csv', '.proto', '.graphql', '.tf', '.mk', '.cmake',
  '.gradle', '.xml', '.plist',
];

/** Product names that look like files but never are (§4.7 step 6c). */
const PRODUCT_STOPLIST = new Set([
  'node.js', 'next.js', 'vue.js', 'nuxt.js', 'three.js', 'd3.js', 'socket.io', 'express.js', '.net', 'asp.net',
]);

/** Known top directories that anchor a bare slash token (case b). */
const TOP_DIR_RE =
  /^(?:src|lib|app|apps|packages|tests?|spec|docs?|scripts?|bin|config|configs|examples|fixtures|evidence|benchmarks|tools|cmd|pkg|internal|public|assets|migrations|notebooks|data|outputs|\.github|\.claude|\.codex|\.vscode)$/;

/** English either/or alternation words: `doc/code`, `pass/fail` are prose, not paths. */
const ALTERNATION_WORDS = new Set([
  'and', 'or', 'yes', 'no', 'on', 'off', 'pass', 'fail', 'read', 'write', 'input', 'output', 'client', 'server',
  'either', 'both', 'true', 'false', 'doc', 'docs', 'code', 'test', 'tests', 'prod', 'dev', 'old', 'new',
  'before', 'after',
]);

/** Characters that disqualify a bare token outright. */
const BAD_CHARS_RE = /[+,<>()%=|]/;

/** A PATH token found in a clause. */
export interface PathToken {
  /** The token as it appeared (backticks stripped). */
  token: string;
  /** Display form: backticks stripped, leading `./` removed, `\` → `/`. */
  display: string;
  /** Start offset in the clause (of the backtick or first token char). */
  start: number;
  /** End offset in the clause (past the closing backtick or last token char). */
  end: number;
  /** True when the token was backticked (case a). */
  backticked: boolean;
}

/** True when `token` ends in one of the known extensions. */
function hasKnownExtension(token: string): boolean {
  const lower = token.toLowerCase().replace(/\/+$/, '');
  return EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/** True for `v2.1.214`, `2.1`, `1.2.3-rc.1` and similar version/decimal shapes. */
function isVersionLike(token: string): boolean {
  return /^v?\d+(?:\.\d+)+[\w.-]*$/i.test(token) || /^\d+(?:\.\d+)?$/.test(token);
}

/** Normalises a token to its display form. */
function toDisplay(token: string): string {
  let t = token.replace(/\\/g, '/');
  if (t.startsWith('./')) t = t.slice(2);
  return t;
}

/** Case (a): is this backticked content a PATH? Returns the display or null. */
function backtickedPath(content: string): string | null {
  if (content === '' || /[\s<>=$]/.test(content)) return null;
  if (PRODUCT_STOPLIST.has(content.toLowerCase())) return null;
  if (/:\/\//.test(content)) return null;
  if (content.includes('/') || content.endsWith('/') || hasKnownExtension(content)) return toDisplay(content);
  if (content.includes('\\') && hasKnownExtension(content)) return toDisplay(content);
  return null;
}

/** Cases (b)–(d): is this bare token a PATH? Returns the display or null. */
function barePath(token: string, ledgerPaths: readonly string[]): string | null {
  if (token === '' || /\s/.test(token) || /:\/\//.test(token)) return null;
  if (BAD_CHARS_RE.test(token) || token.startsWith('U+')) return null;
  const lower = token.toLowerCase();
  if (PRODUCT_STOPLIST.has(lower) || isVersionLike(token)) return null;
  const slashed = token.replace(/\\/g, '/');
  if (slashed.includes('/')) {
    // (b) bare token containing `/`.
    const segments = slashed.replace(/\/+$/, '').split('/');
    const anchored =
      /^(?:\/|\.\/|\.\.\/|~\/)/.test(slashed) ||
      TOP_DIR_RE.test(segments[0] ?? '') ||
      ledgerPaths.includes(slashed) ||
      ledgerPaths.some((p) => p.startsWith(`${slashed}/`) || p.includes(`/${slashed}/`));
    const ok = hasKnownExtension(slashed) || anchored;
    if (!ok) return null;
    for (const seg of segments) {
      if (seg === '' || seg === '~' || seg === '.' || seg === '..') continue;
      if (/^\d+$/.test(seg) || isVersionLike(seg) || seg.length <= 2) return null;
    }
    if (segments.length === 2 && !hasKnownExtension(slashed) && !slashed.endsWith('/')) {
      const [a, b] = [segments[0] ?? '', segments[1] ?? ''];
      if (ALTERNATION_WORDS.has(a.toLowerCase()) && ALTERNATION_WORDS.has(b.toLowerCase())) return null;
    }
    return toDisplay(token);
  }
  // (c) bare token with a known extension.
  if (hasKnownExtension(token)) {
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(token) && !/[/\\]/.test(token) && /^\d/.test(token)) return null;
    return toDisplay(token);
  }
  // (d) bare basename of a ledger path.
  if (ledgerPaths.some((p) => p === token || p.endsWith(`/${token}`))) return toDisplay(token);
  return null;
}

/** Strips wrapping punctuation from a bare token (`(x.py),` → `x.py`). */
function trimToken(word: string): { core: string; lead: number } {
  const m = /^["'([{]*/.exec(word);
  const lead = m ? m[0].length : 0;
  const core = word.slice(lead).replace(/["'’)\]}.,;:!?]+$/, '');
  return { core, lead };
}

/**
 * Finds every PATH token in a clause, in order (§4.7 step 6). Backticked
 * spans are examined first (case a); the text outside backticks is tokenised
 * on whitespace for cases (b)–(d). One claim per PATH sharing a verb is the
 * caller's job — this only locates the tokens.
 */
export function findPaths(clause: string, ledgerPaths: readonly string[] = []): PathToken[] {
  const out: PathToken[] = [];
  const outside: { text: string; offset: number }[] = [];
  let last = 0;
  for (const m of clause.matchAll(/`([^`]*)`/g)) {
    const at = m.index ?? 0;
    outside.push({ text: clause.slice(last, at), offset: last });
    last = at + m[0].length;
    const content = m[1] ?? '';
    // Case (a); a backticked bare token can still match a ledger basename (d).
    const display = backtickedPath(content) ?? (/[\s<>=$]/.test(content) ? null : barePath(content, ledgerPaths));
    if (display !== null) out.push({ token: content, display, start: at, end: last, backticked: true });
  }
  outside.push({ text: clause.slice(last), offset: last });
  for (const part of outside) {
    for (const w of part.text.matchAll(/\S+/g)) {
      const { core, lead } = trimToken(w[0]);
      if (core === '') continue;
      // A possessive `x.py's` keeps its stem.
      const stem = core.replace(/'s$/, '');
      const display = barePath(stem, ledgerPaths);
      if (display === null) continue;
      const start = part.offset + (w.index ?? 0) + lead;
      out.push({ token: stem, display, start, end: start + stem.length, backticked: false });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Resolution outcome for a claimed path against the ledger (§4.7 step 6). */
export interface SubjectResolution {
  /** The resolved canonical ledger path, when resolution succeeded. */
  canon?: string;
  status: 'exact' | 'relative' | 'basename' | 'ambiguous' | 'unresolved';
  /** Every candidate ledger path (≥ 2 for `ambiguous`, else 0 or 1). */
  candidates: string[];
}

/**
 * Resolves a claimed subject token against the ledger's known paths:
 * exact canon → relative to `cwd` → unique basename → several (`ambiguous`)
 * → `unresolved` (§4.7 step 6).
 */
export function resolveSubject(token: string, ledgerPaths: readonly string[], cwd: string): SubjectResolution {
  const clean = toDisplay(token).replace(/\/+$/, '');
  if (ledgerPaths.includes(clean)) return { canon: clean, status: 'exact', candidates: [clean] };
  const base = cwd.replace(/\/+$/, '');
  const rel = `${base}/${clean.replace(/^\.\//, '')}`;
  if (ledgerPaths.includes(rel)) return { canon: rel, status: 'relative', candidates: [rel] };
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const candidates = ledgerPaths.filter((p) => p === name || p.endsWith(`/${name}`));
  if (candidates.length === 1) return { canon: candidates[0] as string, status: 'basename', candidates };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  return { status: 'unresolved', candidates: [] };
}
