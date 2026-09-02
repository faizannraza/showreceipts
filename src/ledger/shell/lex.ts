/**
 * Shell lexer (§4.5.1): a character state machine — unquoted / `'…'` / `"…"`
 * (`\"` honoured) / `$'…'` / backtick / `$(…)` nesting / `(…)` subshell /
 * heredocs (`<<`, `<<-`, optional quoted TAG, both redirect orders),
 * byte-counted and never tokenised. Operators only unquoted at word
 * boundaries; `->`/`=>` never redirect. Never throws. `tokenize` (assembled
 * in `index.ts` from this lexer + `segments.ts`) is re-exported here.
 */
import type { RawCommand, RawGroup, RawHeredoc, RawItem, RawLex, RawRedirect, Sep, Word } from './segments.js';

export { tokenize } from './index.js';
export type { ShellParse } from './segments.js';

/** A quote/substitution context; `buf` captures raw content, `open` is the opener for reconstruction, `group` marks a command-position `(…)`. */
interface Frame { kind: 'sq' | 'dq' | 'dsq' | 'bt' | 'cs' | 'ps'; buf: string; open: string; parens: number; group: boolean }

/** A `<<TAG` awaiting its body; `record:false` when opened inside a capture (the descent re-lex records it). */
interface PendingHeredoc { delimiter: string; strip: boolean; record: boolean }

const GLOB_RE = /[*?[]/;
/** Characters that end a fast run of plain word characters at top level. */
const SPECIAL = " \t\n\\#'\"`$;&|()<>";

const newWord = (): Word => ({ text: '', scan: '', quoted: false, dollar: false, subst: false, glob: false, substBodies: [] });

/** Lexes one raw command string into items, redirects and heredocs. Never throws. */
export function lexRaw(raw: string): RawLex {
  const items: RawItem[] = [];
  const notes: string[] = [];
  const frames: Frame[] = [];
  const hdQueue: PendingHeredoc[] = [];
  let words: Word[] = [];
  let redirects: RawRedirect[] = [];
  let heredocs: RawHeredoc[] = [];
  let group: RawGroup | null = null;
  let w: Word | null = null;
  let pending: { op: string; fd?: number } | null = null;
  let boundary = true;
  const note = (t: string): void => void (notes.includes(t) || notes.push(t));
  const capture = (): Frame | null => {
    for (let f = frames.length - 1; f >= 0; f -= 1) {
      const fr = frames[f] as Frame;
      if (fr.kind === 'bt' || fr.kind === 'cs' || fr.kind === 'ps') return fr;
    }
    return null;
  };
  const cap = (s: string): void => void ((capture() ?? { buf: '' }).buf += s);
  const word = (): Word => (w ??= newWord());
  const getw = (): Word | null => w; // via a function boundary so TS keeps the declared union
  const openFrame = (kind: Frame['kind'], open: string, parens = 0, isGroup = false): void =>
    void frames.push({ kind, buf: '', open, parens, group: isGroup });
  const flushWord = (): void => {
    if (w === null) return;
    const done = w;
    w = null;
    if (pending === null) return void words.push(done);
    if (pending.op !== '<<<') {
      const r: RawRedirect = { op: pending.op, target: done };
      if (pending.fd !== undefined) r.fd = pending.fd;
      (group !== null ? group.redirects : redirects).push(r);
    }
    pending = null;
  };
  const endCommand = (sep: Sep): void => {
    flushWord();
    if (pending !== null) note('missing-redirect-target');
    pending = null;
    if (group !== null) {
      group.sep = sep;
      items.push(group);
      group = null;
    } else if (words.length > 0 || redirects.length > 0 || heredocs.length > 0) {
      items.push({ kind: 'cmd', words, redirects, heredocs, sep } satisfies RawCommand);
    }
    [words, redirects, heredocs] = [[], [], []];
    boundary = true;
  };
  /** Consumes queued heredoc bodies starting at `start` (just past a newline). */
  const consumeHeredocs = (start: number): number => {
    let i = start;
    while (hdQueue.length > 0) {
      const hd = hdQueue.shift() as PendingHeredoc;
      let [bytes, closed] = [0, false];
      while (i <= raw.length) {
        const at = raw.indexOf('\n', i);
        const nl = at === -1 ? raw.length : at;
        const line = raw.slice(i, nl);
        cap(raw.slice(i, Math.min(nl + 1, raw.length)));
        i = nl + 1;
        if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delimiter) {
          closed = true;
          break;
        }
        bytes += line.length + 1;
        if (nl === raw.length) break;
      }
      if (!closed) note('unterminated-heredoc');
      if (hd.record) heredocs.push({ delimiter: hd.delimiter, bytes } satisfies RawHeredoc);
    }
    return i;
  };
  /** Parses `<<`/`<<-` TAG at `start` (just past the `<<`); returns the index after the tag. */
  const heredocTag = (start: number): number => {
    let i = start;
    const strip = raw[i] === '-';
    if (strip) i += 1;
    while (raw[i] === ' ' || raw[i] === '\t') i += 1;
    let delimiter = '';
    const q = raw[i];
    if (q === "'" || q === '"') {
      const close = raw.indexOf(q, i + 1);
      delimiter = raw.slice(i + 1, close === -1 ? raw.length : close);
      i = close === -1 ? raw.length : close + 1;
    } else {
      for (; i < raw.length && !/[\s;|&<>()]/.test(raw[i] as string); i += 1) if (raw[i] !== '\\') delimiter += raw[i] as string;
    }
    hdQueue.push({ delimiter, strip, record: frames.length === 0 });
    return i;
  };
  const popCapture = (): void => {
    const fr = frames.pop() as Frame;
    const close = fr.kind === 'bt' ? '`' : ')';
    if (fr.kind === 'ps' && fr.group) {
      group = { kind: 'group', body: fr.buf, redirects: [], sep: null } satisfies RawGroup;
      boundary = true;
      return;
    }
    const parent = capture();
    if (parent !== null) parent.buf += fr.open + fr.buf + close;
    else {
      word().text += fr.open + fr.buf + close;
      word().subst = true;
      word().substBodies.push(fr.buf);
    }
  };

  let i = 0;
  while (i < raw.length) {
    const c = raw[i] as string;
    const top = frames[frames.length - 1];
    if (top !== undefined && (top.kind === 'sq' || top.kind === 'dsq')) {
      let j = i;
      while (j < raw.length && raw[j] !== "'" && !(top.kind === 'dsq' && raw[j] === '\\')) j += 1;
      if (j > i) {
        const run = raw.slice(i, j);
        if (capture() === null) word().text += run;
        cap(run);
        i = j;
        continue;
      }
      if (c === "'" && !(top.kind === 'dsq' && raw[i - 1] === '\\')) frames.pop();
      else if (capture() === null) word().text += c;
      cap(c);
      i += 1;
      continue;
    }
    if (top !== undefined && top.kind === 'dq') {
      let j = i;
      while (j < raw.length && !'"$`\\'.includes(raw[j] as string)) j += 1;
      if (j > i) {
        const run = raw.slice(i, j);
        if (capture() !== null) cap(run);
        else word().text += run;
        i = j;
        continue;
      }
      if (c === '\\' && i + 1 < raw.length && '"$`\\'.includes(raw[i + 1] as string)) {
        if (capture() !== null) cap(c + (raw[i + 1] as string));
        else word().text += raw[i + 1] as string;
        i += 2;
        continue;
      }
      if (c === '"') {
        frames.pop();
        cap('"');
      } else if (c === '$' && raw[i + 1] === '(') {
        openFrame('cs', '$(', 1);
        i += 1;
      } else if (c === '`') openFrame('bt', '`');
      else if (capture() !== null) cap(c);
      else {
        word().text += c;
        if (c === '$') word().dollar = true;
      }
      i += 1;
      continue;
    }
    if (top !== undefined && top.kind === 'bt') {
      if (c === '\\' && i + 1 < raw.length) top.buf += raw[(i += 1)] as string;
      else if (c === '`') popCapture();
      else top.buf += c;
      i += 1;
      continue;
    }
    if (top !== undefined) {
      // `cs` / `ps` capture: unquoted-like, but only accumulating raw text.
      if (c === "'" || c === '"') {
        openFrame(c === "'" ? 'sq' : 'dq', c);
        top.buf += c;
      } else if (c === '$' && raw[i + 1] === '(') {
        openFrame('cs', '$(', 1);
        i += 1;
      } else if (c === '`') openFrame('bt', '`');
      else if (c === '(') {
        top.parens += 1;
        top.buf += c;
      } else if (c === ')') {
        top.parens -= 1;
        if (top.parens === 0) popCapture();
        else top.buf += c;
      } else if (c === '<' && raw[i + 1] === '<' && raw[i + 2] !== '<') {
        top.buf += '<<';
        const after = heredocTag(i + 2);
        top.buf += raw.slice(i + 2, after);
        i = after;
        continue;
      } else if (c === '\n') {
        top.buf += c;
        i = consumeHeredocs(i + 1);
        continue;
      } else if (c === '\\' && i + 1 < raw.length) top.buf += c + (raw[(i += 1)] as string);
      else top.buf += c;
      i += 1;
      continue;
    }
    // --- top-level unquoted state ------------------------------------------
    const atB = boundary;
    boundary = false;
    if (c === ' ' || c === '\t') {
      flushWord();
      boundary = true;
    } else if (c === '\n') {
      i += 1;
      if (hdQueue.length > 0) i = consumeHeredocs(i);
      endCommand('\n');
      continue;
    } else if (c === '\\') {
      const next = raw[i + 1];
      if (next !== undefined && next !== '\n') {
        word().text += next;
        word().scan += next;
      }
      i += 2;
      continue;
    } else if (c === '#' && atB && w === null) {
      const nl = raw.indexOf('\n', i);
      i = nl === -1 ? raw.length : nl;
      continue;
    } else if (c === "'" || c === '"') {
      word().quoted = true;
      openFrame(c === "'" ? 'sq' : 'dq', c);
    } else if (c === '`') {
      word();
      openFrame('bt', '`');
    } else if (c === '$' && (raw[i + 1] === "'" || raw[i + 1] === '(')) {
      const q = raw[i + 1] === "'";
      if (q) word().quoted = true;
      else word();
      openFrame(q ? 'dsq' : 'cs', q ? "$'" : '$(', q ? 0 : 1);
      i += 1;
    } else if (c === '$') {
      word().text += '$';
      word().scan += '$';
      word().dollar = true;
    } else if (c === ';') {
      endCommand(';');
      if (raw[i + 1] === ';') i += 1;
    } else if (c === '&' && raw[i + 1] === '&') {
      endCommand('&&');
      i += 1;
    } else if (c === '&' && raw[i + 1] === '>') {
      flushWord();
      pending = { op: raw[i + 2] === '>' ? '&>>' : '&>' };
      i += raw[i + 2] === '>' ? 2 : 1;
      boundary = true;
    } else if (c === '&') {
      endCommand('&');
    } else if (c === '|') {
      endCommand(raw[i + 1] === '|' ? '||' : '|');
      if (raw[i + 1] === '|' || raw[i + 1] === '&') i += 1;
    } else if (c === '(' && w === null && pending === null && group === null && (words.length === 0 ? redirects.length === 0 : ['do', 'then', 'else', '{', '!'].includes((words[words.length - 1] as Word).text))) {
      openFrame('ps', '(', 1, true); // command position: start of command, or after a reserved word
    } else if ((c === '>' || c === '<') && raw[i + 1] === '(') {
      word().subst = true;
      openFrame('ps', `${c}(`, 1);
      i += 1;
    } else if (c === '>' && /[-=]$/.test(getw()?.text ?? '')) {
      const cw = word();
      cw.text += '>'; // `->` / `=>` are never redirects
      cw.scan += '>';
    } else if (c === '<' && raw[i + 1] === '<' && raw[i + 2] === '<') {
      flushWord();
      pending = { op: '<<<' };
      i += 2;
      boundary = true;
    } else if (c === '<' && raw[i + 1] === '<') {
      const cw = getw();
      if (cw !== null && /^\d+$/.test(cw.text) && cw.text === cw.scan) w = null;
      else flushWord();
      i = heredocTag(i + 2);
      boundary = true;
      continue;
    } else if (c === '>' || c === '<') {
      let fd: number | undefined;
      const cw = getw();
      if (cw !== null && /^\d+$/.test(cw.text) && cw.text === cw.scan) {
        fd = Number(cw.text);
        w = null;
      } else flushWord();
      if (c === '>' && raw[i + 1] === '&' && /\d/.test(raw[i + 2] ?? '')) {
        i += 2;
        while (/\d/.test(raw[i] ?? '')) i += 1;
        continue; // fd dup (`2>&1`, `>&2`): no file
      }
      let op: string = c;
      if (c === '>' && (raw[i + 1] === '>' || raw[i + 1] === '|')) {
        op = raw[i + 1] === '>' ? '>>' : '>|';
        i += 1;
      } else if (c === '>' && raw[i + 1] === '&') {
        op = '&>';
        i += 1;
      }
      pending = fd === undefined ? { op } : { op, fd };
      boundary = true;
    } else {
      let j = i + 1;
      while (j < raw.length && !SPECIAL.includes(raw[j] as string)) j += 1;
      const run = raw.slice(i, j);
      const cw = word();
      cw.text += run;
      cw.scan += run;
      if (GLOB_RE.test(run)) cw.glob = true;
      i = j;
      continue;
    }
    i += 1;
  }
  while (frames.length > 0) {
    const quote = ['sq', 'dq', 'dsq'].includes((frames[frames.length - 1] as Frame).kind);
    note(quote ? 'unbalanced-quote' : 'unclosed-substitution');
    if (quote) frames.pop();
    else popCapture();
  }
  const tail = getw();
  if (tail !== null && tail.text === '' && !tail.quoted && !tail.subst) w = null;
  if (hdQueue.length > 0) note('unterminated-heredoc');
  hdQueue.length = 0;
  endCommand(null);
  return { items, notes };
}
