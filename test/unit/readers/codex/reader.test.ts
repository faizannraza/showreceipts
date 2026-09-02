/**
 * S08: `readCodexSession` behaviour over synthetic rollouts built with the
 * `codex-lines` DSL — session skeleton, turn boundaries and finals, tool
 * calls, stdin back-fill, patches, token deltas and the privacy guarantees
 * (§4.3.1–4.3.5).
 */
import { describe, expect, it } from 'vitest';
import type { Session, SessionRef } from '../../../../src/model/types.js';
import { codexToolKind, commandTextOf, readCodexSession } from '../../../../src/readers/codex/reader.js';
import {
  agentMessage,
  agentReasoning,
  assistantItem,
  codexRef,
  customPatchCall,
  customPatchOut,
  developerItem,
  fnCall,
  fnOut,
  jsonOutput,
  line,
  reasoningItem,
  rollout,
  sessionMeta,
  TEST_HOME,
  TEST_SESSION_ID,
  tokenCount,
  tsAt,
  turnContext,
  unifiedOutput,
  userItem,
  userMessage,
} from '../../../helpers/codex-lines.js';

async function read(lines: readonly string[], over: Partial<SessionRef> = {}): Promise<Session> {
  const { session } = await readCodexSession(codexRef(TEST_SESSION_ID, over), { lines: rollout(lines), home: TEST_HOME });
  return session;
}

describe('session skeleton (§4.3.1)', () => {
  it('builds the session-level fields from session_meta and turn_context', async () => {
    const s = await read(
      [
        sessionMeta({ timestamp: '2026-03-02T09:59:59.000Z' }, tsAt(0)),
        turnContext({}, tsAt(100)),
        userMessage('hello', tsAt(200)),
        tokenCount({ input: 10, cached: 4, output: 2 }, { ratePct: 3 }, tsAt(300)),
        agentMessage('done', tsAt(400)),
      ],
      { title: 'Thread one' },
    );
    expect(s.harness).toBe('codex');
    expect(s.harnessVersion).toBe('0.98.0');
    expect(s.harnessVersions).toEqual(['0.98.0']);
    expect(s.sessionId).toBe(TEST_SESSION_ID);
    expect(s.shortId).toBe('9e0f1a2b'); // UUIDv7 → last 8 hex
    expect(s.source).toBe('transcript');
    expect(s.originator).toBe('codex_cli_rs');
    expect(s.subagent).toBeUndefined();
    expect(s.cwd).toBe('/home/u/proj');
    expect(s.cwds).toEqual(['/home/u/proj']);
    expect(s.repoRoot).toBeNull();
    expect(s.gitBranch).toBeNull();
    expect(s.title).toBe('Thread one');
    expect(s.models).toEqual(['gpt-5.2-codex']);
    expect(s.primaryModel).toBe('gpt-5.2-codex');
    expect(s.sandbox).toEqual({ type: 'workspace-write', writableRoots: ['/home/u/proj'], networkAccess: false });
    expect(s.startedAt).toBe('2026-03-02T09:59:59.000Z'); // session_meta.timestamp, not the line timestamp
    expect(s.endedAt).toBe(tsAt(400)); // last record timestamp
    expect(s.durationMs).toBe(Date.parse(tsAt(400)) - Date.parse('2026-03-02T09:59:59.000Z'));
    expect(s.kind).toBe('normal');
    expect(s.records).toBe(5);
    expect(s.spansDays).toBe(1);
    expect(s.activeMs).toBeNull();
    expect(s.cost.planUsagePct).toBe(3);
    expect(s.usageRows).toEqual([]);
    expect(s.diagnostics.badLines).toBe(0);
  });

  it('marks a rollout whose session_meta.source is an object as a subagent', async () => {
    const s = await read([sessionMeta({ source: { type: 'subagent', parent_id: 'p1' } }), userMessage('x'), agentMessage('y')]);
    expect(s.subagent).toBe(true);
  });

  it('keeps the first session_meta and notes a second one', async () => {
    const s = await read([
      sessionMeta({ cli_version: '0.98.0' }),
      sessionMeta({ cli_version: '0.99.0', timestamp: '2026-03-03T00:00:00.000Z' }),
      userMessage('x'),
    ]);
    expect(s.harnessVersion).toBe('0.98.0');
    expect(s.diagnostics.notes).toContain('codex: second session_meta ignored (first session id wins)');
  });

  it('reads git_branch when a dialect provides it', async () => {
    const s = await read([sessionMeta({ git_branch: 'main' }), turnContext({ git_branch: 'feat/x' })]);
    expect(s.gitBranch).toBe('feat/x');
  });

  it('classifies empty and turn-less files', async () => {
    const empty = await read([]);
    expect(empty.kind).toBe('empty');
    expect(empty.records).toBe(0);
    expect(empty.spansDays).toBe(1);
    const noTurns = await read([sessionMeta(), turnContext()]);
    expect(noTurns.kind).toBe('no-turns');
    expect(noTurns.turns).toHaveLength(0);
  });

  it('spans calendar days from startedAt to endedAt', async () => {
    const s = await read([sessionMeta({}, tsAt(0)), userMessage('x', tsAt(0)), agentMessage('y', tsAt(15 * 3600_000))]);
    expect(s.spansDays).toBe(2);
  });
});

describe('turns and finals (§4.3.2)', () => {
  it('opens on user_message, closes on the last agent_message, and strips the IDE wrapper', async () => {
    const wrapped = '# Context from my IDE setup:\n## Open editors\nstuff\n## My request for Codex:\ndo the thing';
    const s = await read([
      sessionMeta({}, tsAt(0)),
      turnContext({}, tsAt(1)),
      userMessage(wrapped, tsAt(2)),
      agentMessage('interim answer', tsAt(3)),
      agentMessage('final answer', tsAt(4)),
      userMessage('plain second prompt', tsAt(5)),
      agentMessage('second final', tsAt(6)),
    ]);
    expect(s.turns).toHaveLength(2);
    const [t0, t1] = s.turns;
    expect(t0?.userText).toBe('do the thing');
    expect(t0?.finalText).toBe('final answer');
    expect(t0?.interimFinals).toBe(1);
    expect(t0?.isDone).toBe(true);
    expect(t0?.interrupted).toBe(false);
    expect(t0?.finalTrigger).toBe('human');
    expect(t0?.finalStopReason).toBeNull();
    expect(t0?.kind).toBe('human');
    expect(t0?.promptId).toBe('t1');
    expect(t0?.echoHashes).toEqual([]);
    expect(t0?.segments).toEqual([{ trigger: 'human', promptId: 't1', seqStart: t0?.seqStart, seqEnd: t0?.seqEnd }]);
    expect(t0?.model).toBe('gpt-5.2-codex');
    expect(t0?.harnessVersion).toBe('0.98.0');
    expect(t1?.userText).toBe('plain second prompt');
    expect(t1?.promptId).toBe('t2');
    expect(s.diagnostics.interimFinals).toBe(1);
  });

  it('marks a turn followed by a second user_message without agent_message as interrupted', async () => {
    const s = await read([sessionMeta(), userMessage('first'), userMessage('second'), agentMessage('done')]);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]?.isDone).toBe(false);
    expect(s.turns[0]?.interrupted).toBe(true);
    expect(s.turns[0]?.finalText).toBeNull();
    expect(s.turns[0]?.finalTrigger).toBeNull();
    expect(s.turns[1]?.isDone).toBe(true);
  });

  it('falls back to an assistant response_item with phase final_answer when agent_message is missing', async () => {
    const s = await read([sessionMeta(), userMessage('x'), assistantItem('the fallback final', { phase: 'final_answer' })]);
    expect(s.turns[0]?.isDone).toBe(true);
    expect(s.turns[0]?.finalText).toBe('the fallback final');
  });

  it('never uses a plain assistant item (no phase) as a final', async () => {
    const s = await read([sessionMeta(), userMessage('x'), assistantItem('duplicate of agent_message')]);
    expect(s.turns[0]?.isDone).toBe(false);
    expect(s.turns[0]?.interrupted).toBe(true);
  });

  it('a turn open at EOF without a final is interrupted', async () => {
    const s = await read([sessionMeta(), userMessage('x'), fnCall('exec_command', { cmd: 'ls' }, 'c1')]);
    expect(s.turns[0]?.interrupted).toBe(true);
  });
});

describe('privacy: never retained (§4.3.1)', () => {
  it('keeps instructions, developer/user items, and reasoning out of the Session', async () => {
    const s = await read([
      sessionMeta(),
      developerItem(),
      userItem('AGENTS.md contents'),
      turnContext(),
      userMessage('real prompt'),
      agentReasoning(),
      reasoningItem(),
      assistantItem('dup'),
      agentMessage('final'),
    ]);
    const serialised = JSON.stringify(s);
    expect(serialised).not.toContain('NEVER-RETAINED');
    expect(serialised).not.toContain('AGENTS.md contents');
    expect(s.turns[0]?.userText).toBe('real prompt');
    expect(s.diagnostics.unknownCodexPayloads).toEqual({});
  });
});

describe('tool calls (§4.3.3)', () => {
  it('pairs exec_command with its unified output', async () => {
    const s = await read([
      sessionMeta({}, tsAt(0)),
      turnContext({}, tsAt(1)),
      userMessage('x', tsAt(2)),
      fnCall('exec_command', { cmd: 'ls -la', yield_time_ms: 100 }, 'c1', tsAt(3)),
      fnOut('c1', unifiedOutput({ exit: 0, wall: '0.0520', body: 'file1\nfile2\n' }), tsAt(4)),
      agentMessage('done', tsAt(5)),
    ]);
    expect(s.toolCalls).toHaveLength(1);
    const c = s.toolCalls[0];
    expect(c?.tool).toBe('exec_command');
    expect(c?.kind).toBe('shell');
    expect(c?.command).toBe('ls -la');
    expect(c?.cwd).toBe('/home/u/proj');
    expect(c?.turnIndex).toBe(0);
    expect(c?.exitCode).toBe(0);
    expect(c?.exitCodeSource).toBe('harness');
    expect(c?.durationMs).toBe(52);
    expect(c?.resultText).toBe('file1\nfile2\n');
    expect(c?.startedAt).toBe(tsAt(3));
    expect(c?.endedAt).toBe(tsAt(4));
    expect(c?.agentId).toBeNull();
  });

  it('joins string[] commands and collapses the shell wrapper', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('shell', { command: ['bash', '-lc', 'pytest -q tests/'] }, 'c1'),
      fnOut('c1', jsonOutput('ok', 0)),
      fnCall('shell', { command: ['git', 'status', '--short'] }, 'c2'),
      fnOut('c2', jsonOutput('ok', 0)),
    ]);
    expect(s.toolCalls[0]?.command).toBe('pytest -q tests/');
    expect(s.toolCalls[1]?.command).toBe('git status --short');
  });

  it('maps -1 exits to null + terminated (never green)', async () => {
    const s = await read([sessionMeta(), userMessage('x'), fnCall('exec_command', { cmd: 'sleep 99' }, 'c1'), fnOut('c1', unifiedOutput({ exit: -1 }))]);
    const c = s.toolCalls[0];
    expect(c?.exitCode).toBeNull();
    expect(c?.terminated).toBe(true);
    expect(c?.interpretation).toBe('killed-or-unknown');
    expect(c?.exitCodeSource).toBe('harness');
  });

  it('counts an unparseable output and leaves the exit unknown', async () => {
    const s = await read([sessionMeta(), userMessage('x'), fnCall('exec_command', { cmd: 'ls' }, 'c1'), fnOut('c1', 'free-form text output')]);
    const c = s.toolCalls[0];
    expect(c?.exitCode).toBeNull();
    expect(c?.exitCodeSource).toBe('unknown');
    expect(s.diagnostics.unknownCodexPayloads).toEqual({ 'output:exec_command': 1 });
  });

  it('marks sandbox denials as denied, never a run flag on the call itself', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('shell_command', { command: 'curl https://example.com' }, 'c1'),
      fnOut('c1', 'shell_command failed: CreateProcess { message: "Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 1 }))" }'),
    ]);
    const c = s.toolCalls[0];
    expect(c?.denied).toBe('sandbox-denied');
    expect(c?.isError).toBe(true);
    expect(c?.exitCode).toBe(1);
    expect(c?.exitCodeSource).toBe('parsed');
  });

  it('strips harness truncation markers and records originalTokens', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('exec_command', { cmd: 'cat big.log' }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 0, originalTokens: 24000, body: 'Total output lines: 4000\nhead\n…14000 tokens truncated…\ntail\n' })),
    ]);
    const c = s.toolCalls[0];
    expect(c?.truncated).toBe('harness');
    expect(c?.originalTokens).toBe(24000);
    expect(c?.resultText).toBe('head\ntail\n');
  });

  it('classifies unknown names as other (with a diagnostic) and MCP names as mcp (without)', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('frobnicate', { level: 9 }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 0 })),
      fnCall('mcp__figma__get_file', { id: '1' }, 'c2'),
      fnOut('c2', unifiedOutput({ exit: 0 })),
    ]);
    expect(s.toolCalls[0]?.kind).toBe('other');
    expect(s.toolCalls[1]?.kind).toBe('mcp');
    expect(s.diagnostics.unknownCodexPayloads).toEqual({ 'function:frobnicate': 1 });
  });

  it('classifies a non-mcp__ double-underscore name as mcp but leaves a structural trace', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('figma__get_file', { id: '1' }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 0 })),
    ]);
    expect(s.toolCalls[0]?.kind).toBe('mcp');
    expect(s.diagnostics.unknownCodexPayloads).toEqual({ 'mcp-name:figma__get_file': 1 });
  });

  it('exposes the kind map directly', () => {
    expect(codexToolKind('exec_command')).toBe('shell');
    expect(codexToolKind('shell_command')).toBe('shell');
    expect(codexToolKind('shell')).toBe('shell');
    expect(codexToolKind('container.exec')).toBe('shell');
    expect(codexToolKind('apply_patch')).toBe('edit');
    expect(codexToolKind('write_stdin')).toBe('other');
    expect(codexToolKind('mcp__srv__tool')).toBe('mcp');
    expect(codexToolKind('whatever')).toBe('other');
    expect(commandTextOf({ cmd: 'ls' })).toBe('ls');
    expect(commandTextOf({})).toBeUndefined();
  });
});

describe('background processes and write_stdin (§4.3.3)', () => {
  const runningExec = (id: string, session: number): string[] => [
    fnCall('exec_command', { cmd: 'npm run dev' }, id),
    fnOut(id, unifiedOutput({ session })),
  ];

  it('marks a running exec background with an unknown exit until back-filled', async () => {
    const s = await read([sessionMeta(), userMessage('x'), ...runningExec('c1', 5)]);
    const c = s.toolCalls[0];
    expect(c?.background).toBe(true);
    expect(c?.exitCode).toBeNull();
    expect(c?.exitCodeSource).toBe('unknown');
  });

  it('back-fills the originating exec by session id, keeps write_stdin calls as stdinWrite, and records interactive input', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      ...runningExec('c1', 5),
      fnCall('write_stdin', { session_id: 5, chars: 'y\n', yield_time_ms: 1000 }, 'c2'),
      fnOut('c2', unifiedOutput({ exit: 3, body: 'bye\n' })),
    ]);
    expect(s.toolCalls).toHaveLength(2); // write_stdin stays in toolCalls (the golden counts include it)
    const target = s.toolCalls[0];
    const write = s.toolCalls[1];
    expect(target?.exitCode).toBe(3);
    expect(target?.exitCodeSource).toBe('backfilled');
    expect(target?.stdinWrites).toEqual([{ seq: write?.seq, chars: 2 }]);
    expect(target?.interrupted).toBe(false);
    expect(write?.stdinWrite).toBe(true);
    expect(write?.kind).toBe('other');
    expect(write?.exitCode).toBe(3); // its own header exit
    expect(write?.exitCodeSource).toBe('harness');
    expect(write?.input).not.toHaveProperty('chars'); // stdin content is never retained on input
    expect(write?.command).toBeUndefined(); // never a command (S12 skips stdinWrite calls)
  });

  it('marks the target interrupted on a \\u0003 write', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      ...runningExec('c1', 7),
      fnCall('write_stdin', { session_id: 7, chars: '\u0003', yield_time_ms: 1000 }, 'c2'),
      fnOut('c2', unifiedOutput({ exit: 130 })),
    ]);
    const target = s.toolCalls[0];
    expect(target?.interrupted).toBe(true);
    expect(target?.stdinWrites?.[0]?.interrupted).toBe(true);
    expect(target?.exitCode).toBe(130);
    expect(target?.exitCodeSource).toBe('backfilled');
  });

  it('back-fills a -1 exit as null + terminated', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      ...runningExec('c1', 9),
      fnCall('write_stdin', { session_id: 9, chars: '' }, 'c2'),
      fnOut('c2', unifiedOutput({ exit: -1 })),
    ]);
    const target = s.toolCalls[0];
    expect(target?.exitCode).toBeNull();
    expect(target?.terminated).toBe(true);
    expect(target?.exitCodeSource).toBe('backfilled');
  });

  it('leaves a write_stdin whose output still shows the process running with an unknown exit', async () => {
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      ...runningExec('c1', 4),
      fnCall('write_stdin', { session_id: 4, chars: '' }, 'c2'),
      fnOut('c2', unifiedOutput({ session: 4 })),
    ]);
    const write = s.toolCalls[1];
    expect(write?.exitCode).toBeNull();
    expect(write?.exitCodeSource).toBe('unknown');
    expect(write?.background).toBe(false);
    expect(s.toolCalls[0]?.exitCode).toBeNull(); // still running, nothing back-filled
  });
});

describe('apply_patch (§4.3.4)', () => {
  const PATCH = ['*** Begin Patch', '*** Update File: src/mod.py', '@@', '-old', '+new', '*** End Patch'].join('\n');

  it('gates a custom_tool_call on its JSON output and resolves relative paths against the cwd', async () => {
    const s = await read([
      sessionMeta(),
      turnContext({ cwd: '/home/u/proj' }),
      userMessage('x'),
      customPatchCall('c1', PATCH),
      customPatchOut('c1', JSON.stringify({ output: 'Success. Updated the following files:\nM src/mod.py\n', metadata: { exit_code: 0, duration_seconds: 0.1 } })),
    ]);
    const c = s.toolCalls[0];
    expect(c?.tool).toBe('apply_patch');
    expect(c?.kind).toBe('edit');
    expect(c?.exitCode).toBe(0);
    expect(c?.isError).toBe(false);
    expect(c?.filesTouched).toEqual(['/home/u/proj/src/mod.py']);
    expect(c?.attempted).toBeUndefined();
    expect(c?.patch).toEqual({ added: ['new'], removed: ['old'], hunks: 1 });
  });

  it('keeps attempted[] and no writes on a failed patch (status is never consulted)', async () => {
    const s = await read([
      sessionMeta(),
      turnContext({ cwd: '/home/u/proj' }),
      userMessage('x'),
      customPatchCall('c1', PATCH), // status:'completed' even for the failure
      customPatchOut('c1', 'apply_patch verification failed: Failed to find expected lines in /home/u/proj/src/mod.py:'),
    ]);
    const c = s.toolCalls[0];
    expect(c?.isError).toBe(true);
    expect(c?.exitCode).toBe(1);
    expect(c?.filesTouched).toEqual([]);
    expect(c?.attempted).toEqual(['/home/u/proj/src/mod.py']);
  });

  it('parses an apply_patch delivered through exec_command the same way (kind stays shell)', async () => {
    const heredoc = `apply_patch <<'EOF'\n${PATCH}\nEOF`;
    const s = await read([
      sessionMeta(),
      turnContext({ cwd: '/home/u/proj' }),
      userMessage('x'),
      fnCall('exec_command', { cmd: heredoc }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 0, body: 'Success. Updated the following files:\nM src/mod.py\n' })),
    ]);
    const c = s.toolCalls[0];
    expect(c?.tool).toBe('exec_command');
    expect(c?.kind).toBe('shell');
    expect(c?.command).toBe(heredoc);
    expect(c?.filesTouched).toEqual(['/home/u/proj/src/mod.py']);
    expect(c?.patch?.hunks).toBe(1);
  });

  it('treats a non-header output of an exec-delivered patch as a failure without an unknown-output diagnostic', async () => {
    const heredoc = `apply_patch <<'EOF'\n${PATCH}\nEOF`;
    const s = await read([
      sessionMeta(),
      userMessage('x'),
      fnCall('shell_command', { command: heredoc }, 'c1'),
      fnOut('c1', 'apply_patch verification failed: Failed to find expected lines in /home/u/proj/src/mod.py:'),
    ]);
    const c = s.toolCalls[0];
    expect(c?.isError).toBe(true);
    expect(c?.exitCode).toBe(1);
    expect(c?.attempted).toHaveLength(1);
    expect(s.diagnostics.unknownCodexPayloads).toEqual({});
  });
});

describe('token deltas (§4.3.5)', () => {
  it('attributes deltas to the open turn, skips duplicates, and notes resets', async () => {
    const s = await read([
      sessionMeta(),
      turnContext(),
      tokenCount({ input: 5, cached: 0, output: 1 }, {}, tsAt(1)), // before the first turn → turnIndex -1
      userMessage('first', tsAt(2)),
      tokenCount(null, { ratePct: 2 }, tsAt(3)), // info null: skipped, rate limits still read
      tokenCount({ input: 100, cached: 40, output: 10, reasoning: 3 }, {}, tsAt(4)),
      tokenCount({ input: 100, cached: 40, output: 10, reasoning: 3 }, {}, tsAt(5)), // exact duplicate
      agentMessage('done', tsAt(6)),
      userMessage('second', tsAt(7)),
      tokenCount({ input: 20, cached: 8, output: 2 }, { ratePct: 0 }, tsAt(8)), // totals dropped → reset
      agentMessage('done again', tsAt(9)),
    ]);
    expect(s.tokenDeltas).toHaveLength(3);
    expect(s.tokenDeltas[0]).toMatchObject({ turnIndex: -1, input: 5 });
    expect(s.tokenDeltas[1]).toMatchObject({ turnIndex: 0, input: 95, cached: 40, output: 9, reasoning: 3, model: 'gpt-5.2-codex' });
    expect(s.tokenDeltas[2]).toMatchObject({ turnIndex: 1, input: 20, cached: 8, output: 2 });
    expect(s.diagnostics.negativeDeltas).toBe(1);
    expect(s.diagnostics.notes).toContain('usage counter reset (resume)');
    expect(s.turns[0]?.apiCalls).toBe(1);
    expect(s.turns[0]?.usage.input).toBe(55); // 95 − 40 cached
    expect(s.turns[0]?.usage.cacheRead).toBe(40);
    expect(s.turns[1]?.apiCalls).toBe(1);
    expect(s.usage.calls).toBe(3);
    expect(s.usage.output).toBe(12);
    expect(s.usage.thinking).toBe(3);
    expect(s.cost.planUsagePct).toBe(0); // last non-null rate_limits wins; 0 % accepted
  });
});

describe('diagnostics and tolerance', () => {
  it('counts unknown frame types, unknown payload types and bad lines without throwing', async () => {
    const s = await read([
      sessionMeta(),
      line('compacted', { message: 'x' }),
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'web_search_call' }),
      '{"not":"a rollout line"}',
      'not json at all {',
      userMessage('x'),
    ]);
    expect(s.diagnostics.unknownRecordTypes).toEqual({ compacted: 1, '<not-a-record>': 1 });
    expect(s.diagnostics.unknownCodexPayloads).toEqual({ 'event_msg:task_started': 1, 'response_item:web_search_call': 1 });
    expect(s.diagnostics.badLines).toBe(1);
    expect(s.records).toBe(5); // bad line and non-record line are not records
  });

  it('notes an output without a matching call', async () => {
    const s = await read([sessionMeta(), userMessage('x'), fnOut('missing', unifiedOutput({ exit: 0 }))]);
    expect(s.diagnostics.notes).toContain('codex: function_call_output without a matching call');
    expect(s.toolCalls).toHaveLength(0);
  });
});
