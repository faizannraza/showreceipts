/**
 * Text normalisation, sentence and clause splitting for the claims pipeline
 * (ARCHITECTURE §4.7 steps 1–3; §2 names this module `normalize.ts`).
 *
 * `sentences()` reproduces `scripts/lib/sentences.mjs` exactly (S15 asserts the
 * equivalence over the corpus); `analyse()` runs the full pipeline — fence and
 * comment stripping, character normalisation, emphasis/bullet/heading/table
 * handling, section scoping, lead-in lists, clause splitting, tool-list
 * expansion; `echoHashes()` feeds `Turn.echoHashes` (§4.7 step 7).
 *
 * Pure functions: no fs, no env, no wall clock.
 */
import { sha1 } from '../util/hash.js';

const TERMINATORS = '.!?';
const CLOSERS = '"\'’”)]';
const ABBREV_RE = /(?:^|[\s([])(?:e\.g|i\.e|etc|vs|v)$/i;

interface LineSegment {
  text: string;
  sep: string;
}

/**
 * Segments one line into sentence pieces; concatenating `text + sep` for each
 * piece reproduces the line byte for byte. Exact port of
 * `scripts/lib/sentences.mjs` `segmentLine` (S03).
 */
function segmentLine(line: string): LineSegment[] {
  const segments: LineSegment[] = [];
  const n = line.length;
  let start = 0;
  let inTick = false;
  let i = 0;
  while (i < n) {
    const c = line[i] as string;
    if (c === '`') {
      inTick = !inTick;
      i++;
      continue;
    }
    if (inTick || !TERMINATORS.includes(c)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && TERMINATORS.includes(line[j] as string)) j++;
    let k = j;
    while (k < n && CLOSERS.includes(line[k] as string)) k++;
    if (k < n && !/\s/.test(line[k] as string)) {
      i = k;
      continue;
    }
    if (c === '.' && j - i === 1 && ABBREV_RE.test(line.slice(start, i))) {
      i = k;
      continue;
    }
    let m = k;
    while (m < n && /\s/.test(line[m] as string)) m++;
    segments.push({ text: line.slice(start, k), sep: line.slice(k, m) });
    start = m;
    i = m;
  }
  if (start < n) segments.push({ text: line.slice(start), sep: '' });
  return segments;
}

/**
 * Splits text into trimmed, non-empty sentences (newlines always split; `.!?`
 * runs split unless inside backticks or after `e.g. i.e. etc. vs. v.`).
 * Byte-for-byte compatible with `scripts/lib/sentences.mjs` `splitSentences`.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const seg of segmentLine(line)) {
      const t = seg.text.trim();
      if (t !== '') out.push(t);
    }
  }
  return out;
}

/**
 * Replaces backtick spans with spaces of the same length. With
 * `onlyWhitespaceSpans`, spans without whitespace stay visible (the §4.7
 * step 4 opacity rule: code spans containing whitespace are opaque to most
 * rules; only `command.ran`-style rules read them).
 */
export function blankBackticks(text: string, onlyWhitespaceSpans = false): string {
  return text.replace(/`[^`]*`/g, (m) => (onlyWhitespaceSpans && !/\s/.test(m) ? m : ' '.repeat(m.length)));
}

/** §4.7 step 1 character normalisation (NFKC, quotes, dashes, spaces). */
function normalizeChars(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s–\s/g, ' — ')
    .replace(/[‐-–]/g, '-')
    .replace(/[  ]/g, ' ')
    .replace(/…/g, '...');
}

/** Strips emphasis and collapses space runs outside backticks (`_` kept). */
function stripEmphasis(line: string): string {
  const clean = (s: string): string => s.replace(/\*{1,3}|__/g, '').replace(/ {2,}/g, ' ');
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/`[^`]*`/g)) {
    const at = m.index ?? 0;
    out += clean(line.slice(last, at));
    out += m[0];
    last = at + m[0].length;
  }
  out += clean(line.slice(last));
  return out;
}

/** Removes fenced code blocks (line-based; an unclosed fence eats the rest). */
function stripFences(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const open = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      if (open !== null && open[1] === fence) fence = null;
      continue;
    }
    if (open !== null) {
      fence = open[1] as string;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Section headings / bold lead-ins that defer everything under them (§4.7 step 5). */
const DEFER_SECTION_RE =
  /next\s+steps?|your\s+(?:move|part|commands?|turn|call)|then\b|to\s*-?do|remaining|optional|roadmap|deliberately\s+not|not\s+done|only\s+you\s+can|before\s+you\s+(?:send|push|post|commit)|what.s\s+(?:left|still)|try\s+it\s+yourself/i;

/** Lead-in list verbs (§4.7 step 2): following bullets inherit the verb. */
const LEADIN_FILE_RE = /\b(created|generated|added|updated|written|wrote|new\s+files?|outputs?|artifacts?)\b/i;
const LEADIN_GENERIC_RE = /\b(verified|confirmed|checked|fixed)\s*:\s*$/i;

/** Maps a lead-in match to the verb word bullets inherit. */
function leadVerbFor(word: string): string {
  const w = word.toLowerCase();
  if (w === 'updated') return 'updated';
  if (w === 'added') return 'added';
  if (w === 'wrote' || w === 'written') return 'wrote';
  if (w === 'verified' || w === 'confirmed' || w === 'checked' || w === 'fixed') return w;
  return 'created';
}

/** One clause, ready for rule matching (§4.7 steps 3–5 metadata). */
export interface AnalysedClause {
  /** Global clause index across the message — `Claim.position`. */
  index: number;
  /** The normalised sentence this clause came from. */
  sentence: string;
  /** The normalised clause text (markers kept, backticks kept). */
  clause: string;
  /** The sentence ends in `?` — questions yield no claims. */
  question: boolean;
  /** Clause sits under a deferring section heading or bold lead-in. */
  deferredScope: boolean;
  /** Head of an `except …` split (§4.7 step 3) — `Claim.partial`. */
  partial: boolean;
  /** First clause of its sentence (imperative detection needs the start). */
  sentenceStart: boolean;
}

/** Result of `analyse`: the clause stream plus the sentence count for stats. */
export interface Analysis {
  clauses: AnalysedClause[];
  sentenceCount: number;
}

// Single leading `\s` so a blanked backtick span is never swallowed into the separator.
const SPLITTER_RE = /,\s+but\s+|;\s*|:\s+|\s—\s+|\s--\s+|\sbut\s+|,?\showever[,\s]\s*|,\s+while\s+|\swhile\s+/g;
const EXCEPT_RE = /\s+(?:except|apart\s+from|other\s+than|aside\s+from)(?![\p{L}\p{N}_])|\(\s*except(?![\p{L}\p{N}_])/iu;

/** Splits one sentence into clause strings with `partial` marking (§4.7 step 3). */
function clausesOf(sentence: string, keepColon = false): { text: string; partial: boolean }[] {
  const masked = blankBackticks(sentence);
  const ex = EXCEPT_RE.exec(masked);
  const parts: { text: string; partial: boolean }[] = [];
  const pieces: { text: string; masked: string; partial: boolean }[] = [];
  if (ex !== null) {
    pieces.push({ text: sentence.slice(0, ex.index), masked: masked.slice(0, ex.index), partial: true });
    pieces.push({ text: sentence.slice(ex.index), masked: masked.slice(ex.index), partial: false });
  } else {
    pieces.push({ text: sentence, masked, partial: false });
  }
  for (const piece of pieces) {
    let last = 0;
    SPLITTER_RE.lastIndex = 0;
    for (const m of piece.masked.matchAll(SPLITTER_RE)) {
      const at = m.index ?? 0;
      // A colon directly introducing a code span or status marker binds:
      // `New file: `x.ts``, `Tests: ✅ 41 passed`; 2-cell table rows stay whole.
      if (m[0].startsWith(':') && (keepColon || /^\s*(?:`|✅|✔|✓|☑|🟢|❌|✘|✗|✖|🔴|❗)/u.test(piece.text.slice(at + 1)))) continue;
      const chunk = piece.text.slice(last, at).trim();
      if (chunk !== '') parts.push({ text: chunk, partial: piece.partial });
      last = at + m[0].length;
    }
    const tail = piece.text.slice(last).trim();
    if (tail !== '') parts.push({ text: tail, partial: piece.partial });
  }
  return parts;
}

/** Tool names that participate in slash/plus/comma/and list expansion. */
const TOOL_WORDS = new Set([
  'ruff', 'eslint', 'flake8', 'pylint', 'clippy', 'golangci-lint', 'biome', 'oxlint', 'rubocop', 'shellcheck',
  'lint', 'linter', 'mypy', 'pyright', 'tsc', 'typecheck', 'typechecks', 'prettier', 'black', 'isort', 'gofmt',
  'rustfmt', 'fmt', 'format', 'formatter', 'formatting', 'mkdocs', 'webpack', 'vite', 'build', 'pytest',
  'vitest', 'jest', 'test', 'tests', 'types',
]);

/** True when a list item names a known tool (`mypy --strict`, `mkdocs-strict`). */
function isToolItem(item: string): boolean {
  const first = /^[A-Za-z][\w.-]*/.exec(item.trim());
  if (first === null) return false;
  const base = first[0].toLowerCase();
  return TOOL_WORDS.has(base) || TOOL_WORDS.has(base.split('-')[0] as string);
}

const LIST_SEP_RE = /\s*\/\s*|\s*\+\s*|,\s+|\s+and\s+/;
const CHAIN_RE =
  /((?:`[^`]+`|[A-Za-z][\w.-]*)(?:(?:\s*\/\s*|\s*\+\s*|,\s+|\s+and\s+)(?:`[^`]+`|[A-Za-z][\w.-]*))+)\s+((?:(?:all|both|are|is|were|was|still|now|also)\s+)*(?:clean|green|ok|pass(?:es|ed|ing)?|succeed(?:s|ed)?)(?![\p{L}\p{N}_]))/giu;
const PAREN_RE =
  /\(([^()]{2,160})\)\s*((?:(?:all|both|are|is|were|was|still|now|also)\s+)*(?:passed|pass(?:es|ing)?|green|clean|ok|succeeded))(?![\p{L}\p{N}_])/giu;

/**
 * §4.7 step 3 expansion: a slash/plus/comma/`and` list of tools sharing one
 * predicate, or a parenthesised tool list, yields one extra clause per tool.
 * `validation gate (…)` lines are left to the `test.gate` rule.
 */
function expandToolLists(clause: string): string[] {
  if (/validation\s+gate/i.test(clause)) return [];
  const out: string[] = [];
  for (const m of clause.matchAll(CHAIN_RE)) {
    const items = (m[1] as string).split(LIST_SEP_RE).map((s) => s.replace(/`/g, '').trim()).filter((s) => s !== '');
    // Keep the trailing all-tools run: "green, ruff/mypy clean" expands ruff+mypy.
    let from = items.length;
    while (from > 0 && isToolItem(items[from - 1] as string)) from--;
    const tools = items.slice(from);
    if (tools.length >= 2) for (const item of tools) out.push(`${item} ${m[2] as string}`);
  }
  for (const m of clause.matchAll(PAREN_RE)) {
    const items = (m[1] as string).split(/,\s*/).map((s) => s.replace(/`/g, '').trim()).filter((s) => s !== '');
    if (items.length >= 2 && items.every(isToolItem)) for (const item of items) out.push(`${item} ${m[2] as string}`);
  }
  return out;
}

/** A processed content line, before sentence segmentation. */
interface ContentLine {
  text: string;
  deferred: boolean;
  /** Derived from a table row — the constructed `label: status` stays one clause. */
  table?: boolean;
}

/** Turns raw message text into content lines with scope metadata. */
function contentLines(text: string): ContentLine[] {
  const out: ContentLine[] = [];
  const stripped = stripFences(text).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!--[\s\S]*$/g, ' ');
  let deferLevel: number | null = null;
  let boldDefer = false;
  let leadVerb: string | null = null;
  let prevBlank = true;
  for (const raw of stripped.split('\n')) {
    const line = normalizeChars(raw);
    if (line.trim() === '') {
      prevBlank = true;
      leadVerb = null;
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    const bold = /^\s*\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    const bullet = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] as string).length;
      if (deferLevel !== null && level <= deferLevel) deferLevel = null;
      boldDefer = false;
      leadVerb = null;
      const head = stripEmphasis(heading[2] as string);
      if (DEFER_SECTION_RE.test(head)) deferLevel = level;
      const leadIn = LEADIN_FILE_RE.exec(head);
      if (leadIn !== null) leadVerb = leadVerbFor(leadIn[1] as string);
      out.push({ text: head, deferred: deferLevel !== null });
    } else if (bold !== null && bullet === null) {
      const inner = stripEmphasis(bold[1] as string);
      if (boldDefer && prevBlank) boldDefer = false;
      if (DEFER_SECTION_RE.test(inner)) boldDefer = true;
      const leadIn = LEADIN_FILE_RE.exec(inner);
      leadVerb = leadIn !== null ? leadVerbFor(leadIn[1] as string) : null;
      out.push({ text: inner, deferred: deferLevel !== null || boldDefer });
    } else if (bullet !== null) {
      const item = stripEmphasis(bullet[1] as string);
      out.push({ text: leadVerb !== null ? `${leadVerb} ${item}` : item, deferred: deferLevel !== null || boldDefer });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      leadVerb = null;
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripEmphasis(c).trim()).filter((c) => c !== '');
      if (cells.length > 0 && !cells.every((c) => /^:?-{3,}:?$/.test(c))) {
        const row = cells.length === 2 ? `${cells[0] as string}: ${cells[1] as string}` : cells.join('; ');
        out.push({ text: row, deferred: deferLevel !== null || boldDefer, table: true });
      }
    } else {
      if (boldDefer && prevBlank) boldDefer = false;
      const content = stripEmphasis(line);
      const generic = LEADIN_GENERIC_RE.exec(content);
      const fileLead = /:\s*$/.test(content) ? LEADIN_FILE_RE.exec(content) : null;
      leadVerb = generic !== null ? leadVerbFor(generic[1] as string) : fileLead !== null ? leadVerbFor(fileLead[1] as string) : null;
      out.push({ text: content, deferred: deferLevel !== null || boldDefer });
    }
    prevBlank = false;
  }
  return out;
}

/**
 * Runs §4.7 steps 1–3 over a final message: normalisation, sentence and
 * clause splitting, section scoping, lead-in lists, tool-list expansion.
 */
export function analyse(text: string): Analysis {
  const clauses: AnalysedClause[] = [];
  let sentenceCount = 0;
  let index = 0;
  for (const line of contentLines(text)) {
    for (const seg of segmentLine(line.text)) {
      const sentence = seg.text.trim();
      if (sentence === '') continue;
      sentenceCount++;
      const question = /\?["'’”)\]]*$/.test(sentence);
      let first = true;
      for (const piece of clausesOf(sentence, line.table === true)) {
        clauses.push({
          index: index++,
          sentence,
          clause: piece.text,
          question,
          deferredScope: line.deferred,
          partial: piece.partial,
          sentenceStart: first,
        });
        first = false;
        for (const extra of expandToolLists(piece.text)) {
          clauses.push({
            index: index++,
            sentence,
            clause: extra,
            question,
            deferredScope: line.deferred,
            partial: piece.partial,
            sentenceStart: false,
          });
        }
      }
    }
  }
  return { clauses, sentenceCount };
}

/**
 * §4.7 step 7: sha1 of every normalised sentence and clause of ≥ 25 chars,
 * plus every count (`\d{1,6}`) and sha (`[0-9a-f]{7,40}`) token. S18 runs this
 * over human/skill prompt text to fill `Turn.echoHashes` — the prompt text
 * itself is never cached, only these hashes.
 */
export function echoHashes(text: string): string[] {
  const hashes = new Set<string>();
  const { clauses } = analyse(text);
  for (const c of clauses) {
    const s = c.sentence.trim();
    const cl = c.clause.trim();
    if (s.length >= 25) hashes.add(sha1(s));
    if (cl.length >= 25) hashes.add(sha1(cl));
  }
  const normal = normalizeChars(stripFences(text));
  for (const m of normal.matchAll(/(?<![\w/.])\d{1,6}(?![\w/.])/g)) hashes.add(sha1(m[0]));
  for (const m of normal.matchAll(/\b[0-9a-f]{7,40}\b/g)) hashes.add(sha1(m[0]));
  return [...hashes];
}
