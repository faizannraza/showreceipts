/**
 * Renderer glyph sets and the unicode/ASCII frame decision (§10.1).
 *
 * The ASCII substitutions apply ONLY to renderer-emitted text (glyphs, box
 * characters, separators, arrows and the fragments the renderer or the
 * pipeline composed, such as evidence labels and ALSO DID texts). Transcript
 * -derived text (claims, model ids, paths, branches) is sanitised but never
 * transliterated — the callers in `term.ts` pick which fragments go through
 * `transliterate`.
 */

/** The eight box-drawing characters of the receipt frame. */
export interface BoxChars {
  /** Top-left corner. */
  tl: string;
  /** Top-right corner. */
  tr: string;
  /** Bottom-left corner. */
  bl: string;
  /** Bottom-right corner. */
  br: string;
  /** Horizontal rule character. */
  h: string;
  /** Vertical border character. */
  v: string;
  /** Left T-junction of an inner rule. */
  lt: string;
  /** Right T-junction of an inner rule. */
  rt: string;
}

/** One coherent set of renderer glyphs (§10.1 "Glyphs"). */
export interface GlyphSet {
  /** Whether this is the unicode set. */
  unicode: boolean;
  /** Verified claim (`✓` / `+`). */
  ok: string;
  /** Contradicted claim (`✗` / `x`). */
  bad: string;
  /** Unverified claim (`?`). */
  unk: string;
  /** ALSO SAID prefix (`~`). */
  said: string;
  /** ALSO DID prefix (`·` / `-`). */
  did: string;
  /** Warning prefix (`!`). */
  warn: string;
  /** The separator glyph of ` · ` lists (`·` / `-`). */
  sepGlyph: string;
  /** Arrow (`→` / `->`). */
  arrow: string;
  /** Multiplication sign (`×` / `x`). */
  times: string;
  /** Approximation sign (`≈` / `~`). */
  approx: string;
  /** Ellipsis (`…` / `...`; budgets use its real display width). */
  ellipsis: string;
  /** En dash (`–` / `-`). */
  enDash: string;
  /** Em dash (`—` / `--`). */
  emDash: string;
  box: BoxChars;
}

const UNICODE_SET: GlyphSet = {
  unicode: true,
  ok: '✓',
  bad: '✗',
  unk: '?',
  said: '~',
  did: '·',
  warn: '!',
  sepGlyph: '·',
  arrow: '→',
  times: '×',
  approx: '≈',
  ellipsis: '…',
  enDash: '–',
  emDash: '—',
  box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', lt: '├', rt: '┤' },
};

const ASCII_SET: GlyphSet = {
  unicode: false,
  ok: '+',
  bad: 'x',
  unk: '?',
  said: '~',
  did: '-',
  warn: '!',
  sepGlyph: '-',
  arrow: '->',
  times: 'x',
  approx: '~',
  ellipsis: '...',
  enDash: '-',
  emDash: '--',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', lt: '+', rt: '+' },
};

/** The glyph set for a frame mode. */
export function glyphSet(unicode: boolean): GlyphSet {
  return unicode ? UNICODE_SET : ASCII_SET;
}

/**
 * The §10.1 ASCII substitutions for renderer-emitted characters:
 * `…`→`...`, ` · `→` - `, `→`→`->`, `×`→`x`, `≈`→`~`, `–`→`-`, `—`→`--`.
 * Apply BEFORE measuring/wrapping (the substitutes are wider), and never to
 * transcript-derived text.
 */
export function transliterate(s: string): string {
  return s
    .replace(/…/g, '...')
    .replace(/ · /g, ' - ')
    .replace(/→/g, '->')
    .replace(/×/g, 'x')
    .replace(/≈/g, '~')
    .replace(/–/g, '-')
    .replace(/—/g, '--');
}

/** Environment slice the unicode decision reads (values passed in; render code never touches `process.env`). */
export interface UnicodeEnv {
  LC_ALL?: string | undefined;
  LC_CTYPE?: string | undefined;
  LANG?: string | undefined;
  TERM?: string | undefined;
  WT_SESSION?: string | undefined;
  TERM_PROGRAM?: string | undefined;
  ConEmuANSI?: string | undefined;
}

/** Inputs of {@link decideUnicode}. */
export interface UnicodeInputs {
  /** `--ascii` was passed (always wins: ASCII frame). */
  ascii?: boolean | undefined;
  /** `--unicode` was passed. */
  unicode?: boolean | undefined;
  /** `process.platform` of the caller. */
  platform: string;
  env: UnicodeEnv;
}

/**
 * The §10.1 unicode rule: `locale = LC_ALL || LC_CTYPE || LANG`;
 * `unicode = !--ascii && (--unicode || (win32 ? (WT_SESSION || TERM_PROGRAM
 * || ConEmuANSI) : TERM !== 'linux' && (!locale || /utf-?8/i.test(locale))))
 * && !/^(zh|ja|ko)/i.test(locale)` — CJK locales always get the ASCII frame
 * so ambiguous-width glyphs are never emitted, even under `--unicode`.
 */
export function decideUnicode(inputs: UnicodeInputs): boolean {
  if (inputs.ascii === true) return false;
  const env = inputs.env;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/^(zh|ja|ko)/i.test(locale)) return false;
  if (inputs.unicode === true) return true;
  if (inputs.platform === 'win32') {
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI);
  }
  return env.TERM !== 'linux' && (locale === '' || /utf-?8/i.test(locale));
}
