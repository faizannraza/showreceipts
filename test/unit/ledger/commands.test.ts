/**
 * S12 — command facts (§4.6.2): every non-`stdinWrite` shell call becomes a
 * `CommandFact` with S11 segments, attributed exits, chain/background flags
 * and the harness duration; `mayRunTests` bubbles up from the segments.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractCommands, type LedgerContext } from '../../../src/ledger/commands.js';
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

describe('fixtures/ledger-cases — commands (§4.6.2)', () => {
  const relevant = loadCases().filter((c) => 'commands' in c.expect);

  describe.each(relevant.map((c) => [c.file, c] as const))('%s', (_file, c) => {
    it(c.name, () => {
      const ctx = ctxOf(c);
      const commands = extractCommands(callsOf(c, ctx), ctx);
      const want = c.expect['commands'] as Record<string, unknown>[];
      expect(commands).toHaveLength(want.length);
      want.forEach((w, i) => {
        const { segmentPrograms, ...rest } = w;
        expect(commands[i], `commands[${i}]`).toMatchObject(rest);
        if (segmentPrograms !== undefined) {
          expect(commands[i]?.segments.map((s) => s.program)).toEqual(segmentPrograms);
        }
      });
    });
  });
});

describe('extractCommands directly', () => {
  const ctx = ctxOf({ file: '', name: '', calls: [], expect: {} });

  function shellCall(command: string, overrides: Partial<ToolCall> = {}): ToolCall {
    return {
      seq: 1,
      id: 't1',
      tool: 'Bash',
      kind: 'shell',
      agentId: null,
      turnIndex: 0,
      cwd: ctx.cwd,
      input: {},
      command,
      resultText: '',
      resultBytes: 0,
      isError: false,
      exitCode: 0,
      exitCodeSource: 'harness',
      interrupted: false,
      background: false,
      startedAt: '2026-03-01T00:00:00Z',
      endedAt: null,
      filesTouched: [],
      ...overrides,
    };
  }

  it('skips non-shell kinds and empty commands', () => {
    const edit = shellCall('x', { kind: 'edit', tool: 'Edit' });
    delete (edit as { command?: string }).command;
    expect(extractCommands([edit, shellCall('   ')], ctx)).toEqual([]);
  });

  it('a trailing & is background with unknown segment exits', () => {
    const facts = extractCommands([shellCall('python serve.py &', { exitCode: 0 })], ctx);
    expect(facts[0]?.background).toBe(true);
    expect(facts[0]?.segments[0]?.ran).toBe('background');
  });

  it('marks mayRunTests from a script segment hint', () => {
    const facts = extractCommands([shellCall('./scripts/run_tests.sh')], ctx);
    expect(facts[0]?.mayRunTests).toBe(true);
  });

  it('attributes the harness exit across a && chain (no signature ⇒ nothing fabricated)', () => {
    const facts = extractCommands([shellCall('cd site && npm run build', { exitCode: 1 })], ctx);
    expect(facts[0]?.chained).toBe(true);
    expect(facts[0]?.exitCode).toBe(1); // the harness exit stays on the CommandFact
    // §4.5.5: without an output signature the failing unit is unknown — no
    // fabricated exit 0 for `cd`, no fabricated exit 1 for the build, and the
    // unproven check segment is short-circuited.
    expect(facts[0]?.segments[0]?.exitCode).toBeNull();
    expect(facts[0]?.segments[0]?.ran).toBe(true);
    expect(facts[0]?.segments[1]?.exitCode).toBeNull();
    expect(facts[0]?.segments[1]?.ran).toBe('short-circuited');
  });

  it('attributes the harness exit across a && chain when a signature pins the failure', () => {
    const facts = extractCommands([shellCall('cd site && npm run build', { exitCode: 1, resultText: 'src/x.ts(3,1): error TS2322: nope' })], ctx);
    expect(facts[0]?.segments[0]?.exitCode).toBe(0);
    expect(facts[0]?.segments[1]?.exitCode).toBe(1);
  });
});
