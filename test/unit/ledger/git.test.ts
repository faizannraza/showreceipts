/**
 * S12 — git facts (§4.6.6): commit sources and prefix dedupe, push
 * rejection and hosts, force-push, PR creation gating, branch/tag/stash
 * ops, over the `fixtures/ledger-cases/` corpus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractCommands, type LedgerContext } from '../../../src/ledger/commands.js';
import { extractGit, hostFromOutput, hostOfToken } from '../../../src/ledger/git.js';
import type { ToolCall } from '../../../src/model/types.js';

const CASES_DIR = fileURLToPath(new URL('../../../fixtures/ledger-cases/', import.meta.url));

interface CaseContext {
  cwd?: string;
  cwds?: string[];
  repoRoot?: string | null;
  home?: string;
  tmpRoots?: string[];
  repoRoots?: Record<string, string>;
  sandbox?: { type: string; writableRoots: string[]; networkAccess: boolean };
  harness?: LedgerContext['harness'];
}
interface LedgerCase {
  file: string;
  name: string;
  context?: CaseContext;
  calls: Record<string, unknown>[];
  expect: Record<string, unknown>;
}

const KIND_BY_TOOL: Record<string, ToolCall['kind']> = {
  Bash: 'shell',
  exec_command: 'shell',
  shell_command: 'shell',
  local_shell_call: 'shell',
  write_stdin: 'shell',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  apply_patch: 'edit',
  Write: 'write',
  Read: 'read',
  WebFetch: 'fetch',
  'subagent-stop': 'agent',
};

function loadCases(): LedgerCase[] {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ ...(JSON.parse(readFileSync(`${CASES_DIR}${f}`, 'utf8')) as Omit<LedgerCase, 'file'>), file: f }));
}

function ctxOf(c: LedgerCase): LedgerContext {
  const cc = c.context ?? {};
  const home = cc.home ?? '/home/u';
  const cwd = cc.cwd ?? '/home/u/proj';
  const repoRoot = cc.repoRoot === undefined ? '/home/u/proj' : cc.repoRoot;
  const roots = cc.repoRoots ?? {};
  const ctx: LedgerContext = {
    cwd,
    cwds: cc.cwds ?? [cwd],
    repoRoot,
    repoRootOf: (p) => {
      for (const [k, v] of Object.entries(roots)) if (p === k || p.startsWith(`${k}/`)) return v;
      if (repoRoot !== null && (p === repoRoot || p.startsWith(`${repoRoot}/`))) return repoRoot;
      return null;
    },
    home,
    tmpRoots: cc.tmpRoots ?? ['/tmp', '/private/tmp', '/var/folders'],
    harness: cc.harness ?? 'claude-code',
  };
  if (cc.sandbox !== undefined) ctx.sandbox = cc.sandbox;
  return ctx;
}

function callsOf(c: LedgerCase, ctx: LedgerContext): ToolCall[] {
  return c.calls.map((raw, i) => {
    const tool = (raw['tool'] as string | undefined) ?? 'Bash';
    const exitCode = raw['exitCode'] === undefined ? (raw['command'] !== undefined ? 0 : null) : (raw['exitCode'] as number | null);
    const call: ToolCall = {
      seq: (raw['seq'] as number | undefined) ?? i + 1,
      id: (raw['id'] as string | undefined) ?? `t${i + 1}`,
      tool,
      kind: (raw['kind'] as ToolCall['kind'] | undefined) ?? KIND_BY_TOOL[tool] ?? 'other',
      agentId: (raw['agentId'] as string | null | undefined) ?? null,
      turnIndex: 0,
      cwd: (raw['cwd'] as string | undefined) ?? ctx.cwd,
      input: (raw['input'] as Record<string, unknown> | undefined) ?? {},
      resultText: (raw['resultText'] as string | undefined) ?? '',
      resultBytes: 0,
      isError: (raw['isError'] as boolean | undefined) ?? false,
      exitCode,
      exitCodeSource: (raw['exitCodeSource'] as ToolCall['exitCodeSource'] | undefined) ?? (exitCode === null ? 'unknown' : 'harness'),
      interrupted: (raw['interrupted'] as boolean | undefined) ?? false,
      background: (raw['background'] as boolean | undefined) ?? false,
      startedAt: '2026-03-01T00:00:00Z',
      endedAt: null,
      filesTouched: (raw['filesTouched'] as string[] | undefined) ?? [],
    };
    for (const key of ['command', 'denied', 'created', 'userModified', 'patch', 'gitOperation', 'stdinWrite', 'sandboxDisabled', 'attempted', 'durationMs', 'mayRunTests'] as const) {
      if (raw[key] !== undefined) (call as unknown as Record<string, unknown>)[key] = raw[key];
    }
    return call;
  });
}

describe('fixtures/ledger-cases — git (§4.6.6)', () => {
  const relevant = loadCases().filter((c) => 'git' in c.expect);

  describe.each(relevant.map((c) => [c.file, c] as const))('%s', (_file, c) => {
    it(c.name, () => {
      const ctx = ctxOf(c);
      const calls = callsOf(c, ctx);
      const commands = extractCommands(calls, ctx);
      const git = extractGit(calls, ctx, commands);
      const want = c.expect['git'] as Record<string, unknown>[];
      expect(git, 'git').toHaveLength(want.length);
      want.forEach((w, i) => expect(git[i], `git[${i}]`).toMatchObject(w));
    });
  });
});

describe('host parsing (§4.6.6)', () => {
  it('parses https, ssh and scp-like URLs', () => {
    expect(hostOfToken('https://github.com/u/r.git')).toBe('github.com');
    expect(hostOfToken('ssh://git@GitLab.example.io/u/r.git')).toBe('gitlab.example.io');
    expect(hostOfToken('git@github.com:u/r.git')).toBe('github.com');
    expect(hostOfToken('origin')).toBeNull();
    expect(hostOfToken('main')).toBeNull();
  });

  it('reads To/From lines from git output only at line start', () => {
    expect(hostFromOutput('To github.com:u/r.git\n')).toBe('github.com');
    expect(hostFromOutput('From https://gitea.example.net/u/r\n')).toBe('gitea.example.net');
    expect(hostFromOutput('nothing here')).toBeNull();
  });
});
