/**
 * S12 — danger flags and secrets (§4.6.8): rm -rf tiers, destructive git,
 * force pushes, pipe-to-shell, sudo/chmod, secret reads/writes/commits,
 * sandbox flags and amend-after-push, over `fixtures/ledger-cases/`.
 * Details never carry output bodies and stay within 120 characters.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractCommands, type LedgerContext } from '../../../src/ledger/commands.js';
import { extractDanger, isSecretPath } from '../../../src/ledger/danger.js';
import { extractGit } from '../../../src/ledger/git.js';
import { extractWrites } from '../../../src/ledger/writes.js';
import type { DangerFlag, ToolCall } from '../../../src/model/types.js';

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

function runCase(c: LedgerCase): DangerFlag[] {
  const ctx = ctxOf(c);
  const calls = callsOf(c, ctx);
  const commands = extractCommands(calls, ctx);
  const writes = extractWrites(calls, ctx, commands);
  const git = extractGit(calls, ctx, commands);
  return extractDanger(calls, ctx, commands, writes, git);
}

describe('fixtures/ledger-cases — danger (§4.6.8)', () => {
  const relevant = loadCases().filter((c) => 'danger' in c.expect);

  describe.each(relevant.map((c) => [c.file, c] as const))('%s', (_file, c) => {
    it(c.name, () => {
      const danger = runCase(c);
      const want = c.expect['danger'] as Record<string, unknown>[];
      expect(danger, 'danger').toHaveLength(want.length);
      want.forEach((w, i) => expect(danger[i], `danger[${i}]`).toMatchObject(w));
    });
  });

  it('details are sanitised, capped at 120 chars and never carry output bodies', () => {
    const longPath = `/home/u/proj/${'d'.repeat(200)}/x.txt`;
    const c: LedgerCase = {
      file: 'inline',
      name: 'detail cap',
      calls: [{ command: `rm -rf ${longPath}`, resultText: 'SECRET-OUTPUT-BODY should never appear in details' }],
      expect: {},
    };
    const danger = runCase(c);
    expect(danger.length).toBeGreaterThan(0);
    for (const flag of danger) {
      expect(flag.detail.length).toBeLessThanOrEqual(120);
      expect(flag.detail).not.toContain('SECRET-OUTPUT-BODY');
      expect(flag.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});

describe('isSecretPath (§4.6.8)', () => {
  it('matches the secret patterns on file operands', () => {
    expect(isSecretPath('.env')).toBe(true);
    expect(isSecretPath('config/.env.production')).toBe(true);
    expect(isSecretPath('/home/u/.ssh/id_ed25519')).toBe(true);
    expect(isSecretPath('deploy.pem')).toBe(true);
    expect(isSecretPath('~/.aws/credentials')).toBe(true);
    expect(isSecretPath('/home/u/.config/gh/hosts.yml')).toBe(true);
    expect(isSecretPath('.npmrc')).toBe(true);
  });

  it('excludes .env.example/.env.sample/.env.template and plain files', () => {
    expect(isSecretPath('.env.example')).toBe(false);
    expect(isSecretPath('.env.sample')).toBe(false);
    expect(isSecretPath('.env.template')).toBe(false);
    expect(isSecretPath('src/environment.ts')).toBe(false);
    expect(isSecretPath('README.md')).toBe(false);
  });
});
