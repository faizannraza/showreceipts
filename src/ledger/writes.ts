/**
 * Write facts (§4.6.1): tool writes (Edit/Write/MultiEdit/NotebookEdit),
 * `apply_patch` writes, shell-inferred writes (redirects, `sed -i`, `cp/mv`,
 * `rm`, formatters, lockfiles, …), interpreter-inferred writes from heredoc /
 * `-c` / `-e` bodies, and `subagent-stop.modifiedFiles` lists — each with the
 * canonical path, the spelling as logged, a verb, a status and a scope. Only
 * `ok` writes can feed VERIFIED and `filesChanged` (S14/S17); everything
 * here is pure string work over `(calls, ctx, commands)`.
 */
import type { CommandFact, ShellSegment, ToolCall, WriteFact } from '../model/types.js';
import { basename, canon, classifyScope, isUnder, resolveAgainst } from '../util/paths.js';
import type { LedgerContext } from './commands.js';
import { gitSubcommand } from './shell/index.js';
import { isDoc, isTestFile } from './testfiles.js';

const APPLY_PATCH_RE = /^\s*apply_patch\b/;
const REDIRECT_WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
const REDIRECT_ERR_RE = /No such file or directory|Permission denied|Is a directory|Read-only file system/;
const GLOB_RE = /[*?[]/;
const UNRESOLVED_RE = /[$`]/;
const PATCH_ADD_RE = /^\*\*\* Add File: (.+)$/;
const PATCH_UPDATE_RE = /^\*\*\* Update File: (.+)$/;
const PATCH_DELETE_RE = /^\*\*\* Delete File: (.+)$/;
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/;
const PATCH_TOUCHED_RE = /^([AMD]) (.+)$/gm;
const PY_PROGRAMS = new Set(['python', 'python3', 'python2']);
const METADATA_PROGRAMS = new Set(['mkdir', 'touch', 'ln', 'chmod', 'chown']);

/** A write under construction; `makeFact` fills scope and classifiers. */
interface FactSeed {
  call: ToolCall;
  cwd: string;
  path: string;
  display: string;
  verb: WriteFact['verb'];
  source: WriteFact['source'];
  status: WriteFact['status'];
  resolved: boolean;
  fromPath?: string;
  created?: boolean;
  userModified?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  metadataOnly?: boolean;
}

/** `spelled` resolved to a canonical absolute path against `cwd` (§4.6.1 `canon`). */
function absOf(spelled: string, cwd: string, home: string): string {
  return resolveAgainst(cwd, canon(spelled, { home }));
}

/** The §4.6.1 scope of a canonical path, with the Codex `writableRoots` boundary. */
function scopeOf(path: string, cwd: string, ctx: LedgerContext): { scope: WriteFact['scope']; otherRoot?: string } {
  let otherRepoRoot: string | null = null;
  const ownRoot = ctx.repoRoot === null || ctx.repoRoot === '' ? null : canon(ctx.repoRoot, { home: ctx.home });
  if ((ownRoot === null || !isUnder(path, ownRoot)) && path.startsWith('/')) otherRepoRoot = ctx.repoRootOf(path);
  let scope = classifyScope(path, {
    cwd,
    repoRoot: ctx.repoRoot,
    home: ctx.home,
    tmpRoots: ctx.tmpRoots,
    otherRepoRoot,
  });
  if (scope === 'unknown' && ctx.harness === 'codex' && ctx.sandbox !== undefined) {
    // Codex uses `sandbox_policy.writable_roots` as the boundary (§4.6.1).
    if (ctx.sandbox.writableRoots.some((r) => isUnder(path, canon(r, { home: ctx.home })))) scope = 'repo';
  }
  if (scope === 'other-repo' && otherRepoRoot !== null) return { scope, otherRoot: otherRepoRoot };
  return { scope };
}

function makeFact(seed: FactSeed, ctx: LedgerContext): WriteFact {
  let scope: WriteFact['scope'] = 'unknown';
  let otherRoot: string | undefined;
  if (seed.resolved && seed.path !== '') {
    const s = scopeOf(seed.path, seed.cwd, ctx);
    scope = s.scope;
    otherRoot = s.otherRoot;
  }
  const fact: WriteFact = {
    seq: seed.call.seq,
    toolCallId: seed.call.id,
    agentId: seed.call.agentId,
    path: seed.path,
    display: seed.display,
    verb: seed.verb,
    source: seed.source,
    status: seed.status,
    resolved: seed.resolved,
    scope,
    isTestFile: isTestFile(seed.path),
    isDoc: isDoc(seed.path),
  };
  if (otherRoot !== undefined) fact.otherRoot = otherRoot;
  if (seed.fromPath !== undefined) fact.fromPath = seed.fromPath;
  if (seed.created === true) fact.created = true;
  if (seed.userModified !== undefined) fact.userModified = seed.userModified;
  if (seed.linesAdded !== undefined) fact.linesAdded = seed.linesAdded;
  if (seed.linesRemoved !== undefined) fact.linesRemoved = seed.linesRemoved;
  if (seed.metadataOnly === true) fact.metadataOnly = true;
  return fact;
}

// --- tool writes (§4.6.1 *tool*) -------------------------------------------

function inputPathOf(call: ToolCall): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = call.input[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function toolWrites(call: ToolCall, ctx: LedgerContext, out: WriteFact[]): void {
  const spelledInput = inputPathOf(call);
  const authoritative = call.filesTouched[0];
  const display = spelledInput ?? authoritative;
  const pathSource = authoritative ?? spelledInput;
  if (display === undefined || display === null || pathSource === undefined || pathSource === null) return;
  // `ok` iff no error, no denial, and the result object named a file (§4.6.1).
  const ok = !call.isError && call.denied === undefined && call.filesTouched.length > 0;
  const created = call.created === true;
  const seed: FactSeed = {
    call,
    cwd: call.cwd,
    path: absOf(pathSource, call.cwd, ctx.home),
    display,
    verb: created ? 'create' : 'update',
    source: 'tool',
    status: ok ? 'ok' : 'failed',
    resolved: true,
  };
  if (created) seed.created = true;
  if (call.userModified !== undefined) seed.userModified = call.userModified;
  if (call.patch !== undefined) {
    seed.linesAdded = call.patch.added.length;
    seed.linesRemoved = call.patch.removed.length;
  }
  out.push(makeFact(seed, ctx));
}

// --- patch writes (§4.6.1 *patch*, §4.3.4) ---------------------------------

/** An `apply_patch` call: the Codex custom tool or an exec-delivered patch. */
function isPatchCall(call: ToolCall): boolean {
  return call.tool === 'apply_patch' || (call.command !== undefined && APPLY_PATCH_RE.test(call.command));
}

/** The patch header text carried on the call (command heredoc or a string input). */
function patchTextOf(call: ToolCall): string | null {
  if (call.command !== undefined && call.command.includes('*** Begin Patch')) return call.command;
  for (const v of Object.values(call.input)) {
    if (typeof v === 'string' && v.includes('*** Begin Patch')) return v;
  }
  return null;
}

function patchWrites(call: ToolCall, ctx: LedgerContext, out: WriteFact[]): void {
  // A failed patch produces no write (`attempted[]` is reported by S18).
  if (call.isError || call.denied !== undefined || call.filesTouched.length === 0) return;
  const letters = new Map<string, 'A' | 'M' | 'D'>();
  for (const m of call.resultText.matchAll(PATCH_TOUCHED_RE)) {
    letters.set(absOf((m[2] as string).trim(), call.cwd, ctx.home), m[1] as 'A' | 'M' | 'D');
  }
  const headerVerb = new Map<string, WriteFact['verb']>();
  const moveSource = new Map<string, string>();
  const movedSources = new Set<string>();
  const text = patchTextOf(call);
  if (text !== null) {
    let lastUpdate: string | null = null;
    for (const line of text.split('\n')) {
      const add = PATCH_ADD_RE.exec(line);
      const upd = PATCH_UPDATE_RE.exec(line);
      const del = PATCH_DELETE_RE.exec(line);
      const mov = PATCH_MOVE_RE.exec(line);
      if (add?.[1] !== undefined) {
        headerVerb.set(absOf(add[1].trim(), call.cwd, ctx.home), 'create');
        lastUpdate = null;
      } else if (upd?.[1] !== undefined) {
        lastUpdate = absOf(upd[1].trim(), call.cwd, ctx.home);
        headerVerb.set(lastUpdate, 'update');
      } else if (del?.[1] !== undefined) {
        headerVerb.set(absOf(del[1].trim(), call.cwd, ctx.home), 'delete');
        lastUpdate = null;
      } else if (mov?.[1] !== undefined && lastUpdate !== null) {
        // `*** Move to: q` under `*** Update File: p` ⇒ rename q with fromPath p.
        const target = absOf(mov[1].trim(), call.cwd, ctx.home);
        moveSource.set(target, lastUpdate);
        movedSources.add(lastUpdate);
        headerVerb.delete(lastUpdate);
        lastUpdate = null;
      }
    }
  }
  const emitted: WriteFact[] = [];
  for (const spelled of call.filesTouched) {
    const abs = absOf(spelled, call.cwd, ctx.home);
    if (movedSources.has(abs)) continue; // the move's source is covered by the rename fact
    const from = moveSource.get(abs);
    const letter = letters.get(abs);
    const verb: WriteFact['verb'] =
      from !== undefined
        ? 'rename'
        : letter === 'A'
          ? 'create'
          : letter === 'D'
            ? 'delete'
            : letter === 'M'
              ? 'update'
              : (headerVerb.get(abs) ?? 'update');
    const seed: FactSeed = {
      call,
      cwd: call.cwd,
      path: abs,
      display: spelled,
      verb,
      source: 'patch',
      status: 'ok',
      resolved: true,
    };
    if (from !== undefined) seed.fromPath = from;
    if (verb === 'create') seed.created = true;
    emitted.push(makeFact(seed, ctx));
  }
  const first = emitted[0];
  if (emitted.length === 1 && first !== undefined && call.patch !== undefined) {
    first.linesAdded = call.patch.added.length;
    first.linesRemoved = call.patch.removed.length;
  }
  out.push(...emitted);
}

// --- shell-inferred writes (§4.6.1 *shell-inferred*) -----------------------

function segmentRan(seg: ShellSegment): boolean {
  return seg.ran !== false && seg.ran !== 'short-circuited';
}

/** Command-family status: `ok` on exit 0, `unknown` when the exit is unknown, else `failed`. */
function segStatus(seg: ShellSegment, call: ToolCall): WriteFact['status'] {
  if (seg.ran === 'background' || call.background) return 'unknown';
  if (seg.exitCode === 0) return 'ok';
  if (seg.exitCode === null || seg.exitCode === -1 || call.resultText.includes('Process running')) return 'unknown';
  return 'failed';
}

/** A textual operand resolved against the segment's cwd; globs/variables stay unresolved. */
function operandOf(text: string, seg: ShellSegment, home: string): { text: string; abs: string; resolved: boolean } {
  const resolved = text !== '' && !GLOB_RE.test(text) && !UNRESOLVED_RE.test(text);
  const abs = text === '' ? '' : text.startsWith('~') ? canon(text, { home }) : resolveAgainst(seg.cwd, text);
  return { text, abs, resolved };
}

/** True when an error line of the result names this redirect target (§4.6.1). */
function stderrNamesTarget(text: string, target: string): boolean {
  if (target === '') return false;
  const base = basename(target);
  for (const line of text.split('\n')) {
    if (!REDIRECT_ERR_RE.test(line)) continue;
    if (line.includes(target) || (base !== '' && line.includes(base))) return true;
  }
  return false;
}

/** Redirect family (`>`, `>>`, `>|`, `&>`, `N>`, `tee [-a]`): `ok` regardless of exit unless stderr names the target. */
function redirectWrites(seg: ShellSegment, call: ToolCall, ctx: LedgerContext, out: WriteFact[]): void {
  for (const r of seg.redirects) {
    if (!REDIRECT_WRITE_OPS.has(r.op)) continue;
    const failed = stderrNamesTarget(call.resultText, r.target);
    out.push(
      makeFact(
        {
          call,
          cwd: seg.cwd,
          path: r.target,
          display: r.target,
          verb: r.op === '>>' || r.op === '&>>' ? 'update' : 'create',
          source: 'shell-inferred',
          status: failed ? 'failed' : 'ok',
          resolved: r.resolved,
        },
        ctx,
      ),
    );
  }
  if (seg.program === 'tee') {
    const append = seg.argv.includes('-a') || seg.argv.includes('--append');
    for (const a of seg.argv) {
      if (a === '' || a.startsWith('-')) continue;
      const op = operandOf(a, seg, ctx.home);
      const failed = stderrNamesTarget(call.resultText, op.resolved ? op.abs : op.text);
      out.push(
        makeFact(
          {
            call,
            cwd: seg.cwd,
            path: op.resolved ? op.abs : op.text,
            display: a,
            verb: append ? 'update' : 'create',
            source: 'shell-inferred',
            status: failed ? 'failed' : 'ok',
            resolved: op.resolved,
          },
          ctx,
        ),
      );
    }
  }
}

function sedWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  const argv = seg.argv;
  let suffix: string | null = null;
  let sawScript = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '-i' || a === '--in-place') {
      suffix = '';
      if (argv[i + 1] === '') i += 1; // BSD `sed -i '' …`: the empty suffix argument
      continue;
    }
    if (a.startsWith('--in-place=')) {
      suffix = a.slice('--in-place='.length);
      continue;
    }
    if (a.startsWith('-i') && a.length > 2) {
      suffix = a.slice(2); // GNU/BSD attached suffix: `-i.bak`
      continue;
    }
    if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') {
      sawScript = true;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!sawScript) {
      sawScript = true; // the sed script operand
      continue;
    }
    files.push(a);
  }
  if (suffix === null) return;
  for (const f of files) {
    const op = operandOf(f, seg, ctx.home);
    out.push(
      makeFact(
        { call, cwd: seg.cwd, path: op.resolved ? op.abs : op.text, display: f, verb: 'update', source: 'shell-inferred', status, resolved: op.resolved },
        ctx,
      ),
    );
    if (suffix !== '') {
      // A backup suffix adds an extra `<f><suffix>` write (§4.6.1).
      const backup = operandOf(`${f}${suffix}`, seg, ctx.home);
      out.push(
        makeFact(
          {
            call,
            cwd: seg.cwd,
            path: backup.resolved ? backup.abs : backup.text,
            display: `${f}${suffix}`,
            verb: 'create',
            source: 'shell-inferred',
            status,
            resolved: backup.resolved,
            created: true,
          },
          ctx,
        ),
      );
    }
  }
}

const CP_VALUE_FLAGS = new Set(['-m', '-o', '-g', '-S', '--suffix', '--mode', '--owner', '--group']);

function cpMvWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  const rename = seg.program === 'mv';
  const argv = seg.argv;
  const operands: string[] = [];
  let targetDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--') {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-t' || a === '--target-directory') {
      targetDir = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a.startsWith('--target-directory=')) {
      targetDir = a.slice('--target-directory='.length);
      continue;
    }
    if (CP_VALUE_FLAGS.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-') && a !== '-') continue;
    operands.push(a);
  }
  let sources = operands;
  let dst = targetDir;
  if (dst === null) {
    if (operands.length < 2) return;
    dst = operands[operands.length - 1] as string;
    sources = operands.slice(0, -1);
  }
  if (sources.length === 0) return;
  const dstOp = operandOf(dst, seg, ctx.home);
  const dirLike = targetDir !== null || dst.endsWith('/') || dst === '.' || dst === '..' || sources.length > 1;
  for (const src of sources) {
    const srcOp = operandOf(src, seg, ctx.home);
    const resolved = dirLike ? dstOp.resolved && srcOp.resolved : dstOp.resolved;
    const path = dirLike ? (resolved ? resolveAgainst(dstOp.abs, basename(srcOp.abs)) : `${dst.replace(/\/+$/, '')}/${basename(src)}`) : dstOp.resolved ? dstOp.abs : dst;
    const display = dirLike ? `${dst.replace(/\/+$/, '')}/${basename(src)}` : dst;
    const seed: FactSeed = {
      call,
      cwd: seg.cwd,
      path,
      display,
      verb: rename ? 'rename' : 'update',
      source: 'shell-inferred',
      status,
      resolved,
    };
    if (rename) seed.fromPath = srcOp.resolved ? srcOp.abs : src;
    out.push(makeFact(seed, ctx));
  }
}

function deleteWrites(paths: readonly string[], seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  for (const p of paths) {
    const op = operandOf(p, seg, ctx.home);
    out.push(
      makeFact(
        { call, cwd: seg.cwd, path: op.resolved ? op.abs : op.text, display: p, verb: 'delete', source: 'shell-inferred', status, resolved: op.resolved },
        ctx,
      ),
    );
  }
}

/** `mkdir|touch|ln -s|chmod|chown`: recorded with `metadataOnly`, never in `filesChanged` (§4.6.1). */
function metadataWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  const p = seg.program;
  let targets: string[] = [];
  let verb: WriteFact['verb'] = 'update';
  const nonFlag = (skipValues: readonly string[]): string[] => {
    const outArgs: string[] = [];
    for (let i = 0; i < seg.argv.length; i += 1) {
      const a = seg.argv[i] as string;
      if (skipValues.includes(a)) {
        i += 1;
        continue;
      }
      if (a.startsWith('-')) continue;
      outArgs.push(a);
    }
    return outArgs;
  };
  if (p === 'mkdir') {
    targets = nonFlag(['-m', '--mode']);
    verb = 'create';
  } else if (p === 'touch') {
    targets = nonFlag(['-t', '-d', '-r']);
    verb = 'create';
  } else if (p === 'ln') {
    if (!seg.argv.includes('-s') && !seg.argv.some((a) => /^-[a-zA-Z]*s/.test(a))) return;
    const ops = nonFlag([]);
    const link = ops[ops.length - 1];
    if (ops.length < 2 || link === undefined) return;
    targets = [link];
    verb = 'create';
  } else {
    // chmod / chown: the first operand is the mode/owner, the rest are files.
    targets = nonFlag(['--reference']).slice(1);
  }
  for (const t of targets) {
    const op = operandOf(t, seg, ctx.home);
    out.push(
      makeFact(
        {
          call,
          cwd: seg.cwd,
          path: op.resolved ? op.abs : op.text,
          display: t,
          verb,
          source: 'shell-inferred',
          status,
          resolved: op.resolved,
          metadataOnly: true,
        },
        ctx,
      ),
    );
  }
}

function downloadWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  const flags = seg.program === 'curl' ? ['-o', '--output'] : ['-O', '--output-document'];
  for (let i = 0; i < seg.argv.length; i += 1) {
    const a = seg.argv[i] as string;
    let target: string | undefined;
    if (flags.includes(a)) target = seg.argv[i + 1];
    else if (a.startsWith('--output-document=')) target = a.slice('--output-document='.length);
    else if (a.startsWith('--output=')) target = a.slice('--output='.length);
    if (target === undefined || target === '' || target === '-') continue;
    const op = operandOf(target, seg, ctx.home);
    out.push(
      makeFact(
        {
          call,
          cwd: seg.cwd,
          path: op.resolved ? op.abs : op.text,
          display: target,
          verb: 'create',
          source: 'shell-inferred',
          status,
          resolved: op.resolved,
          created: true,
        },
        ctx,
      ),
    );
  }
}

const FORMATTER_SUBCOMMANDS = new Set(['format', 'check', 'lint', 'fmt', 'write']);
const FORMATTER_VALUE_FLAGS = new Set(['--config', '--settings', '--line-length', '--target-version']);

/** Formatter/fixer runs write their named paths; none named ⇒ one unresolved "formatter modified files" write. */
function formatterWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  const paths: string[] = [];
  for (let i = 0; i < seg.argv.length; i += 1) {
    const a = seg.argv[i] as string;
    if (a.startsWith('-')) {
      if (FORMATTER_VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    if (paths.length === 0 && FORMATTER_SUBCOMMANDS.has(a) && i === 0) continue;
    if (a === '.' || a === './' || a === '') continue;
    paths.push(a);
  }
  if (paths.length === 0) {
    out.push(
      makeFact(
        { call, cwd: seg.cwd, path: '', display: 'formatter modified files', verb: 'update', source: 'shell-inferred', status, resolved: false },
        ctx,
      ),
    );
    return;
  }
  for (const p of paths) {
    const op = operandOf(p, seg, ctx.home);
    out.push(
      makeFact(
        { call, cwd: seg.cwd, path: op.resolved ? op.abs : op.text, display: p, verb: 'update', source: 'shell-inferred', status, resolved: op.resolved },
        ctx,
      ),
    );
  }
}

/** The manifest/lockfile basenames an install-family segment rewrites (§4.6.1). */
function lockfileNames(seg: ShellSegment): string[] {
  const p = seg.program;
  const first = seg.argv[0] ?? '';
  if (p === 'npm') return ['package-lock.json'];
  if (p === 'pnpm') return ['pnpm-lock.yaml'];
  if (p === 'yarn') return ['yarn.lock'];
  if (p === 'bun') return ['bun.lockb'];
  if (p === 'uv') {
    if (first === 'add') return ['uv.lock', 'pyproject.toml'];
    if (first === 'sync' || first === 'lock') return ['uv.lock'];
    return [];
  }
  if (p === 'cargo' && first === 'add') return ['Cargo.toml', 'Cargo.lock'];
  return [];
}

function lockfileWrites(seg: ShellSegment, call: ToolCall, status: WriteFact['status'], ctx: LedgerContext, out: WriteFact[]): void {
  for (const name of lockfileNames(seg)) {
    out.push(
      makeFact(
        {
          call,
          cwd: seg.cwd,
          path: resolveAgainst(seg.cwd, name),
          display: name,
          verb: 'update',
          source: 'shell-inferred',
          status,
          resolved: true,
        },
        ctx,
      ),
    );
  }
}

function commandFamilyWrites(seg: ShellSegment, call: ToolCall, ctx: LedgerContext, out: WriteFact[]): void {
  const status = segStatus(seg, call);
  const p = seg.program;
  if (p === 'sed') sedWrites(seg, call, status, ctx, out);
  else if (p === 'cp' || p === 'mv' || p === 'install') cpMvWrites(seg, call, status, ctx, out);
  else if (p === 'rm' || p === 'unlink') deleteWrites(seg.argv.filter((a) => a !== '' && !a.startsWith('-')), seg, call, status, ctx, out);
  else if (p === 'git' && gitSubcommand(seg.argv) === 'rm' && !seg.argv.includes('--cached')) {
    const rest = seg.argv.slice(seg.argv.indexOf('rm') + 1).filter((a) => a !== '' && a !== '--' && !a.startsWith('-'));
    deleteWrites(rest, seg, call, status, ctx, out);
  } else if (METADATA_PROGRAMS.has(p)) metadataWrites(seg, call, status, ctx, out);
  else if (p === 'curl' || p === 'wget') downloadWrites(seg, call, status, ctx, out);
  if (seg.mayWrite === true && (seg.family === 'format' || seg.family === 'lint')) formatterWrites(seg, call, status, ctx, out);
  if (seg.family === 'install') lockfileWrites(seg, call, status, ctx, out);
}

// --- interpreter-inferred writes (§4.6.1 *interp-inferred*) ----------------

const ARG = String.raw`([^,()\n]+)`;

interface SinkSpec {
  lang: 'python' | 'node';
  re: RegExp;
  /** For `open(...)`: only write-shaped modes count. */
  write?: (m: RegExpExecArray) => boolean;
}

const SINKS: readonly SinkSpec[] = [
  {
    lang: 'python',
    re: new RegExp(String.raw`\bopen\(\s*${ARG}\s*,\s*(['"])([rwaxb+]{1,3})\2`, 'g'),
    write: (m) => /[wax]/.test(m[3] as string),
  },
  { lang: 'python', re: new RegExp(String.raw`\bPath\(\s*${ARG}\s*\)\s*\.write_(?:text|bytes)\s*\(`, 'g') },
  { lang: 'python', re: new RegExp(String.raw`\.(?:to_csv|to_parquet|to_excel|savefig)\(\s*${ARG}\s*[,)]`, 'g') },
  { lang: 'python', re: new RegExp(String.raw`\bnbformat\.write\(\s*[^,()\n]+,\s*${ARG}\s*[,)]`, 'g') },
  { lang: 'python', re: new RegExp(String.raw`\bshutil\.(?:copy2?|copyfile|move)\(\s*[^,()\n]+,\s*${ARG}\s*[,)]`, 'g') },
  { lang: 'python', re: new RegExp(String.raw`\bos\.(?:rename|replace)\(\s*[^,()\n]+,\s*${ARG}\s*\)`, 'g') },
  { lang: 'node', re: new RegExp(String.raw`(?<![.\w])(?:fs\.promises\.|fs\.)?writeFile(?:Sync)?\(\s*${ARG}\s*,`, 'g') },
];

/** Write-shaped sink call sites per language (for opaque detection). */
const SITES: Readonly<Record<'python' | 'node', readonly RegExp[]>> = {
  python: [
    /\bopen\(\s*[^)\n]*?,\s*['"][rb+]*[wax][rwaxb+]*['"]/g,
    /\.write_(?:text|bytes)\s*\(/g,
    /\.(?:to_csv|to_parquet|to_excel|savefig)\s*\(/g,
    /\bnbformat\.write\s*\(/g,
    /\bshutil\.(?:copy2?|copyfile|move)\s*\(/g,
    /\bos\.(?:rename|replace)\s*\(/g,
  ],
  node: [/(?<![.\w])(?:fs\.promises\.|fs\.)?writeFile(?:Sync)?\(/g],
};

/** Names assigned exactly once in the body to a string literal (the §4.6.1 one-hop form). */
function oneHops(body: string): Map<string, string> {
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  for (const line of body.split('\n')) {
    const m = /^\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:(?!\2)[^\n])*)\2\s*;?\s*$/.exec(line);
    if (m === null) continue;
    const name = m[1] as string;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    values.set(name, m[3] as string);
  }
  const out = new Map<string, string>();
  for (const [name, n] of counts) if (n === 1) out.set(name, values.get(name) as string);
  return out;
}

function literalTarget(expr: string, hops: ReadonlyMap<string, string>): string | null {
  const t = expr.trim();
  const m = /^'([^'\n]*)'$/.exec(t) ?? /^"([^"\n]*)"$/.exec(t) ?? /^`([^`$\n]*)`$/.exec(t);
  if (m !== null) return m[1] as string;
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return hops.get(t) ?? null;
  return null;
}

function interpBody(seg: ShellSegment, call: ToolCall): string | null {
  const ci = seg.argv.findIndex((a) => a === '-c' || a === '-e');
  if (ci !== -1) return seg.argv[ci + 1] ?? null;
  if (seg.heredoc !== undefined && call.command !== undefined) return heredocBody(call.command, seg.heredoc.delimiter);
  return null;
}

/** The body of the `<<TAG` heredoc in `raw` (first occurrence of that TAG). */
function heredocBody(raw: string, delimiter: string): string | null {
  const esc = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<<-?\\s*(?:'${esc}'|"${esc}"|${esc})`).exec(raw);
  if (m === null) return null;
  const nl = raw.indexOf('\n', m.index + m[0].length);
  if (nl === -1) return null;
  const out: string[] = [];
  for (const line of raw.slice(nl + 1).split('\n')) {
    if (line.replace(/^\t+/, '') === delimiter) break;
    out.push(line);
  }
  return out.join('\n');
}

function interpWrites(seg: ShellSegment, call: ToolCall, fact: CommandFact, ctx: LedgerContext, out: WriteFact[]): void {
  if (seg.family !== 'script') return;
  const lang: 'python' | 'node' | null = PY_PROGRAMS.has(seg.program) ? 'python' : seg.program === 'node' ? 'node' : null;
  if (lang === null) return;
  const body = interpBody(seg, call);
  if (body === null || body === '') return;
  const hops = oneHops(body);
  const status = segStatus(seg, call);
  let sites = 0;
  for (const re of SITES[lang]) {
    re.lastIndex = 0;
    while (re.exec(body) !== null) sites += 1;
  }
  let handled = 0;
  let opaque = false;
  const seen = new Set<string>();
  for (const spec of SINKS) {
    if (spec.lang !== lang) continue;
    spec.re.lastIndex = 0;
    for (let m = spec.re.exec(body); m !== null; m = spec.re.exec(body)) {
      if (spec.write !== undefined && !spec.write(m)) continue;
      handled += 1;
      const target = literalTarget(m[1] as string, hops);
      if (target === null || target === '') {
        opaque = true; // a sink with a non-literal target (§4.6.1)
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      const op = operandOf(target, seg, ctx.home);
      out.push(
        makeFact(
          {
            call,
            cwd: seg.cwd,
            path: op.resolved ? op.abs : op.text,
            display: target,
            verb: 'update',
            source: 'interp-inferred',
            status,
            resolved: op.resolved,
          },
          ctx,
        ),
      );
    }
  }
  if (opaque || sites > handled) fact.opaqueWrite = true; // S14 counts `Turn.opaqueWriteCommands`
}

// --- subagent lists (§4.4) -------------------------------------------------

function subagentWrites(call: ToolCall, ctx: LedgerContext, out: WriteFact[]): void {
  for (const p of call.filesTouched) {
    out.push(
      makeFact(
        { call, cwd: call.cwd, path: absOf(p, call.cwd, ctx.home), display: p, verb: 'update', source: 'subagent-list', status: 'unknown', resolved: true },
        ctx,
      ),
    );
  }
}

// --- revert tracking (§4.6.1) ----------------------------------------------

function applyReverts(commands: readonly CommandFact[], calls: readonly ToolCall[], writes: WriteFact[], ctx: LedgerContext): void {
  const callsById = new Map(calls.map((c) => [c.id, c]));
  for (const fact of commands) {
    const call = callsById.get(fact.toolCallId);
    if (call === undefined || call.denied !== undefined || call.interrupted) continue;
    for (const seg of fact.segments) {
      if (seg.program !== 'git' || !segmentRan(seg)) continue;
      if (seg.exitCode !== null && seg.exitCode !== 0) continue;
      const sub = gitSubcommand(seg.argv);
      if (sub === null) continue;
      const rest = seg.argv.slice(seg.argv.indexOf(sub) + 1);
      let by: string | null = null;
      let paths: string[] = [];
      let coversRepo = false;
      if (sub === 'checkout') {
        const dd = rest.indexOf('--');
        if (dd !== -1 && rest.length > dd + 1) {
          by = 'git checkout';
          paths = rest.slice(dd + 1);
        }
      } else if (sub === 'restore') {
        if (!rest.includes('--staged') || rest.includes('--worktree')) {
          const ps = rest.filter((a) => a !== '--' && !a.startsWith('-'));
          if (ps.length > 0) {
            by = 'git restore';
            paths = ps;
          }
        }
      } else if (sub === 'stash') {
        const first = rest.find((a) => !a.startsWith('-'));
        const popped = fact.segments.some((s) => s.program === 'git' && gitSubcommand(s.argv) === 'stash' && s.argv.includes('pop'));
        if (!popped && (first === undefined || first === 'push')) {
          by = 'git stash';
          const dd = rest.indexOf('--');
          if (dd !== -1) paths = rest.slice(dd + 1);
          else coversRepo = true;
        }
      } else if (sub === 'clean') {
        const ps = rest.filter((a) => a !== '--' && !a.startsWith('-'));
        if (ps.length > 0) {
          by = 'git clean';
          paths = ps;
        }
      }
      if (by === null) continue;
      const canonPaths = paths.map((p) => (p.startsWith('~') ? canon(p, { home: ctx.home }) : resolveAgainst(seg.cwd, p)));
      for (const w of writes) {
        if (w.seq >= fact.seq || w.reverted !== undefined || w.status === 'failed' || !w.resolved) continue;
        const covered = coversRepo ? w.scope === 'repo' || w.scope === 'worktree' : canonPaths.some((p) => w.path === p || isUnder(w.path, p));
        if (covered) w.reverted = { seq: fact.seq, by };
      }
    }
  }
}

// --- entry points ----------------------------------------------------------

/**
 * Extracts every `WriteFact` of a session (§4.6.1) from the tool calls and
 * the already-extracted `CommandFact`s. Marks `opaqueWrite` on a command
 * whose interpreter body writes through an unresolvable sink, and
 * `reverted` on writes later covered by `git checkout --`/`restore`/
 * `stash`/`clean`. Never a write: `mcp__*`, `Read`, unknown ledger tools.
 */
export function extractWrites(calls: readonly ToolCall[], ctx: LedgerContext, commands: readonly CommandFact[]): WriteFact[] {
  const out: WriteFact[] = [];
  const byId = new Map(commands.map((f) => [f.toolCallId, f]));
  for (const call of calls) {
    if (call.tool.startsWith('mcp__') || call.kind === 'read' || call.kind === 'search' || call.kind === 'fetch') continue;
    if (isPatchCall(call)) {
      patchWrites(call, ctx, out);
      continue;
    }
    if (call.tool === 'subagent-stop') {
      subagentWrites(call, ctx, out);
      continue;
    }
    if (call.kind === 'edit' || call.kind === 'write') {
      toolWrites(call, ctx, out);
      continue;
    }
    if (call.kind !== 'shell') continue;
    // No shell-inferred writes at all for a denial/block or an interrupt (§4.6.1).
    if (call.denied !== undefined || call.interrupted) continue;
    const fact = byId.get(call.id);
    if (fact === undefined) continue;
    for (const seg of fact.segments) {
      if (!segmentRan(seg)) continue;
      redirectWrites(seg, call, ctx, out);
      commandFamilyWrites(seg, call, ctx, out);
      interpWrites(seg, call, fact, ctx, out);
    }
  }
  applyReverts(commands, calls, out, ctx);
  return out;
}

/**
 * True when a write may enter `filesChanged` (§4.6.1): status `ok`, a
 * resolved path, and not a metadata-only operation (`mkdir`, `touch`,
 * `ln -s`, `chmod`, `chown`). S14 applies this over the extracted writes.
 */
export function filesChangedEligible(w: WriteFact): boolean {
  return w.status === 'ok' && w.resolved && w.metadataOnly !== true && w.path !== '';
}
