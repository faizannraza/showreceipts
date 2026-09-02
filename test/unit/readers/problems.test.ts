/**
 * S10: `coreShapeProblems` (§12.2 exit 4, per-session items). Healthy
 * sessions — every committed fixture is asserted in the goldens suite —
 * return `[]`; each of the four core-shape breakages is named.
 */
import { describe, expect, it } from 'vitest';
import { readCodexSession } from '../../../src/readers/codex/reader.js';
import { coreShapeProblems } from '../../../src/readers/problems.js';
import { cc, parseCC, usage } from '../../helpers/cc-lines.js';
import { agentMessage, codexRef, fnCall, fnOut, rollout, sessionMeta, TEST_HOME, turnContext, unifiedOutput, userMessage } from '../../helpers/codex-lines.js';

describe('coreShapeProblems', () => {
  it('returns [] for a healthy Claude Code session', async () => {
    const t = cc();
    t.human('do the thing', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use' });
    t.toolResult('tu1', 'ok');
    t.assistant({ text: 'Done.' });
    const s = await parseCC(t);
    expect(coreShapeProblems(s)).toEqual([]);
  });

  it('names a Bash toolUseResult that is neither a string nor {stdout, stderr}', async () => {
    const t = cc();
    t.human('run it', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use' });
    t.toolResult('tu1', 'ok', { result: { weird: true } }); // no stdout/stderr
    t.assistant({ text: 'Done.' });
    const s = await parseCC(t);
    expect(s.diagnostics.unknownToolShapes['Bash']).toBe(1);
    const problems = coreShapeProblems(s);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('1 Bash toolUseResult(s) neither a string nor an object with stdout+stderr');
  });

  it('names Edit and Write result objects without filePath', async () => {
    const t = cc();
    t.human('edit it', { promptId: 'p1' });
    t.assistant({
      tools: [
        { id: 'tu-e', name: 'Edit', input: { file_path: '/home/u/proj/a.py' } },
        { id: 'tu-w', name: 'Write', input: { file_path: '/home/u/proj/b.py' } },
      ],
      stop: 'tool_use',
    });
    t.toolResult('tu-e', 'edited', { result: { oldString: 'a', newString: 'b' } }); // no filePath
    t.toolResult('tu-w', 'written', { result: { type: 'create', content: 'x' } }); // no filePath
    t.assistant({ text: 'Done.' });
    const s = await parseCC(t);
    const problems = coreShapeProblems(s);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('2 Edit/Write toolUseResult object(s) without filePath');
  });

  it('names assistant lines without message.model / message.usage', async () => {
    const t = cc();
    t.human('hello', { promptId: 'p1' });
    // No model at all.
    t.raw({
      type: 'assistant',
      uuid: 'raw-1',
      parentUuid: t.last(),
      timestamp: t.nextTs(),
      sessionId: t.sid,
      message: { id: 'msg-raw-1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: usage() },
    });
    // Model present, usage missing.
    t.raw({
      type: 'assistant',
      uuid: 'raw-2',
      parentUuid: 'raw-1',
      timestamp: t.nextTs(),
      sessionId: t.sid,
      message: { id: 'msg-raw-2', role: 'assistant', model: 'claude-test-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
    });
    const s = await parseCC(t);
    const problems = coreShapeProblems(s);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('2 assistant line(s) without message.model/message.usage');
  });

  it('never counts <synthetic> / API-error lines as broken assistant shapes', async () => {
    const t = cc();
    t.human('hello', { promptId: 'p1' });
    t.assistant({ model: '<synthetic>', stop: 'stop_sequence', text: 'error text', usage: null });
    t.assistant({ text: 'recovered' });
    const s = await parseCC(t);
    expect(coreShapeProblems(s)).toEqual([]);
  });

  it('names an unparseable Codex function_call_output header', async () => {
    const lines = [
      sessionMeta(),
      turnContext(),
      userMessage('run something'),
      fnCall('exec_command', { cmd: 'ls' }, 'c1'),
      fnOut('c1', 'mystery output that matches no known grammar'),
      agentMessage('Done.'),
    ];
    const { session } = await readCodexSession(codexRef(), { lines: rollout(lines), home: TEST_HOME });
    expect(session.diagnostics.unknownCodexPayloads['output:exec_command']).toBe(1);
    const problems = coreShapeProblems(session);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('1 unparseable Codex function_call_output header(s) (exec_command)');
  });

  it('returns [] for a healthy Codex session', async () => {
    const lines = [
      sessionMeta(),
      turnContext(),
      userMessage('run something'),
      fnCall('exec_command', { cmd: 'ls' }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 0, body: 'ok' })),
      agentMessage('Done.'),
    ];
    const { session } = await readCodexSession(codexRef(), { lines: rollout(lines), home: TEST_HOME });
    expect(coreShapeProblems(session)).toEqual([]);
  });

  it('reports several problem classes at once, one line each', async () => {
    const t = cc();
    t.human('multi', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use' });
    t.toolResult('tu1', 'ok', { result: { nope: 1 } });
    t.raw({
      type: 'assistant',
      uuid: 'raw-1',
      parentUuid: t.last(),
      timestamp: t.nextTs(),
      sessionId: t.sid,
      message: { id: 'msg-raw-1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: usage() },
    });
    const s = await parseCC(t);
    const problems = coreShapeProblems(s);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes('Bash'))).toBe(true);
    expect(problems.some((p) => p.includes('assistant'))).toBe(true);
  });
});
