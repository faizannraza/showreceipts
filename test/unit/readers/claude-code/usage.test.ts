/**
 * S06 — usage dedupe and per-attempt buckets (§4.2.7, §8.3 lines 1–4).
 * Regression pins: synthetic 3-line message → one row; placeholder never
 * wins; refusal fallback → two attempts with resolved models; declined
 * zero-output attempt `billed: false`; legacy `wU` path.
 */
import { describe, expect, it } from 'vitest';
import { cc, parseCC, usage } from '../../../helpers/cc-lines.js';

describe('per-message dedupe', () => {
  it('a synthetic 3-line message yields one usage row', async () => {
    // Three assistant lines share one message.id; identical usage on each
    // (main-file behaviour). Only the completed line's usage is billed once.
    const t = cc();
    t.human('go', { promptId: 'p1' });
    const u = usage({ input_tokens: 100, output_tokens: 50 });
    t.assistant({ id: 'msg-A', stop: null, thinking: '', usage: u });
    t.assistant({ id: 'msg-A', stop: null, tools: [{ id: 'tu1', name: 'Read', input: { file_path: '/a' } }], usage: u });
    t.toolResult('tu1', 'ok', { promptId: 'p1', result: { type: 'text', file: { filePath: '/a', content: 'x' } } });
    t.assistant({ id: 'msg-A', stop: 'end_turn', text: 'done', usage: u });
    const s = await parseCC(t);
    const rows = s.usageRows.filter((r) => r.messageId === 'msg-A');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts[0]?.in).toBe(100);
    expect(rows[0]?.attempts[0]?.out).toBe(50);
    // Totals bill it exactly once.
    expect(s.usage.output).toBe(50);
    expect(s.usage.input).toBe(100);
    expect(s.usage.calls).toBe(1);
  });

  it('placeholder line never wins: the completed line supplies the output', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // Placeholder: stop_reason null, tiny output. Completed: real output.
    t.assistant({ id: 'msg-B', stop: null, thinking: '', usage: usage({ output_tokens: 3 }) });
    t.assistant({ id: 'msg-B', stop: 'end_turn', text: 'hi', usage: usage({ output_tokens: 900 }) });
    const s = await parseCC(t);
    const row = s.usageRows.find((r) => r.messageId === 'msg-B');
    expect(row?.attempts[0]?.out).toBe(900);
    expect(row?.incomplete).toBeUndefined();
  });

  it('a message that never completes is kept as the max-output line and flagged incomplete', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ id: 'msg-C', stop: null, thinking: '', usage: usage({ output_tokens: 5 }) });
    t.assistant({ id: 'msg-C', stop: null, tools: [{ id: 'tu1', name: 'Read' }], usage: usage({ output_tokens: 40 }) });
    const s = await parseCC(t);
    const row = s.usageRows.find((r) => r.messageId === 'msg-C');
    expect(row?.incomplete).toBe(true);
    expect(row?.attempts[0]?.out).toBe(40);
    expect(s.diagnostics.incompleteMessages).toBe(1);
  });

  it('an interrupted stream is billed once and flagged interrupted, never incomplete (§4.2.2)', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ id: 'msg-I', stop: null, text: 'partial…', usage: usage({ output_tokens: 12 }) });
    t.interrupt({ interruptedMessageId: 'msg-I', promptId: 'p1' });
    const s = await parseCC(t);
    const row = s.usageRows.find((r) => r.messageId === 'msg-I');
    expect(row?.interrupted).toBe(true);
    expect(row?.incomplete).toBeUndefined();
    expect(row?.attempts[0]?.billed).toBe(true);
    expect(row?.attempts[0]?.out).toBe(12);
    expect(s.diagnostics.incompleteMessages).toBe(0);
  });
});

describe('bucket resolution (§8.3)', () => {
  it('5m / 1h / other ephemeral and cache-read buckets', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({
      id: 'msg-D',
      stop: 'end_turn',
      text: 'ok',
      usage: usage({
        input_tokens: 7,
        cache_read_input_tokens: 11,
        output_tokens: 13,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 5, ephemeral_30m_input_tokens: 2 },
      }),
    });
    const s = await parseCC(t);
    const a = s.usageRows.find((r) => r.messageId === 'msg-D')?.attempts[0];
    expect(a).toMatchObject({ in: 7, w5: 3, w1: 5, wX: 2, wU: 0, rd: 11, out: 13 });
    expect(a?.model).toBe('claude-test-5');
    // promptTokens = in + w5 + w1 + wX + wU + rd
    expect(s.usageRows.find((r) => r.messageId === 'msg-D')?.promptTokens).toBe(7 + 3 + 5 + 2 + 0 + 11);
  });

  it('legacy wU path: cache_creation_input_tokens counted only without a breakdown', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({
      id: 'msg-E',
      stop: 'end_turn',
      text: 'ok',
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 300 } as never,
    });
    const s = await parseCC(t);
    const a = s.usageRows.find((r) => r.messageId === 'msg-E')?.attempts[0];
    expect(a?.wU).toBe(300);
    expect(a?.w5).toBe(0);
    expect(a?.w1).toBe(0);
    expect(s.diagnostics.legacyShapes['no-cache-breakdown']).toBe(1);
  });

  it('thinking tokens flow into totals from output_tokens_details', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({ id: 'msg-T', stop: 'end_turn', text: 'ok', usage: usage({ output_tokens: 20, output_tokens_details: { thinking_tokens: 8 } }) });
    const s = await parseCC(t);
    expect(s.usage.thinking).toBe(8);
  });
});

describe('refusal fallback (§8.3 lines 1–4)', () => {
  it('two attempts get resolved models; the refused (output-producing) attempt is billed', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    // The refusal-fallback system line carries requestId + originalModel.
    t.system('model_refusal_fallback', {
      fields: { requestId: 'req-fb', originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-4-8', apiRefusalCategory: 'policy' },
    });
    // The assistant line has two iterations: the refused first attempt
    // (message type, real output) and the serving second attempt.
    t.assistant({
      id: 'msg-F',
      requestId: 'req-fb',
      stop: 'end_turn',
      text: 'served',
      model: 'claude-opus-4-8',
      usage: usage({
        input_tokens: 1,
        output_tokens: 500,
        iterations: [
          // Refused first attempt: no `model` key → resolves to the refusal
          // line's originalModel (§8.3) via the requestId memo.
          { input_tokens: 2, output_tokens: 217, cache_read_input_tokens: 684675, cache_creation_input_tokens: 0, type: 'message' } as never,
          // Serving attempt: 2.1.235 iterations carry `model`.
          { input_tokens: 1, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, type: 'message', model: 'claude-opus-4-8' } as never,
        ],
      }),
    });
    const s = await parseCC(t);
    const row = s.usageRows.find((r) => r.messageId === 'msg-F');
    expect(row?.attempts).toHaveLength(2);
    // First (refused) attempt: model resolved from the refusal line's originalModel.
    expect(row?.attempts[0]?.model).toBe('claude-fable-5');
    expect(row?.attempts[0]?.billed).toBe(true); // it produced 217 output tokens
    expect(row?.attempts[0]?.rd).toBe(684675);
    // Second (serving) attempt: message.model.
    expect(row?.attempts[1]?.model).toBe('claude-opus-4-8');
    expect(row?.attempts[1]?.billed).toBe(true);
    // The refusal is recorded and the fallback model appended to models.
    expect(s.refusalFallbacks).toHaveLength(1);
    expect(s.refusalFallbacks[0]).toMatchObject({ originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-4-8', category: 'policy' });
    expect(s.models).toContain('claude-opus-4-8');
  });

  it('a declined non-final message attempt with zero output is billed:false', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.assistant({
      id: 'msg-G',
      stop: 'end_turn',
      text: 'ok',
      usage: usage({
        output_tokens: 30,
        iterations: [
          { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, type: 'message' } as never,
          { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, type: 'message' } as never,
        ],
      }),
    });
    const s = await parseCC(t);
    const row = s.usageRows.find((r) => r.messageId === 'msg-G');
    expect(row?.attempts[0]?.billed).toBe(false); // declined before output
    expect(row?.attempts[1]?.billed).toBe(true);
    // Only the billed attempt reaches the totals.
    expect(s.usage.output).toBe(30);
  });
});

describe('synthetic exclusion', () => {
  it('synthetic / API-error lines never produce usage rows', async () => {
    const t = cc();
    t.human('go', { promptId: 'p1' });
    t.raw({
      type: 'assistant',
      uuid: 'syn-1',
      parentUuid: t.last(),
      isSidechain: false,
      message: { id: 'msg-S', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'err' }], usage: usage({ output_tokens: 999 }) },
      error: 'authentication_failed',
      isApiErrorMessage: true,
      apiErrorStatus: 401,
      timestamp: t.nextTs(),
      cwd: '/home/u/proj',
      sessionId: t.sid,
      version: '2.1.220',
    });
    t.assistant({ id: 'msg-real', parent: 'p1-parent-none', stop: 'end_turn', text: 'ok', usage: usage({ output_tokens: 10 }) });
    const s = await parseCC(t);
    expect(s.usageRows.some((r) => r.messageId === 'msg-S')).toBe(false);
    expect(s.diagnostics.excludedSyntheticLines).toBeGreaterThanOrEqual(1);
    expect(s.apiErrors[0]).toMatchObject({ error: 'authentication_failed', status: 401 });
  });
});
