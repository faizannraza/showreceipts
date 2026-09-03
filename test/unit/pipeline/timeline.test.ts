/**
 * S18 — `pipeline/timeline.ts`: every tool call of a turn becomes a
 * `TimelineEntry` with semantic flags, a sanitised summary, and a per-call
 * `usd` from the nearest usage row / token delta. The Codex stdin wording
 * ("interactive input", "interrupted by Ctrl-C") is composed here from the
 * structured facts (W1 merge note — no note strings on the model).
 */
import { describe, expect, it } from 'vitest';
import type { UsageAttempt, UsageRow } from '../../../src/model/types.js';
import { priceClaudeCode } from '../../../src/cost/cost.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { buildTimeline } from '../../../src/pipeline/timeline.js';
import { call, check, session, testRun, turn, write, emptyLedger, computePerTurn } from '../reconcile/harness.js';

const table = loadPriceTable();

function attempt(over: Partial<UsageAttempt> = {}): UsageAttempt {
  return { model: 'claude-fable-5', in: 1000, w5: 0, w1: 0, wX: 0, wU: 0, rd: 0, out: 100, billed: true, ...over };
}

function row(seq: number, over: Partial<UsageRow> = {}): UsageRow {
  return { seq, agentId: null, messageId: `m${seq}`, ts: '2026-03-01T17:00:00.000Z', attempts: [attempt()], promptTokens: 0, ...over };
}

describe('buildTimeline', () => {
  it('emits one entry per turn call with flags, files, exit and summary', () => {
    const calls = [
      call(20, { command: 'uv run pytest -q', description: 'Run tests' }),
      call(22, { tool: 'Edit', kind: 'edit', filesTouched: ['/home/u/proj/src/app.py'] }),
      call(24, { command: 'git push', exitCode: 1 }),
      call(26, { command: 'sleep 100', background: true, exitCode: null, exitCodeSource: 'unknown' }),
    ];
    const ledger = emptyLedger({
      testRuns: [testRun({ seq: 20 })],
      writes: [write({ seq: 22, toolCallId: 't22' })],
      git: [{ seq: 24, op: 'push', ok: false, source: 'command' }],
      checks: [check({ seq: 20, toolCallId: 't20' })],
      danger: [{ seq: 24, tier: 'danger', kind: 'force-push', detail: 'git push --force' }],
    });
    ledger.perTurn = computePerTurn(ledger, calls);
    const s = session({ toolCalls: calls, ledger });
    const entries = buildTimeline(s, s.turns[1] as ReturnType<typeof turn>, { table });

    expect(entries.map((e) => e.seq)).toEqual([20, 22, 24, 26]);
    expect(entries[0]?.summary).toBe('uv run pytest -q');
    expect(entries[0]?.flags).toEqual(['test', 'check']);
    expect(entries[1]?.summary).toBe('/home/u/proj/src/app.py');
    expect(entries[1]?.flags).toEqual(['write']);
    expect(entries[1]?.files).toEqual(['/home/u/proj/src/app.py']);
    expect(entries[2]?.flags).toEqual(['git', 'danger', 'error']);
    expect(entries[2]?.exit).toBe(1);
    expect(entries[3]?.flags).toEqual(['background']);
    expect(entries[3]?.exit).toBeNull();
  });

  it('prices each call from the nearest usage row (Claude Code)', () => {
    const rows = [row(19), row(23, { attempts: [attempt({ in: 5000, out: 500 })] })];
    const s = session({ toolCalls: [call(20, { command: 'a' }), call(24, { command: 'b' })], usageRows: rows });
    const entries = buildTimeline(s, s.turns[1] as ReturnType<typeof turn>, { table });
    const usd19 = priceClaudeCode([rows[0] as UsageRow], { table }).usd;
    const usd23 = priceClaudeCode([rows[1] as UsageRow], { table }).usd;
    expect(entries[0]?.usd).toBe(usd19);
    expect(entries[1]?.usd).toBe(usd23);
    expect(usd19).not.toBe(usd23);
    expect(usd19).toBeGreaterThan(0);
  });

  it('prices from token deltas for Codex sessions and stays null for ledger sessions', () => {
    const codex = session({
      harness: 'codex',
      toolCalls: [call(20, { command: 'ls' })],
      tokenDeltas: [{ seq: 19, ts: '2026-03-01T17:00:00.000Z', model: 'gpt-5.2', input: 94642, cached: 82560, output: 2343, reasoning: 0, turnIndex: 1, lastInput: null }],
    });
    const codexEntries = buildTimeline(codex, codex.turns[1] as ReturnType<typeof turn>, { table });
    expect(codexEntries[0]?.usd).toBe(0.068394);

    const hook = session({ source: 'ledger', toolCalls: [call(20, { command: 'ls' })], usageRows: [row(19)] });
    const hookEntries = buildTimeline(hook, hook.turns[1] as ReturnType<typeof turn>, { table });
    expect(hookEntries[0]?.usd).toBeNull();
  });

  it('composes the interactive-input wording from the structured stdin facts', () => {
    const target = call(30, {
      command: 'python repl.py',
      background: true,
      exitCode: null,
      exitCodeSource: 'unknown',
      stdinWrites: [{ seq: 32, chars: 5, interrupted: true }],
    });
    const writer = call(32, { tool: 'write_stdin', kind: 'shell', stdinWrite: true });
    delete writer.command;
    const s = session({ harness: 'codex', toolCalls: [target, writer] });
    const entries = buildTimeline(s, s.turns[1] as ReturnType<typeof turn>, { table });
    expect(entries[1]?.summary).toBe('interactive input (5 chars) · interrupted by Ctrl-C');
  });

  it('sanitises summaries (no controls, single line) and caps their length', () => {
    const hostile = call(20, { command: `run[31m\nthis\tthing ${'x'.repeat(400)}` });
    const s = session({ toolCalls: [hostile] });
    const entries = buildTimeline(s, s.turns[1] as ReturnType<typeof turn>, { table });
    const summary = entries[0]?.summary as string;
    expect(summary).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(summary.startsWith('run this thing')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(160);
  });
});
