/**
 * Segment building (§4.5.2): splits the raw lex into `ShellSegment`s, strips
 * env-style wrappers, folds runner wrappers into the program (`npx vitest` →
 * `vitest`, `npm run S` → `npm-script:S`), re-tokenises `bash -c` bodies and
 * `(…)` subshells, expands literal `for` loops, descends into `$(…)` /
 * backticks for classification, resolves redirect targets through the
 * literal-variable map and drives the left-to-right cwd walk (`cwd.ts`).
 * The raw lexer is injected (`relex`) so this module never imports `lex.ts`.
 */
import type { ExitSource, ShellSegment } from '../../model/types.js';
import { canon, resolveAgainst } from '../../util/paths.js';
import { applyCd, cloneCwd, isUntrackedDirOp, type CwdState } from './cwd.js';
import { classifySegment } from './families.js';
import { parseAssignment, resolveWord, type WordLike } from './vars.js';

// --- shared lexer types (owned here; `lex.ts` imports them type-only) -------

/** One word as lexed: dequoted text plus the facts substitution and scanning need. */
export interface Word extends WordLike {
  quoted: boolean;
  /** Captured `$(…)` / backtick bodies, for classification descent. */
  substBodies: string[];
}

/** A redirect with a file target (`fd` for `2>`; fd dups like `2>&1` are never emitted). */
export interface RawRedirect {
  op: string;
  fd?: number;
  target: Word;
}

export interface RawHeredoc {
  delimiter: string;
  bytes: number;
}

/** The separator *after* an item (`null` at end of input). */
export type Sep = '&&' | '||' | ';' | '|' | '&' | '\n' | null;

export interface RawCommand {
  kind: 'cmd';
  words: Word[];
  redirects: RawRedirect[];
  heredocs: RawHeredoc[];
  sep: Sep;
}

/** A `(…)` subshell; the body is re-lexed and its segments spliced in. */
export interface RawGroup {
  kind: 'group';
  body: string;
  redirects: RawRedirect[];
  sep: Sep;
}

export type RawItem = RawCommand | RawGroup;

export interface RawLex {
  items: RawItem[];
  notes: string[];
}

/** Chain metadata parallel to `ShellParse.segments`, used by `attributeExit`. */
export interface SegLink {
  sep: Sep;
  /** The segment came from a `$(…)`/backtick descent — excluded from chain attribution. */
  fromSubst: boolean;
  /** Piped into a sink with pipefail off ⇒ exit stays `null`/`'sink'`. */
  sink: boolean;
  /** `set -o pipefail` was active when this segment was built. */
  pipefail: boolean;
}

/** The result of `tokenize` (§4.5.1) — `links` carries the chain structure. */
export interface ShellParse {
  segments: ShellSegment[];
  links: SegLink[];
  chained: boolean;
  background: boolean;
  pipefail: boolean;
  heredocs: { delimiter: string; bytes: number; interpreter?: string }[];
  notes: string[];
  cwdAfter: string;
  resolved: boolean;
}

// --- build context ----------------------------------------------------------

export interface BuildContext {
  state: CwdState;
  vars: Map<string, string>;
  home: string;
  relex: (raw: string) => RawLex;
  segments: ShellSegment[];
  links: SegLink[];
  notes: string[];
  heredocs: { delimiter: string; bytes: number; interpreter?: string }[];
  flags: { pipefail: boolean };
  top: { pipefail: boolean };
  fromSubst: boolean;
  depth: number;
}

const MAX_DEPTH = 6;
const MAX_SEGMENTS = 1000;
const MAX_LOOP_WORDS = 32;
const DROPPED_TARGET_RE = /^\/dev\/(null|stdout|stderr|fd\/)/;
const STDOUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
const SINKS = new Set(['tail', 'head', 'grep', 'less', 'cat', 'tee', 'wc', 'sed', 'awk', 'sort', 'uniq']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const RUNNER_WRAPPERS = new Set(['npx', 'uvx', 'bunx']);
const RUN_WRAPPERS = new Set(['poetry', 'pipenv', 'hatch', 'pdm']);
/** Task-runner flags whose *separate* value must not be mistaken for the target (`make -C dir test` → `make:test`). */
const TASK_VALUE_FLAGS: Readonly<Record<'make' | 'just' | 'gradle', ReadonlySet<string>>> = {
  make: new Set(['-C', '-f', '-I', '-o', '-W']),
  just: new Set(['-f', '--justfile', '-d', '--working-directory']),
  gradle: new Set(['-p', '--project-dir', '-b', '--build-file', '-I', '--init-script']),
};

function note(ctx: BuildContext, text: string): void {
  if (!ctx.notes.includes(text)) ctx.notes.push(text);
}

function scoped(ctx: BuildContext, fromSubst = false): BuildContext {
  return {
    ...ctx,
    state: cloneCwd(ctx.state),
    vars: new Map(ctx.vars),
    flags: { pipefail: ctx.flags.pipefail },
    fromSubst: ctx.fromSubst || fromSubst,
    depth: ctx.depth + 1,
  };
}

function push(ctx: BuildContext, seg: ShellSegment, sep: Sep): void {
  if (ctx.segments.length >= MAX_SEGMENTS) {
    note(ctx, 'segment-cap');
    return;
  }
  ctx.segments.push(seg);
  ctx.links.push({ sep, fromSubst: ctx.fromSubst, sink: false, pipefail: ctx.flags.pipefail });
}

/** Descends into every captured `$(…)`/backtick body of `words` for classification. */
function descend(ctx: BuildContext, words: readonly Word[]): void {
  if (ctx.depth >= MAX_DEPTH) return;
  for (const word of words) {
    for (const body of word.substBodies) {
      const inner = ctx.relex(body);
      for (const n of inner.notes) note(ctx, n);
      buildItems(inner.items, scoped(ctx, true));
    }
  }
}

/** Resolves one raw redirect against the segment's cwd and variables; `null` when the target is dropped (`/dev/null` family). */
function resolveRedirect(
  raw: RawRedirect,
  cwd: string,
  home: string,
  vars: ReadonlyMap<string, string>,
): { op: string; target: string; fd?: number; resolved: boolean } | null {
  const { text, resolved } = resolveWord(raw.target, vars);
  if (DROPPED_TARGET_RE.test(text)) return null;
  let target = text;
  if (resolved) {
    target = text === '~' || text.startsWith('~/') ? canon(text, { home }) : resolveAgainst(cwd, text);
  }
  const entry: { op: string; target: string; fd?: number; resolved: boolean } = { op: raw.op, target, resolved };
  if (raw.fd !== undefined) entry.fd = raw.fd;
  return entry;
}

/** True when a raw redirect list sends stdout to a file (suppresses parsed output, §4.5.5). */
function redirectsStdoutToFile(redirects: readonly RawRedirect[]): boolean {
  return redirects.some((r) => STDOUT_OPS.has(r.op) && (r.fd === undefined || r.fd === 1));
}

interface Unwrapped {
  program: string;
  args: Word[];
  wrapper?: string;
  assignments: Record<string, string>;
}

/** Strips env-style wrappers and leading `VAR=value` words; folds runner wrappers into the program (§4.5.2). */
function unwrap(words: Word[], vars: Map<string, string>): Unwrapped {
  const assignments: Record<string, string> = {};
  let wrapper: string | undefined;
  let i = 0;
  const takeAssignments = (): void => {
    for (; i < words.length; i += 1) {
      const a = parseAssignment(words[i] as Word);
      if (a === null) break;
      assignments[a.name] = a.value;
      if (a.literal) vars.set(a.name, a.value);
    }
  };
  const skipFlags = (valueFlags: readonly string[] = []): void => {
    while (i < words.length && (words[i] as Word).text.startsWith('-')) {
      const flag = (words[i] as Word).text;
      i += 1;
      if (valueFlags.includes(flag)) i += 1;
    }
  };
  takeAssignments();
  for (;;) {
    const w = words[i]?.text;
    if (w === undefined) break;
    if (w === 'time' || w === 'nohup' || w === 'exec') {
      wrapper ??= w;
      i += 1;
    } else if (w === 'nice' || w === 'caffeinate' || w === 'stdbuf') {
      wrapper ??= w;
      i += 1;
      skipFlags(['-n']);
    } else if (w === 'timeout') {
      wrapper ??= w;
      i += 1;
      skipFlags(['-s', '--signal', '-k', '--kill-after']);
      if (words[i] !== undefined && /^\d/.test((words[i] as Word).text)) i += 1;
    } else if (w === 'env') {
      wrapper ??= w;
      i += 1;
      skipFlags(['-u']);
      takeAssignments();
    } else if (w === 'sudo') {
      wrapper = 'sudo';
      i += 1;
      skipFlags(['-u', '-g']);
    } else {
      break;
    }
  }
  const rest = words.slice(i);
  const [head, second, third] = [rest[0]?.text, rest[1]?.text, rest[2]?.text];
  const setWrapper = (w: string): void => {
    if (wrapper !== 'sudo') wrapper = w;
  };
  const from = (n: number, program: string, dropDashDash = false): Unwrapped => {
    let args = rest.slice(n);
    if (dropDashDash && args[0]?.text === '--') args = args.slice(1);
    const out: Unwrapped = { program, args, assignments };
    if (wrapper !== undefined) out.wrapper = wrapper;
    return out;
  };
  if (head === undefined) return from(0, '');
  if (RUNNER_WRAPPERS.has(head) && second !== undefined) {
    setWrapper(head);
    let n = 1;
    while (rest[n] !== undefined && (rest[n] as Word).text.startsWith('-')) n += 1;
    return rest[n] === undefined ? from(1, second) : from(n + 1, (rest[n] as Word).text);
  }
  if (head === 'uv' && second === 'run') {
    setWrapper('uv run');
    let n = 2;
    while (rest[n] !== undefined && (rest[n] as Word).text.startsWith('-')) n += 1;
    if (rest[n] !== undefined) return from(n + 1, (rest[n] as Word).text);
  }
  if (RUN_WRAPPERS.has(head) && second === 'run' && third !== undefined) {
    setWrapper(`${head} run`);
    return from(3, third);
  }
  if ((head === 'pnpm' || head === 'yarn') && (second === 'exec' || second === 'dlx') && third !== undefined) {
    setWrapper(`${head} ${second}`);
    return from(3, third);
  }
  if (head === 'bun' && second === 'run' && third !== undefined && third !== 'test') {
    setWrapper('bun run');
    return from(3, third);
  }
  if (head === 'bundle' && second === 'exec' && third !== undefined) {
    setWrapper('bundle exec');
    return from(3, third);
  }
  if ((head === 'python' || head === 'python3' || head === 'python2') && rest.some((w) => w.text === '-m')) {
    const m = rest.findIndex((w) => w.text === '-m');
    const mod = rest[m + 1]?.text;
    if (mod !== undefined) {
      setWrapper(`${head} -m`);
      return from(m + 2, mod);
    }
  }
  if (head === 'node' && rest.some((w) => w.text === '--test')) {
    const out = from(1, 'node-test');
    out.args = out.args.filter((w) => w.text !== '--test');
    return out;
  }
  if (head === 'go' && second === 'test') return from(2, 'go-test');
  if (head === 'cargo' && second === 'test') return from(2, 'cargo-test');
  if (head === 'cargo' && second === 'nextest' && third === 'run') return from(3, 'cargo-test');
  if (head === 'npm') {
    if (second === 'test' || second === 't') return from(2, 'npm-script:test', true);
    if ((second === 'run' || second === 'run-script') && third !== undefined) return from(3, `npm-script:${third}`, true);
  }
  if ((head === 'pnpm' || head === 'yarn' || head === 'bun') && second === 'test') return from(2, 'npm-script:test', true);
  if ((head === 'pnpm' || head === 'yarn') && second === 'run' && third !== undefined) return from(3, `npm-script:${third}`, true);
  if (head === 'make' || head === 'just' || head === 'gradle' || head === 'gradlew' || head === './gradlew') {
    const kind = head === 'make' || head === 'just' ? head : 'gradle';
    // Skip value-taking flags before picking the target, mirroring `gitSubcommand`
    // (`make -j` swallows a separate value only when it is numeric, as make does).
    const valueFlags = TASK_VALUE_FLAGS[kind];
    let ti = -1;
    for (let idx = 1; idx < rest.length; idx += 1) {
      const t = (rest[idx] as Word).text;
      if (t.startsWith('-')) {
        if (valueFlags.has(t) || (kind === 'make' && t === '-j' && /^\d+$/.test(rest[idx + 1]?.text ?? ''))) idx += 1;
        continue;
      }
      ti = idx;
      break;
    }
    const target = ti === -1 ? 'default' : (rest[ti] as Word).text;
    const out = from(1, `${kind}:${target}`);
    out.args = out.args.filter((_, idx) => idx + 1 !== ti);
    return out;
  }
  if (head === 'mvn' || head === 'mvnw' || head === './mvnw') {
    const goals = rest
      .slice(1)
      .filter((w) => !w.text.startsWith('-'))
      .map((w) => w.text);
    const out = from(1, `mvn:${goals.join(',')}`);
    out.args = out.args.filter((w) => w.text.startsWith('-'));
    return out;
  }
  if (head === 'rake' && second !== undefined) return from(2, `rake:${second}`);
  return from(1, head);
}

/** Builds one simple command into a segment (or splices a `bash -c` body). */
function buildCommand(cmd: RawCommand, ctx: BuildContext): void {
  descend(ctx, cmd.words);
  for (const r of cmd.redirects) descend(ctx, [r.target]);
  const localVars = new Map(ctx.vars);
  const { program, args, wrapper, assignments } = unwrap(cmd.words, localVars);

  // Standalone assignments persist to later segments in the same command (§4.5.4).
  if (program === '') {
    for (const [k, v] of localVars) ctx.vars.set(k, v);
  }
  // `bash -c '…'` bodies are re-tokenised and spliced (§4.5.2).
  if (SHELLS.has(program) && ctx.depth < MAX_DEPTH) {
    const flagIdx = args.findIndex((w) => /^-[A-Za-z]*c$/.test(w.text));
    const body = flagIdx === -1 ? undefined : args[flagIdx + 1];
    if (body !== undefined && !body.subst && body.text !== '') {
      const inner = ctx.relex(body.text);
      for (const n of inner.notes) note(ctx, n);
      const child = scoped(ctx);
      const before = ctx.segments.length;
      buildItems(inner.items, child);
      spliceTail(ctx, before, cmd.sep, cmd.redirects, localVars);
      return;
    }
  }

  const seg: ShellSegment = {
    program,
    argv: args.map((w) => w.text),
    raw: cmd.words.map((w) => w.text).join(' '),
    cwd: ctx.state.dir,
    exitCode: null,
    exitCodeSource: 'unknown' as ExitSource,
    piped: false,
    suppressed: false,
    ran: true,
    redirects: [],
    scanTokens: args.map((w) => w.scan).filter((s) => s !== ''),
  };
  if (wrapper !== undefined) seg.wrapper = wrapper;
  if (Object.keys(assignments).length > 0) seg.assignments = assignments;
  for (const raw of cmd.redirects) {
    const entry = resolveRedirect(raw, ctx.state.dir, ctx.home, localVars);
    if (entry !== null) seg.redirects.push(entry);
  }
  // `cp/mv/sed` operands substitute literal variables too (§4.5.4).
  if (program === 'cp' || program === 'mv' || program === 'sed') {
    seg.argv = args.map((wd) => {
      if (!wd.dollar || wd.subst) return wd.text;
      const r = resolveWord(wd, localVars);
      return r.resolved ? r.text : wd.text;
    });
  }
  if (redirectsStdoutToFile(cmd.redirects)) seg.suppressed = true;
  const heredoc = cmd.heredocs[0];
  if (heredoc !== undefined) seg.heredoc = { delimiter: heredoc.delimiter, bytes: heredoc.bytes };

  if (program === 'cd') {
    const arg = args.find((w) => !w.text.startsWith('-') || w.text === '-');
    if (arg === undefined) applyCd(null, true, ctx.state);
    else {
      const { text, resolved } = resolveWord(arg, localVars);
      applyCd(text, resolved, ctx.state);
    }
  } else if (isUntrackedDirOp(program)) {
    ctx.state.resolved = false;
  } else if (program === 'set' && seg.argv.includes('pipefail')) {
    ctx.flags.pipefail = true;
    ctx.top.pipefail = true;
  } else if (program === 'source' || program === '.') {
    note(ctx, `source: ${seg.argv[0] ?? ''}`);
  }

  classifySegment(seg);
  for (const h of cmd.heredocs) {
    const entry: { delimiter: string; bytes: number; interpreter?: string } = { delimiter: h.delimiter, bytes: h.bytes };
    if (seg.family === 'script' && seg.heredoc !== undefined) entry.interpreter = program;
    ctx.heredocs.push(entry);
  }
  if (seg.family === 'script' && seg.heredoc !== undefined) {
    const last = ctx.heredocs[ctx.heredocs.length - 1];
    if (last !== undefined) seg.heredoc = last;
  }
  if (ctx.fromSubst) {
    seg.suppressed = true;
  }
  push(ctx, seg, cmd.sep);
}

/** Attaches a group/`bash -c` tail: the outer sep lands on the last spliced link, outer redirects on the spliced segments. */
function spliceTail(ctx: BuildContext, from: number, sep: Sep, redirects: readonly RawRedirect[], vars: ReadonlyMap<string, string>): void {
  if (ctx.segments.length === from) return;
  const lastLink = ctx.links[ctx.links.length - 1] as SegLink;
  lastLink.sep = sep;
  if (redirects.length === 0) return;
  const lastSeg = ctx.segments[ctx.segments.length - 1] as ShellSegment;
  for (const raw of redirects) {
    const entry = resolveRedirect(raw, lastSeg.cwd, ctx.home, vars);
    if (entry !== null) lastSeg.redirects.push(entry);
  }
  if (redirectsStdoutToFile(redirects)) {
    for (let i = from; i < ctx.segments.length; i += 1) (ctx.segments[i] as ShellSegment).suppressed = true;
  }
}

/** Expands `for X in <literal words>; do … done` per word (cap 32, no nested loops; §4.5.2). */
function buildFor(header: RawCommand, body: RawItem[], ctx: BuildContext): void {
  const words = header.words;
  const varName = words[1]?.text;
  const inKw = words[2]?.text;
  const list = words.slice(3);
  const nested = body.some((it) => it.kind === 'cmd' && it.words[0]?.text === 'for');
  const literal = varName !== undefined && inKw === 'in' && list.length > 0 && list.every((w) => !w.dollar && !w.subst && !w.glob);
  if (!literal || nested || ctx.depth >= MAX_DEPTH) {
    note(ctx, nested ? 'nested-for-not-expanded' : 'for-not-expanded');
    buildItems(body, scoped(ctx));
    return;
  }
  const capped = list.slice(0, MAX_LOOP_WORDS);
  if (list.length > MAX_LOOP_WORDS) note(ctx, 'for-expansion-capped');
  for (const w of capped) {
    const child = scoped(ctx);
    child.state = ctx.state; // loop `cd` persists like bash
    child.vars.set(varName as string, w.text);
    buildItems(body, child);
  }
}

/** Builds every item at one nesting level, walking cwd and variables left to right. */
export function buildItems(items: RawItem[], ctx: BuildContext): void {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as RawItem;
    if (item.kind === 'group') {
      if (ctx.depth >= MAX_DEPTH) {
        note(ctx, 'max-depth');
        continue;
      }
      const inner = ctx.relex(item.body);
      for (const n of inner.notes) note(ctx, n);
      const before = ctx.segments.length;
      buildItems(inner.items, scoped(ctx));
      spliceTail(ctx, before, item.sep, item.redirects, ctx.vars);
      continue;
    }
    if (item.words[0]?.text === 'for') {
      // Collect `do … done` items; `do`/`done` may prefix or stand alone.
      const body: RawItem[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < items.length; j += 1) {
        const it = items[j] as RawItem;
        if (it.kind !== 'cmd') {
          body.push(it);
          continue;
        }
        let w = it.words;
        if (w[0]?.text === 'do') w = w.slice(1);
        if (w[0]?.text === 'done') {
          closed = true;
          break;
        }
        const last = w[w.length - 1];
        if (last?.text === 'done') {
          w = w.slice(0, -1);
          closed = true;
        }
        if (w.length > 0 || it.redirects.length > 0) body.push({ ...it, words: w });
        if (closed) break;
      }
      if (closed) {
        buildFor(item, body, ctx);
        i = j;
        continue;
      }
    }
    buildCommand(item, ctx);
  }
}

/** Marks pipeline membership and sink suppression over the finished chain (§4.5.5). */
export function finalizePipes(segments: ShellSegment[], links: SegLink[]): void {
  const chain: number[] = [];
  for (let i = 0; i < segments.length; i += 1) if (!(links[i] as SegLink).fromSubst) chain.push(i);
  for (let c = 0; c < chain.length - 1; c += 1) {
    const i = chain[c] as number;
    const j = chain[c + 1] as number;
    const link = links[i] as SegLink;
    if (link.sep !== '|') continue;
    (segments[i] as ShellSegment).piped = true;
    (segments[j] as ShellSegment).piped = true;
    if (!link.pipefail && SINKS.has((segments[j] as ShellSegment).program)) {
      link.sink = true;
      (segments[i] as ShellSegment).suppressed = true;
    }
  }
}
