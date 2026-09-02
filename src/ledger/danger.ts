/**
 * Danger flags and secrets (§4.6.8), evaluated on `scanTokens` (heredoc
 * bodies and quoted strings removed). Two tiers: `danger` (⚠ — `rm -rf`
 * outside repo/temp roots, destructive git, force pushes, pipe-to-shell,
 * sudo, chmod 777, writes outside the repo, secret writes/commits, sandbox
 * off) and `cleanup` (informational — repo/temp `rm -rf`, benign stash/
 * reset, `pkill -f`, unresolved `rm -rf $VAR`, secret reads). Details name
 * paths and commands only — never output bodies.
 */
import type { CommandFact, DangerFlag, GitFact, ShellSegment, ToolCall, WriteFact } from '../model/types.js';
import { basename, canon, isUnder, resolveAgainst } from '../util/paths.js';
import type { LedgerContext } from './commands.js';
import { gitSubcommand, substitute } from './shell/index.js';

const GLOB_RE = /[*?[]/;
const RECURSIVE_RM_RE = /^-[a-zA-Z]*[rR]/;
const FORCE_CLEAN_RE = /^-[a-zA-Z]*f/;
const SECRET_EXCLUDE_RE = /\.env\.(example|sample|template)$/;
const SECRET_RES: readonly RegExp[] = [
  /(^|\/)\.env(\.(local|production|development))?$/,
  /id_(rsa|ed25519|ecdsa)/,
  /\.(pem|p12|pfx|key)$/,
  /credentials/i,
  /\.netrc$/,
  /\.npmrc$/,
  /\.pypirc$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /\.config\/gh\/hosts\.yml$/,
  /keychain/i,
];
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash']);
const PY_PROGRAMS = new Set(['python', 'python3', 'python2']);
const CREATE_MODE_RE = /^ (?:create|delete) mode \d+ (.+)$/gm;

/** True for a file path matching the §4.6.8 secret patterns (`.env.example` excluded). */
export function isSecretPath(p: string): boolean {
  const t = p.trim();
  if (t === '') return false;
  if (SECRET_EXCLUDE_RE.test(t)) return false;
  return SECRET_RES.some((re) => re.test(t));
}

/** Control characters stripped, whitespace collapsed at the edges, ≤ 120 chars. */
function cleanDetail(detail: string): string {
  return detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
}

type Add = (seq: number, tier: DangerFlag['tier'], kind: DangerFlag['kind'], detail: string) => void;

function inRepoOrTmp(abs: string, repoRoot: string | null, ctx: LedgerContext): boolean {
  if (repoRoot !== null && isUnder(abs, repoRoot)) return true;
  return ctx.tmpRoots.some((r) => isUnder(abs, canon(r, { home: ctx.home })));
}

/** `rm -r*`: tier by the resolved target (§4.6.8); `$VAR` resolved from same-command assignments else `cleanup`. */
function rmScan(seg: ShellSegment, call: ToolCall, ctx: LedgerContext, vars: ReadonlyMap<string, string>, add: Add): void {
  const flags = seg.scanTokens.filter((t) => t.startsWith('-'));
  if (!flags.some((t) => RECURSIVE_RM_RE.test(t))) return;
  const operands = seg.scanTokens.filter((t) => t !== '' && !t.startsWith('-'));
  const repoRoot = ctx.repoRoot === null || ctx.repoRoot === '' ? null : canon(ctx.repoRoot, { home: ctx.home });
  const home = canon(ctx.home, { home: ctx.home });
  for (const target of operands) {
    const substituted = /\$/.test(target) ? substitute(target, vars) : target;
    if (/\$/.test(substituted)) {
      add(call.seq, 'cleanup', 'rm-rf', `rm ${flags.join(' ')} ${target} (unresolved)`);
      continue;
    }
    const abs = substituted.startsWith('~') ? canon(substituted, { home: ctx.home }) : resolveAgainst(seg.cwd, substituted);
    const detail = `rm ${flags.join(' ')} ${substituted}`;
    if (abs === '/' || abs === home || substituted === '~' || substituted === '$HOME') {
      add(call.seq, 'danger', 'rm-rf', detail);
      continue;
    }
    if (basename(abs) === '.git') {
      add(call.seq, 'danger', 'rm-rf', detail);
      continue;
    }
    if (GLOB_RE.test(substituted)) {
      const slash = abs.lastIndexOf('/');
      const dir = slash <= 0 ? '/' : abs.slice(0, slash);
      if (repoRoot !== null && dir === repoRoot) add(call.seq, 'danger', 'rm-rf', detail);
      else if (inRepoOrTmp(abs, repoRoot, ctx)) add(call.seq, 'cleanup', 'rm-rf', detail);
      else add(call.seq, 'danger', 'rm-rf', detail);
      continue;
    }
    if (inRepoOrTmp(abs, repoRoot, ctx)) add(call.seq, 'cleanup', 'rm-rf', detail);
    else add(call.seq, 'danger', 'rm-rf', detail);
  }
}

/** A minimal, output-free description: `git <sub> <flags…>`. */
function gitDetail(sub: string, rest: readonly string[]): string {
  return ['git', sub, ...rest.filter((a) => a.startsWith('-'))].join(' ');
}

function gitScan(seg: ShellSegment, call: ToolCall, add: Add): void {
  const sub = gitSubcommand(seg.argv);
  if (sub === null) return;
  const rest = seg.argv.slice(seg.argv.indexOf(sub) + 1);
  const nonFlag = rest.filter((a) => a !== '--' && !a.startsWith('-'));
  switch (sub) {
    case 'reset':
      if (rest.includes('--hard') || rest.includes('--merge')) add(call.seq, 'danger', 'destructive-git', gitDetail(sub, rest));
      else add(call.seq, 'cleanup', 'destructive-git', gitDetail(sub, rest));
      return;
    case 'checkout':
      if (rest.includes('--') && nonFlag.includes('.')) add(call.seq, 'danger', 'destructive-git', 'git checkout -- .');
      return;
    case 'restore':
      if (nonFlag.includes('.')) add(call.seq, 'danger', 'destructive-git', 'git restore .');
      return;
    case 'clean':
      if (rest.some((a) => FORCE_CLEAN_RE.test(a))) add(call.seq, 'danger', 'destructive-git', gitDetail(sub, rest));
      return;
    case 'stash': {
      const first = nonFlag[0];
      if (first === 'drop' || first === 'clear') add(call.seq, 'danger', 'destructive-git', `git stash ${first}`);
      else add(call.seq, 'cleanup', 'destructive-git', `git stash${first === undefined ? '' : ` ${first}`}`);
      return;
    }
    case 'branch':
      if (rest.includes('-D')) add(call.seq, 'danger', 'destructive-git', `git branch -D${nonFlag[0] === undefined ? '' : ` ${nonFlag[0]}`}`);
      return;
    case 'push': {
      if (rest.some((a) => a.startsWith('--force-with-lease'))) add(call.seq, 'danger', 'force-push', 'git push --force-with-lease (with lease)');
      else if (rest.includes('--force') || rest.includes('-f')) add(call.seq, 'danger', 'force-push', gitDetail(sub, rest));
      if (rest.includes('--no-verify')) add(call.seq, 'danger', 'no-verify', 'git push --no-verify');
      return;
    }
    case 'commit':
      if (rest.includes('--no-verify')) add(call.seq, 'danger', 'no-verify', 'git commit --no-verify');
      return;
    case 'filter-branch':
    case 'filter-repo':
      add(call.seq, 'danger', 'history-rewrite', `git ${sub}`);
      return;
    default:
      return;
  }
}

/** Secret rules over shell file operands (`cat|cp|scp|base64|curl -T|open`) and redirect targets. */
function secretOperands(seg: ShellSegment, call: ToolCall, add: Add): void {
  const p = seg.program;
  if (p === 'cat' || p === 'base64' || p === 'open') {
    for (const a of seg.argv) {
      if (a !== '' && !a.startsWith('-') && isSecretPath(a)) add(call.seq, 'cleanup', 'read-secret', a);
    }
  } else if (p === 'cp') {
    const ops = seg.argv.filter((a) => a !== '' && !a.startsWith('-'));
    const dst = ops[ops.length - 1];
    for (const a of ops.slice(0, -1)) if (isSecretPath(a)) add(call.seq, 'cleanup', 'read-secret', a);
    if (dst !== undefined && isSecretPath(dst)) add(call.seq, 'danger', 'secret-write', dst);
  } else if (p === 'scp') {
    for (const a of seg.argv) {
      if (a !== '' && !a.startsWith('-') && isSecretPath(a)) add(call.seq, 'danger', 'secret-write', a);
    }
  } else if (p === 'curl') {
    const ti = seg.argv.findIndex((a) => a === '-T' || a === '--upload-file');
    const v = ti === -1 ? undefined : seg.argv[ti + 1];
    if (v !== undefined && isSecretPath(v)) add(call.seq, 'danger', 'secret-write', v);
  }
  for (const r of seg.redirects) {
    if (['>', '>>', '>|', '&>', '&>>'].includes(r.op) && isSecretPath(r.target)) add(call.seq, 'danger', 'secret-write', r.target);
  }
}

function scanSegment(seg: ShellSegment, index: number, fact: CommandFact, call: ToolCall, ctx: LedgerContext, vars: ReadonlyMap<string, string>, add: Add): void {
  if (seg.wrapper === 'sudo') add(call.seq, 'danger', 'sudo', `sudo ${seg.program}`);
  if (seg.program === 'rm') rmScan(seg, call, ctx, vars, add);
  if (seg.program === 'git') gitScan(seg, call, add);
  if (seg.program === 'chmod' && seg.scanTokens.some((t) => t === '777' || t === '0777')) {
    add(call.seq, 'danger', 'chmod-777', ['chmod', ...seg.scanTokens].join(' '));
  }
  if (seg.program === 'pkill' && seg.argv.includes('-f')) add(call.seq, 'cleanup', 'kill', 'pkill -f');
  // `curl|wget … | (sudo )?(sh|bash|zsh)` and `python -` fed from a network download (§4.6.8).
  const shellSink = SHELL_PROGRAMS.has(seg.program) || (PY_PROGRAMS.has(seg.program) && seg.argv.includes('-'));
  if (shellSink && seg.piped) {
    for (let j = index - 1; j >= 0; j -= 1) {
      const prev = fact.segments[j] as ShellSegment;
      if (!prev.piped) break;
      if (prev.program === 'curl' || prev.program === 'wget') {
        add(call.seq, 'danger', 'pipe-to-shell', `${prev.program} | ${seg.wrapper === 'sudo' ? 'sudo ' : ''}${seg.program}`);
        break;
      }
    }
  }
  if ((SHELL_PROGRAMS.has(seg.program) || PY_PROGRAMS.has(seg.program)) && seg.argv.some((a) => /^<\(\s*(?:curl|wget)\b/.test(a))) {
    add(call.seq, 'danger', 'pipe-to-shell', `${seg.program} <(curl …)`);
  }
  secretOperands(seg, call, add);
}

/**
 * Extracts the session's `DangerFlag`s (§4.6.8) from the command segments,
 * the extracted writes (scope-based `write-outside-repo`, tool/patch
 * `secret-write`), the git facts (`amend-after-push`) and the sandbox
 * state. Denied calls are skipped — they never executed. `detail` never
 * contains tool output bodies.
 */
export function extractDanger(
  calls: readonly ToolCall[],
  ctx: LedgerContext,
  commands: readonly CommandFact[],
  writes: readonly WriteFact[],
  git: readonly GitFact[],
): DangerFlag[] {
  const flags: DangerFlag[] = [];
  const seen = new Set<string>();
  const add: Add = (seq, tier, kind, detail) => {
    const d = cleanDetail(detail);
    const key = `${seq}|${kind}|${d}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ seq, tier, kind, detail: d });
  };

  if (ctx.sandbox !== undefined && ctx.sandbox.type === 'danger-full-access') {
    add(calls[0]?.seq ?? 0, 'danger', 'sandbox-disabled', 'sandbox: danger-full-access');
  }

  const byId = new Map(commands.map((f) => [f.toolCallId, f]));
  for (const call of calls) {
    if (call.sandboxDisabled === true) add(call.seq, 'cleanup', 'sandbox-disabled', 'dangerouslyDisableSandbox: true');
    if (call.denied !== undefined) continue;
    if (call.kind === 'read') {
      const p = typeof call.input['file_path'] === 'string' ? call.input['file_path'] : call.filesTouched[0];
      if (typeof p === 'string' && isSecretPath(p)) add(call.seq, 'cleanup', 'read-secret', p);
    }
    const fact = byId.get(call.id);
    if (fact !== undefined) {
      const vars = new Map<string, string>();
      for (let i = 0; i < fact.segments.length; i += 1) {
        const seg = fact.segments[i] as ShellSegment;
        if (seg.assignments !== undefined) for (const [k, v] of Object.entries(seg.assignments)) vars.set(k, v);
        if (seg.ran === false || seg.ran === 'short-circuited') continue;
        scanSegment(seg, i, fact, call, ctx, vars, add);
      }
      // `create mode`/`delete mode` lines of commit output, scanned for secret paths (§4.6.6).
      if (fact.segments.some((s) => s.program === 'git' && gitSubcommand(s.argv) === 'commit')) {
        for (const m of call.resultText.matchAll(CREATE_MODE_RE)) {
          if (isSecretPath(m[1] as string)) add(call.seq, 'danger', 'secret-commit', m[1] as string);
        }
      }
    }
  }

  for (const w of writes) {
    if (w.status === 'failed') continue;
    if (w.scope === 'harness-config' || w.scope === 'home-dotfile' || w.scope === 'system') {
      add(w.seq, 'danger', 'write-outside-repo', w.display);
    }
    if ((w.source === 'tool' || w.source === 'patch') && (isSecretPath(w.path) || isSecretPath(w.display))) {
      add(w.seq, 'danger', 'secret-write', w.display);
    }
  }

  const firstPush = git.find((g) => g.op === 'push' || g.op === 'force-push');
  if (firstPush !== undefined) {
    for (const g of git) {
      if (g.op === 'amend' && g.seq > firstPush.seq) add(g.seq, 'danger', 'amend-after-push', 'commit amended after a push');
    }
  }

  flags.sort((a, b) => a.seq - b.seq);
  return flags;
}
