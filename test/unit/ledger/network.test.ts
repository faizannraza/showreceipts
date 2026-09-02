/**
 * S12 — network facts (§4.6.7): registry inference, git hosts, curl/wget
 * URLs, tool-input URLs (fetch/browser), the private-host drop list and the
 * Codex network-off sandbox note, over `fixtures/ledger-cases/`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractCommands, type LedgerContext } from '../../../src/ledger/commands.js';
import { extractNetwork } from '../../../src/ledger/network.js';
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

function runCase(c: LedgerCase): ReturnType<typeof extractNetwork> {
  const ctx = ctxOf(c);
  const calls = callsOf(c, ctx);
  return extractNetwork(calls, ctx, extractCommands(calls, ctx));
}

describe('fixtures/ledger-cases — network (§4.6.7)', () => {
  const relevant = loadCases().filter((c) => 'network' in c.expect);

  describe.each(relevant.map((c) => [c.file, c] as const))('%s', (_file, c) => {
    it(c.name, () => {
      const network = runCase(c);
      const want = c.expect['network'] as Record<string, unknown>[];
      expect(network, 'network').toHaveLength(want.length);
      want.forEach((w, i) => expect(network[i], `network[${i}]`).toMatchObject(w));
    });
  });
});

describe('host drop list (§4.6.7)', () => {
  it('drops loopback, link-local, RFC1918 and *.local hosts from curl URLs', () => {
    const c: LedgerCase = {
      file: 'inline',
      name: 'drop list',
      calls: [
        {
          command:
            'curl http://172.20.1.2/x http://10.0.0.9/y http://169.254.0.1/z https://printer.local/a https://dev.localhost/b https://ok.example.net/c',
        },
      ],
      expect: {},
    };
    const network = runCase(c);
    expect(network.map((f) => f.host)).toEqual(['ok.example.net']);
  });

  it('172.32.x is public and kept', () => {
    const c: LedgerCase = { file: 'inline', name: 'boundary', calls: [{ command: 'curl http://172.32.0.1/x' }], expect: {} };
    expect(runCase(c).map((f) => f.host)).toEqual(['172.32.0.1']);
  });
});
