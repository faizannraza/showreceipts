// Sentence splitter shared by the fixture redactor (ARCHITECTURE §4.7 step 2).
//
// Rules: split on newlines, and on a run of `.!?` (plus any closing quotes or
// brackets that follow it) that is followed by whitespace or the end of the
// line — but not inside backticks and not after the abbreviations `e.g.`,
// `i.e.`, `etc.`, `vs.`, `v.`. Decimals and file extensions never split because
// their dot is not followed by whitespace. This is the only sentence splitter
// under `scripts/`; `src/claims/text.ts` (S15) must reproduce `splitSentences`
// exactly, and S15 asserts the equivalence over the fixture corpus.

const TERMINATORS = '.!?';
const CLOSERS = '"\'’”)]';
const ABBREV_RE = /(?:^|[\s(\[])(?:e\.g|i\.e|etc|vs|v)$/i;

/**
 * Segments one line into `{ text, sep }` pieces whose concatenation
 * (`text + sep` for each, in order) reproduces the line byte for byte.
 * `text` is the sentence including any leading whitespace and its terminal
 * punctuation; `sep` is the whitespace that followed it.
 * @param {string} line
 * @returns {{ text: string, sep: string }[]}
 */
export function segmentLine(line) {
  const segments = [];
  const n = line.length;
  let start = 0;
  let inTick = false;
  let i = 0;
  while (i < n) {
    const c = line[i];
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
    while (j < n && TERMINATORS.includes(line[j])) j++;
    let k = j;
    while (k < n && CLOSERS.includes(line[k])) k++;
    if (k < n && !/\s/.test(line[k])) {
      i = k;
      continue;
    }
    if (c === '.' && j - i === 1 && ABBREV_RE.test(line.slice(start, i))) {
      i = k;
      continue;
    }
    let m = k;
    while (m < n && /\s/.test(line[m])) m++;
    segments.push({ text: line.slice(start, k), sep: line.slice(k, m) });
    start = m;
    i = m;
  }
  if (start < n) segments.push({ text: line.slice(start), sep: '' });
  return segments;
}

/**
 * Splits text into trimmed, non-empty sentences (newlines always split).
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const out = [];
  for (const line of text.split('\n')) {
    for (const seg of segmentLine(line)) {
      const t = seg.text.trim();
      if (t !== '') out.push(t);
    }
  }
  return out;
}
