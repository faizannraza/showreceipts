/**
 * Closing-review regression (Pass 1): a single assistant message
 * accumulating unbounded text used to throw `Invalid string length` at the
 * turn join (≥ V8's max string) or abort the hook process inside
 * `JSON.stringify` just under it. The builder now bounds each message at
 * `MESSAGE_TEXT_BUDGET` keeping the head plus the newest block's tail, so
 * the join is safe and the flush guard still sees the true message suffix.
 */
import { describe, expect, it } from 'vitest';
import type { LineSource, SessionRef } from '../../../../src/model/types.js';
import { MESSAGE_TEXT_BUDGET, MESSAGE_TEXT_TAIL } from '../../../../src/readers/claude-code/builder.js';
import { readClaudeCodeSession } from '../../../../src/readers/claude-code/reader.js';

const SID = 'ab12cd34-1111-4222-8333-444455556666';
const REF: SessionRef = { harness: 'claude-code', sessionId: SID, path: '', size: 0, mtimeMs: 0, subagentManifest: [] };

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard',
};

function line(record: Record<string, unknown>, n: number, parent: string | null): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/u/proj',
    sessionId: SID,
    version: '2.1.251',
    gitBranch: 'main',
    uuid: `u-${String(n).padStart(4, '0')}`,
    timestamp: new Date(Date.UTC(2026, 1, 10, 10, 0, n)).toISOString(),
    ...record,
  });
}

describe('per-message text budget', () => {
  it('bounds a pathological giant message and keeps head + marker + tail', async () => {
    const head = 'H'.repeat(MESSAGE_TEXT_BUDGET - 100);
    const tailBlock = 'x'.repeat(200_000) + 'THE-END';
    const lines = [
      line({ type: 'user', promptId: 'p1', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'go' } }, 1, null),
      line(
        { type: 'assistant', requestId: 'r1', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-test-5', stop_reason: null, stop_sequence: null, content: [{ type: 'text', text: head }], usage } },
        2,
        'u-0001',
      ),
      line(
        { type: 'assistant', requestId: 'r1', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-test-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: tailBlock }], usage } },
        3,
        'u-0002',
      ),
    ];
    const src: LineSource = { kind: 'text', text: lines.join('\n') + '\n', name: 'main.jsonl' };
    const { session } = await readClaudeCodeSession(REF, { lines: src, home: '/home/u' });
    const turn = session.turns[0];
    expect(turn).toBeDefined();
    const finalText = turn?.finalText ?? '';
    // Bounded: head budget + marker + tail, never hundreds of MB.
    expect(finalText.length).toBeLessThanOrEqual(MESSAGE_TEXT_BUDGET + MESSAGE_TEXT_TAIL + 200);
    expect(finalText).toContain('… [assistant text truncated by showreceipts]');
    // The true message suffix survives (the flush guard's ends-with check).
    expect(finalText.endsWith('THE-END')).toBe(true);
    expect(finalText.startsWith('HHHH')).toBe(true);
  }, 30_000);

  it('an ordinary final message is untouched', async () => {
    const lines = [
      line({ type: 'user', promptId: 'p1', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'go' } }, 1, null),
      line(
        { type: 'assistant', requestId: 'r1', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-test-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'All done.' }], usage } },
        2,
        'u-0001',
      ),
    ];
    const src: LineSource = { kind: 'text', text: lines.join('\n') + '\n', name: 'main.jsonl' };
    const { session } = await readClaudeCodeSession(REF, { lines: src, home: '/home/u' });
    expect(session.turns[0]?.finalText).toBe('All done.');
  });
});
