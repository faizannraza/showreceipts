/**
 * S27 — `hook/record.ts` (Appendix C writer): exactly one `appendFileSync`
 * per event with `{flag:'a', mode:0o600}`, field truncation (out.text
 * head/tail ≤ 16 KiB, agent-response ≤ 64 KiB, in.raw ≤ 4 KiB, edits ≤ 32 ×
 * 4 KiB), masking, the 256 KiB hard cap, the salvage tool-post/gap lines and
 * the stable fallback tool id.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerLine } from '../../../src/model/types.js';
import {
  AGENT_RESPONSE_MAX_BYTES,
  appendLedgerLine,
  EDIT_MAX_BYTES,
  EDITS_MAX,
  fallbackToolId,
  headTail,
  IN_RAW_MAX_BYTES,
  OUT_TEXT_MAX_BYTES,
  prepareLedgerLine,
  PROMPT_MAX_BYTES,
  salvageLedgerLine,
  truncateUtf8,
} from '../../../src/hook/record.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-record-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;

function toolPost(text: string, over: Partial<ToolPost> = {}): ToolPost {
  return {
    v: 1,
    t: T,
    h: 'cursor',
    e: 'tool-post',
    sid: 'sess-1',
    id: 'tu_1',
    tool: 'Shell',
    kind: 'shell',
    in: { command: 'npm test' },
    out: { text, bytes: Buffer.byteLength(text) },
    ...over,
  };
}

function asToolPost(line: LedgerLine): ToolPost {
  expect(line.e).toBe('tool-post');
  return line as ToolPost;
}

describe('appendLedgerLine: the Appendix C write contract', () => {
  it('issues exactly one appendFileSync per event with flag a and mode 0600, creating 0700 dirs', () => {
    const dir = tempDir();
    const path = join(dir, 'ledger', 'cursor', 's.jsonl');
    const spy = vi.spyOn(fs, 'appendFileSync');
    appendLedgerLine(path, toolPost('ok'));
    expect(spy).toHaveBeenCalledTimes(1);
    const [target, buf, opts] = spy.mock.calls[0] as [string, Buffer, { flag: string; mode: number }];
    expect(target).toBe(path);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(String(buf).endsWith('\n')).toBe(true);
    expect(opts).toEqual({ flag: 'a', mode: 0o600 });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(dir, 'ledger', 'cursor')).mode & 0o777).toBe(0o700);
    appendLedgerLine(path, toolPost('second'));
    expect(spy).toHaveBeenCalledTimes(2);
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('serialises the common fields first ({"v":1,"t":…)', () => {
    const dir = tempDir();
    const path = join(dir, 's.jsonl');
    appendLedgerLine(path, toolPost('x'));
    expect(fs.readFileSync(path, 'utf8').startsWith('{"v":1,"t":"')).toBe(true);
  });

  it('masks secrets before writing', () => {
    const dir = tempDir();
    const path = join(dir, 's.jsonl');
    appendLedgerLine(path, toolPost('token=abc123secret and sk-aaaaaaaaaaaaaaaaaaaaaaaa done'));
    const written = fs.readFileSync(path, 'utf8');
    expect(written).toContain('«masked»');
    expect(written).not.toContain('abc123secret');
    expect(written).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaa');
  });
});

describe('field truncation', () => {
  it('a 300 KiB out.text becomes head/tail ≤ 16 KiB with truncated:true and the original bytes', () => {
    const original = 300 * 1024;
    const line = asToolPost(prepareLedgerLine(toolPost('H'.repeat(1000) + 'x'.repeat(original - 2000) + 'T'.repeat(1000))));
    expect(Buffer.byteLength(line.out.text)).toBeLessThanOrEqual(OUT_TEXT_MAX_BYTES);
    expect(line.out.truncated).toBe(true);
    expect(line.out.bytes).toBe(original);
    expect(line.out.text.startsWith('HHH')).toBe(true);
    expect(line.out.text.endsWith('TTT')).toBe(true);
    expect(line.out.text).toContain('truncated');
  });

  it('an out.text within the cap is untouched', () => {
    const line = asToolPost(prepareLedgerLine(toolPost('short output')));
    expect(line.out.text).toBe('short output');
    expect(line.out.truncated).toBeUndefined();
  });

  it('edits are capped at 32 entries of ≤ 4 KiB each with editsTruncated', () => {
    const big = 'e'.repeat(5 * 1024);
    const line = asToolPost(
      prepareLedgerLine(toolPost('', { in: { edits: Array.from({ length: 40 }, () => ({ old: big, new: big })) } })),
    );
    expect(line.in.edits).toHaveLength(EDITS_MAX);
    for (const edit of line.in.edits ?? []) {
      expect(Buffer.byteLength(edit.old) + Buffer.byteLength(edit.new)).toBeLessThanOrEqual(EDIT_MAX_BYTES);
    }
    expect(line.in.editsTruncated).toBe(true);
  });

  it('edits within the caps stay intact with no editsTruncated', () => {
    const line = asToolPost(prepareLedgerLine(toolPost('', { in: { edits: [{ old: 'a', new: 'b' }] } })));
    expect(line.in.edits).toEqual([{ old: 'a', new: 'b' }]);
    expect(line.in.editsTruncated).toBeUndefined();
  });

  it('in.raw is cut to 4 KiB, agent-response to 64 KiB, prompt to 16 KiB', () => {
    const raw = asToolPost(prepareLedgerLine(toolPost('', { in: { raw: 'r'.repeat(10_000) } })));
    expect(Buffer.byteLength(raw.in.raw ?? '')).toBe(IN_RAW_MAX_BYTES);
    const response = prepareLedgerLine({ v: 1, t: T, h: 'cursor', e: 'agent-response', sid: 's', text: 'a'.repeat(100 * 1024) });
    expect(response.e).toBe('agent-response');
    if (response.e === 'agent-response') expect(Buffer.byteLength(response.text)).toBe(AGENT_RESPONSE_MAX_BYTES);
    const prompt = prepareLedgerLine({ v: 1, t: T, h: 'gemini', e: 'prompt', sid: 's', text: 'p'.repeat(20 * 1024) });
    expect(prompt.e).toBe('prompt');
    if (prompt.e === 'prompt') expect(Buffer.byteLength(prompt.text)).toBe(PROMPT_MAX_BYTES);
  });

  it('truncateUtf8 and headTail never split a multi-byte sequence', () => {
    expect(truncateUtf8('€€', 4)).toBe('€');
    expect(truncateUtf8('€€', 6)).toBe('€€');
    const cut = headTail('€'.repeat(10_000), 64);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(64);
    expect(cut.truncated).toBe(true);
    expect(cut.text.includes('�')).toBe(false);
  });
});

describe('the 256 KiB hard cap', () => {
  it('an over-cap line is clamped (strings ≤ 4 KiB) and kept when that suffices', () => {
    const line = asToolPost(prepareLedgerLine(toolPost('', { in: { command: 'c'.repeat(300 * 1024) } })));
    expect(Buffer.byteLength(line.in.command ?? '')).toBe(EDIT_MAX_BYTES);
  });

  it('a line still over the cap after clamping degrades to gap{reason:oversize}', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `${i}-${'p'.repeat(3000)}`);
    const line = prepareLedgerLine(toolPost('', { in: { paths } }));
    expect(line.e).toBe('gap');
    if (line.e === 'gap') {
      expect(line.reason).toBe('oversize');
      expect(line.bytes).toBeGreaterThan(0);
      expect(line.sid).toBe('sess-1');
    }
  });
});

describe('salvage lines', () => {
  it('with a salvaged tool_name: a tool-post with out {text:"", bytes, truncated:true} and exitSource unknown', () => {
    const line = salvageLedgerLine({
      t: T,
      harness: 'cursor',
      sid: 'sess-9',
      salvage: { toolName: 'Shell', command: 'npm t', filePath: 'a.ts', tid: 'g1' },
      bytes: 999,
      reason: 'oversize',
    });
    const post = asToolPost(line);
    expect(post.out).toEqual({ text: '', bytes: 999, truncated: true });
    expect(post.exitSource).toBe('unknown');
    expect(post.in).toEqual({ command: 'npm t', path: 'a.ts' });
    expect(post.tid).toBe('g1');
    expect(post.kind).toBe('shell');
    expect(post.tool).toBe('Shell');
    expect(post.id).toMatch(/^h[0-9a-f]{12}$/);
  });

  it('a salvaged tool without a command is kind other', () => {
    const line = asToolPost(
      salvageLedgerLine({ t: T, harness: 'copilot', sid: 's', salvage: { toolName: 'view' }, bytes: 5, reason: 'unparsable' }),
    );
    expect(line.kind).toBe('other');
    expect(line.in).toEqual({});
  });

  it('without a tool_name: gap with the reason and bytes', () => {
    const line = salvageLedgerLine({ t: T, harness: 'gemini', sid: 's', salvage: { tid: 'turn-1' }, bytes: 123, reason: 'unparsable' });
    expect(line.e).toBe('gap');
    if (line.e === 'gap') {
      expect(line.reason).toBe('unparsable');
      expect(line.bytes).toBe(123);
      expect(line.tid).toBe('turn-1');
    }
  });
});

describe('fallbackToolId', () => {
  it('is h + 12 hex, stable for identical (t, tool, in) and sensitive to each part', () => {
    const id = fallbackToolId(T, 'Shell', { command: 'x' });
    expect(id).toMatch(/^h[0-9a-f]{12}$/);
    expect(fallbackToolId(T, 'Shell', { command: 'x' })).toBe(id);
    expect(fallbackToolId(T, 'Shell', { command: 'y' })).not.toBe(id);
    expect(fallbackToolId(T, 'Write', { command: 'x' })).not.toBe(id);
    expect(fallbackToolId('2026-08-29T12:00:01.000Z', 'Shell', { command: 'x' })).not.toBe(id);
  });
});
