/**
 * S06 — tool-call pairing, exit codes and truncation (§4.2.5). Bash exit
 * rules (a)–(j) each with a case; `baseCwd` from the preceding user line +
 * `cwdReset`; `patch` capture for Edit (structuredPatch) and Write update
 * (originalFile vs content) with the 2,000-line cap; `bashWithoutToolUseResult`;
 * unknown tool shape diagnostic; result-text cap ≤ 1 MiB + marker.
 */
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../../src/model/types.js';
import {
  capResultText,
  completeToolCall,
  diffPatch,
  newToolCall,
  patchFromStructured,
  toolKindOf,
  type ToolDiag,
} from '../../../../src/readers/claude-code/tools.js';
import { cc, parseCC } from '../../../helpers/cc-lines.js';

function noopDiag(): { diag: ToolDiag; legacy: string[]; unknown: string[]; bashless: number } {
  const legacy: string[] = [];
  const unknown: string[] = [];
  let bashless = 0;
  const diag: ToolDiag = {
    legacy: (s) => legacy.push(s),
    unknownShape: (t) => unknown.push(t),
    bashWithoutToolUseResult: () => {
      bashless++;
    },
  };
  return {
    diag,
    legacy,
    unknown,
    get bashless() {
      return bashless;
    },
  } as never;
}

function bashCall(): ToolCall {
  return newToolCall({ seq: 1, id: 'tu', tool: 'Bash', input: { command: 'echo hi' }, agentId: null, cwd: '/home/u/proj', startedAt: '2026-02-10T10:00:00Z' });
}

describe('kind mapping', () => {
  it('maps tools to kinds (§4.2.5)', () => {
    expect(toolKindOf('Bash')).toBe('shell');
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('MultiEdit')).toBe('edit');
    expect(toolKindOf('Write')).toBe('write');
    expect(toolKindOf('Read')).toBe('read');
    expect(toolKindOf('Grep')).toBe('search');
    expect(toolKindOf('WebFetch')).toBe('fetch');
    expect(toolKindOf('Workflow')).toBe('agent');
    expect(toolKindOf('SendMessage')).toBe('task');
    expect(toolKindOf('mcp__example_server__create_draft')).toBe('mcp');
    expect(toolKindOf('Something')).toBe('other');
  });
});

describe('Bash exit rules (a)–(j)', () => {
  const D = noopDiag();

  it('(a) toolUseResult string "Error: Exit code N" → harness exit N', () => {
    const call = bashCall();
    completeToolCall(
      call,
      { ts: 't', content: 'Error: Exit code 7\nx', isError: true, hasToolUseResult: true, toolUseResult: 'Error: Exit code 7\nx', toolDenialKind: undefined },
      D.diag,
    );
    expect(call.exitCode).toBe(7);
    expect(call.exitCodeSource).toBe('harness');
    expect(call.denied).toBeUndefined();
  });

  it('(b) denial strings and toolDenialKind → denied, never a run', () => {
    for (const [text, kind] of [
      ['Error: Permission for this action was denied…', undefined],
      ['User rejected tool use', undefined],
      ["Error: The user doesn't want to proceed", undefined],
      ['Error: Blocked: sleep 5 followed by: rm', undefined],
      ['InputValidationError: [x]', undefined],
    ] as const) {
      const call = bashCall();
      completeToolCall(call, { ts: 't', content: text, isError: true, hasToolUseResult: true, toolUseResult: text, toolDenialKind: kind }, D.diag);
      expect(call.exitCode).toBeNull();
      expect(call.exitCodeSource).toBe('unknown');
      expect(call.denied).toBeDefined();
    }
    const withKind = bashCall();
    completeToolCall(
      withKind,
      { ts: 't', content: 'nope', isError: true, hasToolUseResult: true, toolUseResult: 'nope', toolDenialKind: 'permission-rule' },
      D.diag,
    );
    expect(withKind.denied).toBe('permission-rule');
  });

  it('(b) sandbox-denied and unknown toolDenialKind values are denials too, never runs', () => {
    const sandbox = bashCall();
    completeToolCall(
      sandbox,
      { ts: 't', content: 'nope', isError: true, hasToolUseResult: true, toolUseResult: 'nope', toolDenialKind: 'sandbox-denied' },
      D.diag,
    );
    expect(sandbox.denied).toBe('sandbox-denied');
    expect(sandbox.exitCode).toBeNull();
    expect(sandbox.exitCodeSource).toBe('unknown');
    const future = bashCall();
    completeToolCall(
      future,
      { ts: 't', content: 'nope', isError: true, hasToolUseResult: true, toolUseResult: 'nope', toolDenialKind: 'some-future-kind' },
      D.diag,
    );
    expect(future.denied).toBe('tool_use_error');
    expect(future.exitCode).toBeNull();
  });

  it('(c) returnCodeInterpretation → exitCode null, interpreted, interpretation kept', () => {
    const call = bashCall();
    const result = { stdout: '', stderr: '', interrupted: false, isImage: false, returnCodeInterpretation: 'No matches found' };
    completeToolCall(call, { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: result, toolDenialKind: undefined }, D.diag);
    expect(call.exitCode).toBeNull();
    expect(call.exitCodeSource).toBe('interpreted');
    expect(call.interpretation).toBe('No matches found');
  });

  it('(d) backgroundTaskId and timedOutAfterMs → background, exit null', () => {
    const bg = bashCall();
    completeToolCall(
      bg,
      { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'bg-1' }, toolDenialKind: undefined },
      D.diag,
    );
    expect(bg.background).toBe(true);
    expect(bg.backgroundTaskId).toBe('bg-1');
    expect(bg.exitCode).toBeNull();
    const to = bashCall();
    completeToolCall(
      to,
      { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: { stdout: '', stderr: '', timedOutAfterMs: 5000 }, toolDenialKind: undefined },
      D.diag,
    );
    expect(to.background).toBe(true);
    expect(to.timedOutAfterMs).toBe(5000);
  });

  it('(e) interrupted:true → interrupted, exit null', () => {
    const call = bashCall();
    completeToolCall(
      call,
      { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: { stdout: '', stderr: '', interrupted: true }, toolDenialKind: undefined },
      D.diag,
    );
    expect(call.interrupted).toBe(true);
    expect(call.exitCode).toBeNull();
  });

  it('(f) toolUseResult absent → content source + bashWithoutToolUseResult', () => {
    const legacy: string[] = [];
    const unknown: string[] = [];
    let bashless = 0;
    const diag: ToolDiag = { legacy: (s) => legacy.push(s), unknownShape: (t) => unknown.push(t), bashWithoutToolUseResult: () => (bashless += 1) };
    const ok = bashCall();
    completeToolCall(ok, { ts: 't', content: 'all good', isError: false, hasToolUseResult: false, toolUseResult: undefined, toolDenialKind: undefined }, diag);
    expect(ok.exitCode).toBe(0);
    expect(ok.exitCodeSource).toBe('content');
    const bad = bashCall();
    completeToolCall(bad, { ts: 't', content: 'Exit code 5\n…', isError: true, hasToolUseResult: false, toolUseResult: undefined, toolDenialKind: undefined }, diag);
    expect(bad.exitCode).toBe(5);
    expect(bad.exitCodeSource).toBe('content');
    expect(bashless).toBe(2);
  });

  it('(g) plain success object → exit 0, harness', () => {
    const call = bashCall();
    completeToolCall(
      call,
      { ts: 't', content: 'hi', isError: false, hasToolUseResult: true, toolUseResult: { stdout: 'hi', stderr: '', interrupted: false, isImage: false }, toolDenialKind: undefined },
      D.diag,
    );
    expect(call.exitCode).toBe(0);
    expect(call.exitCodeSource).toBe('harness');
  });

  it('(h) persistedOutputPath → truncated:persisted + persistedBytes', () => {
    const call = bashCall();
    completeToolCall(
      call,
      {
        ts: 't',
        content: 'head',
        isError: false,
        hasToolUseResult: true,
        toolUseResult: { stdout: 'head', stderr: '', persistedOutputPath: '/x/tool-results/o.txt', persistedOutputSize: 322000 },
        toolDenialKind: undefined,
      },
      D.diag,
    );
    expect(call.truncated).toBe('persisted');
    expect(call.persistedBytes).toBe(322000);
  });

  it('(i) gitOperation.commit → ToolCall.gitOperation (S12 builds the GitFact)', () => {
    const call = bashCall();
    completeToolCall(
      call,
      { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: { stdout: '', stderr: '', gitOperation: { commit: { sha: 'abc1234', kind: 'amended' } } }, toolDenialKind: undefined },
      D.diag,
    );
    expect(call.gitOperation).toEqual({ sha: 'abc1234', kind: 'amended' });
    expect(call.exitCode).toBe(0);
  });

  it('(j) dangerouslyDisableSandbox:true on input → sandboxDisabled', () => {
    const call = newToolCall({ seq: 1, id: 'tu', tool: 'Bash', input: { command: 'x', dangerouslyDisableSandbox: true }, agentId: null, cwd: '/p', startedAt: 't' });
    expect(call.sandboxDisabled).toBe(true);
  });

  it('strips the "Shell cwd was reset to" trailer and records cwdReset', () => {
    const call = bashCall();
    completeToolCall(
      call,
      { ts: 't', content: 'out', isError: false, hasToolUseResult: true, toolUseResult: { stdout: 'out', stderr: 'warn\nShell cwd was reset to /home/u', interrupted: false }, toolDenialKind: undefined },
      D.diag,
    );
    expect(call.cwdReset).toBe('/home/u');
  });

  it('an unknown Bash shape increments the diagnostic', () => {
    const unknown: string[] = [];
    const diag: ToolDiag = { legacy: () => {}, unknownShape: (t) => unknown.push(t), bashWithoutToolUseResult: () => {} };
    const call = bashCall();
    completeToolCall(call, { ts: 't', content: '', isError: false, hasToolUseResult: true, toolUseResult: { weird: 1 }, toolDenialKind: undefined }, diag);
    expect(unknown).toContain('Bash');
  });
});

describe('patch capture', () => {
  it('Edit structuredPatch → +/- lines and hunk count', () => {
    const patch = patchFromStructured([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new', ' ctx'] }]);
    expect(patch).toEqual({ added: ['new'], removed: ['old'], hunks: 1 });
  });

  it('Write update without a patch → diff of originalFile vs content', () => {
    const patch = diffPatch('a\nb\nc\n', 'a\nB\nc\n');
    expect(patch).toEqual({ added: ['B'], removed: ['b'], hunks: 1 });
    expect(diffPatch('same\n', 'same\n')).toBeNull();
  });

  it('caps a patch at 2,000 lines and flags truncation', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `+line ${i}`);
    const patch = patchFromStructured([{ lines }]);
    expect(patch?.truncated).toBe(true);
    expect((patch?.added.length ?? 0) + (patch?.removed.length ?? 0)).toBeLessThanOrEqual(2000);
  });

  it('Edit result seeds filesTouched, userModified and patch through the reader', async () => {
    const t = cc();
    t.human('edit it', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-e', name: 'Edit', input: { file_path: '/home/u/proj/a.py' } }], stop: 'tool_use', usage: null });
    t.toolResult('tu-e', 'ok', {
      promptId: 'p1',
      result: {
        filePath: '/home/u/proj/a.py',
        oldString: 'x',
        newString: 'y',
        originalFile: 'x\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
        userModified: true,
      },
    });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const s = await parseCC(t);
    const call = s.toolCalls.find((c) => c.id === 'tu-e');
    expect(call?.filesTouched).toEqual(['/home/u/proj/a.py']);
    expect(call?.userModified).toBe(true);
    expect(call?.patch).toEqual({ added: ['y'], removed: ['x'], hunks: 1 });
    // No file body is ever retained.
    expect(JSON.stringify(call)).not.toContain('originalFile');
  });
});

describe('resultText cap (≤ 1 MiB + marker)', () => {
  it('leaves a small text intact', () => {
    expect(capResultText('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('a >1 MiB text becomes head…tail and is flagged', () => {
    const big = 'a'.repeat((1 << 20) + 1000);
    const { text, truncated } = capResultText(big);
    expect(truncated).toBe(true);
    expect(text.includes('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual((1 << 20) + 1);
  });

  it('a multibyte text within the code-unit cap is kept whole, never lengthened by overlap', () => {
    const s = 'é'.repeat((1 << 20) - 8); // ≤ 1 Mi code units, ≈ 2 MiB of UTF-8
    expect(Buffer.byteLength(s, 'utf8')).toBeGreaterThan(1 << 20);
    const r = capResultText(s);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(s);
  });
});

describe('baseCwd (§4.5.3)', () => {
  it('uses the preceding user line cwd, never the assistant line cwd', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1', cwd: '/home/u/proj' });
    // Assistant line stamped with a post-execution cwd; the call must ignore it.
    t.assistant({ tools: [{ id: 'tu-b', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use', usage: null, cwd: '/somewhere/else' });
    t.toolResult('tu-b', 'ok', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const s = await parseCC(t);
    expect(s.toolCalls.find((c) => c.id === 'tu-b')?.cwd).toBe('/home/u/proj');
  });
});

describe('pairing edge cases', () => {
  it('an unmatched tool_use ends with endedAt null and a no-result note', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-x', name: 'Bash', input: { command: 'sleep 1' } }], stop: 'tool_use', usage: null });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const s = await parseCC(t);
    const call = s.toolCalls.find((c) => c.id === 'tu-x');
    expect(call?.endedAt).toBeNull();
    expect(call?.exitCodeSource).toBe('unknown');
    expect(s.diagnostics.notes.some((n) => n.includes('no-result'))).toBe(true);
  });

  it('a second tool_result for a resolved id is dropped (duplicateToolResults)', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-d', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use', usage: null });
    t.toolResult('tu-d', 'first', { promptId: 'p1' });
    t.toolResult('tu-d', 'second', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', text: 'done' });
    const s = await parseCC(t);
    expect(s.diagnostics.duplicateToolResults).toBe(1);
    expect(s.toolCalls.find((c) => c.id === 'tu-d')?.resultText).toBe('first');
  });
});
