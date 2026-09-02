/**
 * S06 — turn builder (§4.2.3, Appendix E). Walk through system lines;
 * missing promptId; interrupt without promptId; synthetic stop_sequence +
 * local_command + resumed final; compaction bridge + re-emitted results;
 * notification continuation; local-command group not a turn; skill group
 * turn; meta / <system-reminder> segments; inline sidechain ignored for
 * finals; interrupted-stream billing.
 */
import { describe, expect, it } from 'vitest';
import { classifyUserLine, contentText, skillUserText } from '../../../../src/readers/claude-code/turns.js';
import { cc, parseCC, usage } from '../../../helpers/cc-lines.js';

describe('user-line classification', () => {
  it('classifies each trigger in the §4.2.3 order', () => {
    expect(classifyUserLine({ message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })).toEqual({ kind: 'results' });
    expect(classifyUserLine({ interruptedMessageId: 'm', message: { content: 'x' } })).toMatchObject({ trigger: 'interrupt' });
    expect(classifyUserLine({ message: { content: '[Request interrupted by user]' } })).toMatchObject({ trigger: 'interrupt' });
    expect(classifyUserLine({ isCompactSummary: true, message: { content: 'summary' } })).toMatchObject({ trigger: 'compact' });
    expect(classifyUserLine({ origin: { kind: 'task-notification' }, isMeta: true, message: { content: '<task-notification>x</task-notification>' } })).toMatchObject({
      trigger: 'notification',
    });
    expect(classifyUserLine({ isMeta: true, message: { content: 'meta' } })).toMatchObject({ trigger: 'meta' });
    expect(classifyUserLine({ message: { content: '<system-reminder>hi</system-reminder>' } })).toMatchObject({ trigger: 'meta' });
    expect(classifyUserLine({ message: { content: '<local-command-stdout>x</local-command-stdout>' } })).toMatchObject({ trigger: 'local-command' });
    expect(classifyUserLine({ message: { content: '<command-name>/x</command-name>' } })).toMatchObject({ trigger: 'skill' });
    expect(classifyUserLine({ origin: { kind: 'human' }, message: { content: 'hi' } })).toMatchObject({ trigger: 'human' });
    expect(classifyUserLine({ promptSource: 'typed', message: { content: 'hi' } })).toMatchObject({ trigger: 'human' });
    // Untagged content when both origin and promptSource are absent → human.
    expect(classifyUserLine({ message: { content: 'plain text' } })).toMatchObject({ trigger: 'human' });
  });

  it('contentText and skillUserText helpers', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    expect(contentText([{ type: 'image' }])).toBeNull();
    expect(skillUserText('<command-name>/x</command-name>\n<command-args>the args</command-args>')).toBe('the args');
    expect(skillUserText('<command-name>/x</command-name>\n<command-args></command-args>')).toBe('/x');
  });
});

describe('assistant attribution via parentUuid walk', () => {
  it('attributes an assistant line through system lines to the human prompt (0 orphans)', async () => {
    const t = cc();
    const h = t.human('do it', { promptId: 'p1' });
    // A system turn_duration line sits between the prompt and the assistant.
    t.turnDuration(100, { parent: h });
    const sys = t.last();
    t.assistant({ parent: sys, stop: 'end_turn', text: 'done', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.finalText).toBe('done');
    expect(s.diagnostics.orphanAssistantLines).toBe(0);
  });

  it('an assistant line whose parent chain has no promptId is an orphan attributed by file position', async () => {
    const t = cc();
    t.human('do it', { promptId: 'p1' });
    // Assistant with a dangling parent (not in the index).
    t.assistant({ parent: 'nonexistent-uuid', stop: 'end_turn', text: 'done', usage: usage() });
    const s = await parseCC(t);
    expect(s.diagnostics.orphanAssistantLines).toBe(1);
    // Still lands in the open turn by file position.
    expect(s.turns[0]?.finalText).toBe('done');
  });
});

describe('group disposition', () => {
  it('a local-command-only group is not a turn', async () => {
    const t = cc();
    t.user('<command-name>/status</command-name>', { promptId: 'lc1' });
    t.system('local_command', { fields: { content: '<local-command-stdout>ok</local-command-stdout>' } });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(0);
    expect(s.diagnostics.localCommandPrompts).toBe(1);
    expect(s.kind).toBe('no-turns');
  });

  it('a skill group with an assistant line opens a skill turn', async () => {
    const t = cc();
    t.skill('/ultraplan', 'build the thing', { promptId: 'sk1' });
    t.assistant({ stop: 'end_turn', text: 'planned', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.kind).toBe('skill');
    expect(s.turns[0]?.userText).toBe('build the thing');
  });

  it('meta and <system-reminder> groups become continuation segments', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', text: 'done', usage: usage() });
    // A meta-only group after the turn.
    t.user('<system-reminder>note</system-reminder>', { promptId: 'meta1', isMeta: true });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.segments.some((seg) => seg.trigger === 'meta')).toBe(true);
  });

  it('a meta/notification group before the first turn goes to the preamble', async () => {
    const t = cc();
    t.notification('<task-id>bg</task-id><status>done</status>', { promptId: 'n0' });
    t.human('go', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', text: 'ok', usage: usage() });
    const s = await parseCC(t);
    expect(s.preamble.some((seg) => seg.trigger === 'notification')).toBe(true);
  });
});

describe('notification continuation (§4.2.3 step 4, Appendix E)', () => {
  it('a notification segment answers the human turn; user text is not appended to userText', async () => {
    const t = cc();
    t.human('spawn a task', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu-a', name: 'Agent', input: {} }], stop: 'tool_use', usage: usage() });
    t.toolResult('tu-a', 'launched', { promptId: 'p1', result: { status: 'async_launched', agentId: 'bg', description: 'sub' } });
    // The notification arrives as its own promptId group (continuation).
    t.notification('<task-id>bg</task-id>\n<status>completed</status>\n<summary>all done</summary>\nBackground command "x" completed (exit code 0)', { promptId: 'n1' });
    t.assistant({ parent: t.last(), stop: 'end_turn', text: 'the task finished', usage: usage() });
    const s = await parseCC(t);
    const turn = s.turns[0];
    expect(turn?.userText).toBe('spawn a task');
    expect(turn?.finalText).toBe('the task finished');
    expect(turn?.finalTrigger).toBe('notification');
    expect(turn?.segments.some((seg) => seg.trigger === 'notification')).toBe(true);
    // The exit code reached the background call, and the subagent is marked finished.
    const call = s.toolCalls.find((c) => c.backgroundTaskId === 'bg');
    expect(call?.exitCode).toBe(0);
    expect(call?.exitCodeSource).toBe('notification');
    expect(s.subagents.find((a) => a.agentId === 'bg')?.finished).toBe(true);
  });
});

describe('compaction bridge (§4.2.3 step 7)', () => {
  it('bridges post-compaction lines to the human turn and drops re-emitted duplicate uuids', async () => {
    const t = cc();
    const h = t.human('long task', { promptId: 'p1' });
    t.assistant({ parent: h, tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use', usage: usage() });
    const a1 = t.last();
    const tr = t.toolResult('tu1', 'listing', { promptId: 'p1', parent: a1 });
    // compact_boundary (parentUuid null) bridging to the last pre-compaction uuid.
    t.compactBoundary(tr, {}, {});
    // The compaction summary carries a NEW promptId; the rest of the turn re-keys under it.
    t.compactSummary('Conversation summary', { promptId: 'p2', parent: t.last() });
    // A re-emitted earlier tool_result (same uuid) → dropped as duplicate.
    t.toolResult('tu1', 'listing', { promptId: 'p2', uuid: tr });
    t.assistant({ parent: t.last(), stop: 'end_turn', text: 'finished after compaction', usage: usage() });
    const s = await parseCC(t);
    // The turn is not split (one turn), the final is attributed to it.
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.finalText).toBe('finished after compaction');
    expect(s.turns[0]?.compactions).toBe(1);
    expect(s.compactions).toHaveLength(1);
    expect(s.compactions[0]?.preTokens).toBe(1000);
    expect(s.diagnostics.duplicateUuids).toBeGreaterThanOrEqual(1);
    // The tool call is paired exactly once.
    expect(s.toolCalls.filter((c) => c.id === 'tu1')).toHaveLength(1);
  });
});

describe('interrupt handling', () => {
  it('an interrupt without a promptId never starts or ends a turn but marks it interrupted', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu1', name: 'Bash', input: { command: 'sleep 10' } }], stop: 'tool_use', usage: usage() });
    // Interrupt line with no promptId, chained to the assistant.
    t.interrupt({ parent: t.last(), interruptedMessageId: 'msg-x' });
    const s = await parseCC(t);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.interrupted).toBe(true);
    expect(s.turns[0]?.isDone).toBe(false);
  });

  it('interrupted-stream billing: stop_reason null + interruptedMessageId is billed once, never a final', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // A stop_reason:null message with real usage (interrupted stream).
    t.assistant({ id: 'msg-int', stop: null, text: 'partial', usage: usage({ output_tokens: 42 }) });
    // The next line references it as interruptedMessageId.
    t.interrupt({ parent: t.last(), interruptedMessageId: 'msg-int' });
    const s = await parseCC(t);
    // Billed once.
    const row = s.usageRows.find((r) => r.messageId === 'msg-int');
    expect(row).toBeDefined();
    expect(row?.attempts[0]?.out).toBe(42);
    // Never a final (stop_reason is null).
    expect(s.turns[0]?.finalText).toBeNull();
    expect(s.turns[0]?.interrupted).toBe(true);
  });
});

describe('synthetic stop_sequence + local_command + resumed final (relogin)', () => {
  it('a synthetic stop_sequence line is excluded; a later real end_turn is the final', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // Synthetic API-error stop_sequence line.
    t.raw({
      type: 'assistant',
      uuid: 'syn-1',
      parentUuid: t.last(),
      isSidechain: false,
      message: { id: 'msg-syn', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'auth failed' }], usage: usage({ output_tokens: 0 }) },
      error: 'authentication_failed',
      isApiErrorMessage: true,
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.220',
    });
    // local_command (relogin) then a resumed real final.
    t.system('local_command', { parent: 'syn-1', fields: { content: '<local-command-stdout>relogin</local-command-stdout>' } });
    t.assistant({ parent: t.last(), stop: 'end_turn', text: 'resumed and done', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBe('resumed and done');
    expect(s.diagnostics.excludedSyntheticLines).toBeGreaterThanOrEqual(1);
  });
});

describe('finals selection', () => {
  it('earlier end_turn text messages count as interimFinals; the last wins', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ id: 'm1', stop: 'end_turn', text: 'first answer', usage: usage() });
    t.assistant({ parent: t.last(), id: 'm2', stop: 'end_turn', text: 'final answer', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBe('final answer');
    expect(s.turns[0]?.finalMessageId).toBe('m2');
    expect(s.turns[0]?.interimFinals).toBe(1);
    expect(s.diagnostics.interimFinals).toBe(1);
  });

  it('finalText joins multiple text blocks with \\n\\n', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ stop: 'end_turn', content: [{ type: 'text', text: 'para one' }, { type: 'text', text: 'para two' }], usage: usage() });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBe('para one\n\npara two');
  });

  it('a tool_use-only message is never a final; the turn is interrupted', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ tools: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], stop: 'tool_use', usage: usage() });
    t.toolResult('tu1', 'out', { promptId: 'p1' });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBeNull();
    expect(s.turns[0]?.isDone).toBe(false);
    expect(s.turns[0]?.interrupted).toBe(true);
  });
});

describe('refusal fallback excludes retracted uuids from finals', () => {
  it('a retracted message is excluded from finals but is not an orphan', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // The refusal line lists the retracted message uuid.
    t.assistant({ uuid: 'retr-1', id: 'msg-retracted', stop: 'end_turn', text: 'refused text', usage: usage() });
    t.system('model_refusal_fallback', {
      parent: 'retr-1',
      fields: { requestId: 'req-x', originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-4-8', retractedMessageUuids: ['retr-1'] },
    });
    t.assistant({ parent: t.last(), id: 'msg-final', stop: 'end_turn', text: 'the real answer', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBe('the real answer');
    // Retracted line is not reported as an orphan.
    expect(s.diagnostics.orphanAssistantLines).toBe(0);
  });
});

describe('session-level fields', () => {
  it('durationMs (Σ turn_duration), harnessVersion, cwd and gitBranch', async () => {
    const t = cc();
    const h = t.human('go', { promptId: 'p1', cwd: '/home/u/proj', gitBranch: 'feature' });
    t.assistant({ parent: h, stop: 'end_turn', text: 'done', usage: usage(), version: '2.1.221' });
    t.turnDuration(500, { parent: t.last() });
    t.turnDuration(700, { parent: t.last() });
    const s = await parseCC(t);
    expect(s.turns[0]?.durationMs).toBe(1200);
    expect(s.activeMs).toBe(1200);
    expect(s.cwd).toBe('/home/u/proj');
    expect(s.gitBranch).toBe('feature');
    expect(s.turns[0]?.harnessVersion).toBe('2.1.221');
  });

  it('empty transcript → kind empty', async () => {
    const s = await parseCC(cc());
    expect(s.kind).toBe('empty');
    expect(s.turns).toHaveLength(0);
  });
});

describe('inline sidechain lines are ignored for finals', () => {
  it('an isSidechain assistant line never supplies the turn final', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // A stray inline sidechain assistant (diverted to the sidechain collector).
    t.raw({
      type: 'assistant',
      uuid: 'sc-1',
      parentUuid: null,
      isSidechain: true,
      agentId: 'inline-a',
      message: { id: 'msg-sc', model: 'claude-test-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'sidechain final' }], usage: usage() },
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.220',
    });
    t.assistant({ stop: 'end_turn', text: 'main final', usage: usage() });
    const s = await parseCC(t);
    expect(s.turns[0]?.finalText).toBe('main final');
  });
});
