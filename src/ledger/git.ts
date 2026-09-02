/**
 * Git facts (§4.6.6): commits from `toolUseResult.gitOperation`, the
 * `[branch sha]` stdout line or a bare exit-0 `git commit`; pushes with
 * rejection detection and host parsing; PR creation only from a
 * PR-creation command's stdout; branch/tag/stash/merge/rebase/reset/
 * checkout/clean per the §3 op list. Facts are deduped by
 * `(op, sha | prNumber | branch)`; `Session.prRefs` never become git facts.
 */
import type { CommandFact, GitFact, ShellSegment, ToolCall } from '../model/types.js';
import type { LedgerContext } from './commands.js';
import { gitSubcommand } from './shell/index.js';

const COMMIT_LINE_RE = /^\[(\S+)(?: \((?:root-commit|detached HEAD)\))? ([0-9a-f]{7,40})\] /gm;
const PUSH_REJECTED_RE = /! \[rejected\]|error: failed to push/;
const PR_URL_RE = /https?:\/\/\S*?\/(?:pull|merge_requests)\/(\d+)/;

/** The host of an explicit URL-ish token (`https://…`, `ssh://…`, `git@host:…`), else `null`. */
export function hostOfToken(token: string): string | null {
  let m = /^(?:https?|ssh|git|ftp):\/\/(?:[^@/\s]+@)?([^/:?#\s]+)/i.exec(token);
  if (m !== null) return (m[1] as string).toLowerCase();
  m = /^(?:[\w.+-]+@)?((?:[\w-]+\.)+[\w-]+):\S/.exec(token);
  if (m !== null) return (m[1] as string).toLowerCase();
  return null;
}

/** The host named by a `To <url>` / `From <url>` line of git output, else `null`. */
export function hostFromOutput(text: string): string | null {
  const m = /^(?:To|From) (\S+)$/m.exec(text);
  if (m === null) return null;
  return hostOfToken(m[1] as string);
}

/** Exit-code tri-state of a segment: `true` on 0, `false` on non-zero, `null` when unknown. */
function segOk(seg: ShellSegment): boolean | null {
  if (seg.exitCode === 0) return true;
  if (seg.exitCode === null) return null;
  return false;
}

function isPrCreateSegment(seg: ShellSegment): boolean {
  if (seg.program === 'gh') return seg.argv[0] === 'pr' && seg.argv[1] === 'create';
  if (seg.program === 'glab') return seg.argv[0] === 'mr' && seg.argv[1] === 'create';
  if (seg.program === 'hub') return seg.argv[0] === 'pull-request';
  return false;
}

/**
 * Extracts the session's `GitFact`s (§4.6.6) in `seq` order. Commit shas
 * come from `ToolCall.gitOperation` (`source:'gitOperation'`), the stdout
 * `[branch sha]` line (`source:'output'`, also for script commands that
 * print one), or a bare exit-0 `git commit` (`sha:null`, rendered "sha not
 * printed"). `pr-created` requires a `gh pr create`/`glab mr create`/`hub
 * pull-request` segment with exit 0 whose stdout carries a `/pull/N` or
 * `/merge_requests/N` URL — `git push`'s "Create a pull request" hint never
 * counts.
 */
export function extractGit(calls: readonly ToolCall[], ctx: LedgerContext, commands: readonly CommandFact[]): GitFact[] {
  void ctx;
  const byId = new Map(commands.map((f) => [f.toolCallId, f]));
  const facts: GitFact[] = [];

  const addFact = (f: GitFact): void => {
    // Dedupe by (op, sha | prNumber | branch); commit shas compare by prefix
    // so a 7-char stdout sha merges with the full `gitOperation` sha.
    if ((f.op === 'commit' || f.op === 'amend') && typeof f.sha === 'string') {
      const sha = f.sha;
      const dup = facts.some(
        (g) => (g.op === 'commit' || g.op === 'amend') && typeof g.sha === 'string' && (g.sha.startsWith(sha) || sha.startsWith(g.sha)),
      );
      if (dup) return;
    } else if (f.op === 'pr-created' && f.prNumber !== undefined) {
      if (facts.some((g) => g.op === 'pr-created' && g.prNumber === f.prNumber)) return;
    } else if (f.branch !== undefined) {
      if (facts.some((g) => g.op === f.op && g.branch === f.branch && g.ok === f.ok)) return;
    }
    facts.push(f);
  };

  for (const call of calls) {
    if (call.gitOperation !== undefined) {
      const amended = call.gitOperation.kind === 'amended';
      addFact({ seq: call.seq, op: amended ? 'amend' : 'commit', ok: true, sha: call.gitOperation.sha, source: 'gitOperation' });
    }
    if (call.denied !== undefined) continue;
    const fact = byId.get(call.id);
    if (fact === undefined) continue;
    const commitMatches = [...call.resultText.matchAll(COMMIT_LINE_RE)];
    let sawCommitSegment = false;
    for (const seg of fact.segments) {
      if (seg.ran === false || seg.ran === 'short-circuited') continue;
      if (isPrCreateSegment(seg)) {
        if (seg.exitCode !== 0) continue;
        const m = PR_URL_RE.exec(call.resultText);
        if (m !== null) addFact({ seq: call.seq, op: 'pr-created', ok: true, prNumber: Number(m[1]), prUrl: m[0], source: 'output' });
        continue;
      }
      if (seg.program !== 'git') continue;
      const sub = gitSubcommand(seg.argv);
      if (sub === null) continue;
      const rest = seg.argv.slice(seg.argv.indexOf(sub) + 1);
      const nonFlag = rest.filter((a) => a !== '--' && !a.startsWith('-'));
      const ok = segOk(seg);
      switch (sub) {
        case 'commit': {
          sawCommitSegment = true;
          const amend = seg.argv.includes('--amend');
          if (commitMatches.length > 0) {
            for (const m of commitMatches) {
              addFact({ seq: call.seq, op: amend ? 'amend' : 'commit', ok: true, sha: m[2] as string, branch: m[1] as string, source: 'output' });
            }
          } else if (call.gitOperation === undefined) {
            addFact({ seq: call.seq, op: amend ? 'amend' : 'commit', ok, sha: null, source: 'command' });
          }
          break;
        }
        case 'push': {
          const force = seg.argv.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'));
          const rejected = PUSH_REJECTED_RE.test(call.resultText);
          const pushOk = rejected ? false : ok;
          const urlTok = seg.argv.find((a) => hostOfToken(a) !== null);
          const host = (urlTok !== undefined ? hostOfToken(urlTok) : null) ?? hostFromOutput(call.resultText);
          const f: GitFact = { seq: call.seq, op: force ? 'force-push' : 'push', ok: pushOk, source: 'command' };
          const names = nonFlag.filter((a) => hostOfToken(a) === null);
          if (names[0] !== undefined) f.remote = names[0];
          if (names[1] !== undefined) f.branch = names[1];
          if (host !== null) f.host = host;
          addFact(f);
          break;
        }
        case 'checkout':
        case 'switch': {
          const bi = seg.argv.findIndex((a) => a === '-b' || a === '-B' || a === '-c');
          const name = bi === -1 ? undefined : seg.argv[bi + 1];
          if (name !== undefined) {
            addFact({ seq: call.seq, op: 'branch', ok, branch: name, source: 'command' });
          } else {
            // `git checkout -- <paths>` reverts files; only tokens before `--` name a ref.
            const dd = rest.indexOf('--');
            const refs = (dd === -1 ? rest : rest.slice(0, dd)).filter((a) => !a.startsWith('-'));
            const f: GitFact = { seq: call.seq, op: 'checkout', ok, source: 'command' };
            if (refs[0] !== undefined) f.branch = refs[0];
            addFact(f);
          }
          break;
        }
        case 'branch': {
          if (nonFlag[0] === undefined) break; // bare list
          addFact({ seq: call.seq, op: 'branch', ok, branch: nonFlag[0], source: 'command' });
          break;
        }
        case 'tag': {
          if (nonFlag[0] === undefined) break;
          addFact({ seq: call.seq, op: 'tag', ok, branch: nonFlag[0], source: 'command' });
          break;
        }
        case 'stash':
          addFact({ seq: call.seq, op: 'stash', ok, source: 'command' });
          break;
        case 'merge': {
          const f: GitFact = { seq: call.seq, op: 'merge', ok, source: 'command' };
          if (nonFlag[0] !== undefined) f.branch = nonFlag[0];
          addFact(f);
          break;
        }
        case 'rebase':
          addFact({ seq: call.seq, op: 'rebase', ok, source: 'command' });
          break;
        case 'reset':
          addFact({ seq: call.seq, op: 'reset', ok, source: 'command' });
          break;
        case 'clean':
          addFact({ seq: call.seq, op: 'clean', ok, source: 'command' });
          break;
        default:
          break;
      }
    }
    // Script commands whose stdout carries `[branch sha]` lines (§4.6.6).
    if (!sawCommitSegment && commitMatches.length > 0 && fact.segments.some((s) => s.family === 'script')) {
      for (const m of commitMatches) {
        addFact({ seq: call.seq, op: 'commit', ok: true, sha: m[2] as string, branch: m[1] as string, source: 'output' });
      }
    }
  }
  return facts;
}
