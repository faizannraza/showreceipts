/**
 * S12 — writes extractor (§4.6.1) over the fixture corpus in
 * `fixtures/ledger-cases/`: tool/patch/shell-inferred/interp-inferred/
 * subagent-list sources, statuses, scopes, reverts, `opaqueWrite` marking and
 * the `filesChanged` eligibility rule. Each case is a synthetic `ToolCall[]`
 * plus a session context and the expected facts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractCommands, type LedgerContext } from '../../../src/ledger/commands.js';
import { extractWrites, filesChangedEligible } from '../../../src/ledger/writes.js';
import type { ToolCall, WriteFact } from '../../../src/model/types.js';

const CASES_DIR = fileURLToPath(new URL('../../../fixtures/ledger-cases/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../../src/ledger/', import.meta.url));

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

function matchAll(got: unknown[], want: unknown[], label: string): void {
  expect(got, label).toHaveLength(want.length);
  want.forEach((w, i) => expect(got[i], `${label}[${i}]`).toMatchObject(w as Record<string, unknown>));
}

const cases = loadCases();

describe('fixtures/ledger-cases — writes (§4.6.1)', () => {
  it('the corpus has at least 30 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  const relevant = cases.filter((c) => 'writes' in c.expect || 'filesChanged' in c.expect || 'opaqueWriteSeqs' in c.expect);

  describe.each(relevant.map((c) => [c.file, c] as const))('%s', (_file, c) => {
    it(c.name, () => {
      const ctx = ctxOf(c);
      const calls = callsOf(c, ctx);
      const commands = extractCommands(calls, ctx);
      const writes = extractWrites(calls, ctx, commands);
      if ('writes' in c.expect) matchAll(writes, c.expect['writes'] as unknown[], 'writes');
      if ('filesChanged' in c.expect) {
        const eligible = [...new Set(writes.filter(filesChangedEligible).map((w) => w.path))].sort();
        expect(eligible).toEqual([...(c.expect['filesChanged'] as string[])].sort());
      }
      if ('opaqueWriteSeqs' in c.expect) {
        expect(commands.filter((f) => f.opaqueWrite === true).map((f) => f.seq)).toEqual(c.expect['opaqueWriteSeqs']);
      }
    });
  });
});

describe('filesChangedEligible (§4.6.1)', () => {
  const base: WriteFact = {
    seq: 1,
    toolCallId: 't1',
    agentId: null,
    path: '/home/u/proj/a.py',
    display: 'a.py',
    verb: 'update',
    source: 'tool',
    status: 'ok',
    resolved: true,
    scope: 'repo',
    isTestFile: false,
    isDoc: false,
  };

  it('accepts ok resolved content writes', () => {
    expect(filesChangedEligible(base)).toBe(true);
  });

  it('excludes failed, unknown, unresolved and metadata-only writes', () => {
    expect(filesChangedEligible({ ...base, status: 'failed' })).toBe(false);
    expect(filesChangedEligible({ ...base, status: 'unknown' })).toBe(false);
    expect(filesChangedEligible({ ...base, resolved: false })).toBe(false);
    expect(filesChangedEligible({ ...base, metadataOnly: true })).toBe(false);
    expect(filesChangedEligible({ ...base, path: '' })).toBe(false);
  });
});

describe('module hygiene (acceptance)', () => {
  it('no extractor imports node:fs/node:os or reads process.env', () => {
    for (const f of ['commands.ts', 'writes.ts', 'git.ts', 'network.ts', 'danger.ts']) {
      const text = readFileSync(`${SRC_DIR}${f}`, 'utf8');
      const code = text
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      expect(code, f).not.toMatch(/node:(?:fs|os)|process\.env/);
    }
  });
});
