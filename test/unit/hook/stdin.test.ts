/**
 * S27 — `hook/stdin.ts` (§9): drain to EOF with the 32 MiB cap, regex
 * salvage of the six listed fields from the first 64 KiB on overflow or
 * unparsable JSON, `{}` for a TTY and for an empty stream.
 */
import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readStdin, salvageFields, type ReadStdinOptions, type StdinRead } from '../../../src/hook/stdin.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Feeds `content` to `readStdin` through a real file descriptor. */
function readFrom(content: Buffer | string, options: Omit<ReadStdinOptions, 'fd' | 'isTTY'> = {}): StdinRead {
  const dir = makeTempDir('sr-stdin-');
  dirs.push(dir);
  const path = join(dir, 'stdin.bin');
  writeFileSync(path, content);
  const fd = openSync(path, 'r');
  try {
    return readStdin({ fd, isTTY: false, ...options });
  } finally {
    closeSync(fd);
  }
}

describe('readStdin: overflow', () => {
  it('a 40 MiB payload is drained to EOF, marked overflow, and every listed field is salvaged', () => {
    const head =
      '{"hook_event_name":"postToolUse","conversation_id":"conv-1","generation_id":"gen-9",' +
      '"tool_name":"Shell","tool_input":{"command":"npm test","file_path":"src/app.ts"},"pad":"';
    const total = 40 * 1024 * 1024;
    const buf = Buffer.alloc(total, 0x61);
    buf.write(head, 0, 'utf8');
    const r = readFrom(buf);
    expect(r.overflow).toBe(true);
    expect(r.bytes).toBe(total);
    expect(r.json).toBeNull();
    expect(r.salvage).toEqual({
      hookEventName: 'postToolUse',
      sid: 'conv-1',
      tid: 'gen-9',
      toolName: 'Shell',
      command: 'npm test',
      filePath: 'src/app.ts',
    });
  });

  it('exactly maxBytes parses; one byte less caps and salvages', () => {
    const payload = `{"tool_name":"Write","pad":"${'x'.repeat(100)}"}`;
    const size = Buffer.byteLength(payload);
    const ok = readFrom(payload, { maxBytes: size });
    expect(ok.overflow).toBe(false);
    expect(ok.json).toEqual(JSON.parse(payload));
    const over = readFrom(payload, { maxBytes: size - 1, salvageBytes: size });
    expect(over.overflow).toBe(true);
    expect(over.bytes).toBe(size);
    expect(over.json).toBeNull();
    expect(over.salvage.toolName).toBe('Write');
  });
});

describe('readStdin: unparsable, TTY, empty', () => {
  it('invalid JSON is salvaged from the head', () => {
    const text = '{"hook_event_name":"Stop","session_id":"sess-2","turn_id":"t-3",BROKEN';
    const r = readFrom(text);
    expect(r.json).toBeNull();
    expect(r.overflow).toBe(false);
    expect(r.bytes).toBe(Buffer.byteLength(text));
    expect(r.salvage.hookEventName).toBe('Stop');
    expect(r.salvage.sid).toBe('sess-2');
    expect(r.salvage.tid).toBe('t-3');
  });

  it('a TTY stdin is {} without touching the descriptor', () => {
    expect(readStdin({ fd: -1, isTTY: true })).toEqual({ json: {}, salvage: {}, bytes: 0, overflow: false });
  });

  it('an empty stream is {}', () => {
    expect(readFrom('')).toEqual({ json: {}, salvage: {}, bytes: 0, overflow: false });
  });

  it('a small valid payload parses with no salvage', () => {
    const r = readFrom('{"hook_event_name":"Stop","n":1}');
    expect(r).toEqual({ json: { hook_event_name: 'Stop', n: 1 }, salvage: {}, bytes: 32, overflow: false });
  });

  it('salvage only sees the first salvageBytes of the head', () => {
    const far = `{"pad":"${'y'.repeat(200)}","tool_name":"Late"`;
    const r = readFrom(far, { salvageBytes: 64 });
    expect(r.json).toBeNull();
    expect(r.salvage.toolName).toBeUndefined();
  });
});

describe('readStdin: drain-ending errors are reported, never thrown', () => {
  it('a dead descriptor (EBADF) yields {} plus an error report for hook.log', () => {
    const r = readStdin({ fd: 1_000_000, isTTY: false });
    expect(r.json).toEqual({});
    expect(r.bytes).toBe(0);
    expect(r.overflow).toBe(false);
    expect(r.error).toEqual({ code: 'EBADF', bytes: 0 });
  });

  it('a clean EOF never sets the error field', () => {
    expect(readFrom('')).toEqual({ json: {}, salvage: {}, bytes: 0, overflow: false });
    expect(readFrom('{"a":1}').error).toBeUndefined();
  });
});

describe('salvageFields', () => {
  it('conversation_id wins over session_id and sessionId; escapes are decoded', () => {
    const s = salvageFields('{"sessionId":"c","session_id":"b","conversation_id":"a","command":"echo \\"hi\\""}');
    expect(s.sid).toBe('a');
    expect(s.command).toBe('echo "hi"');
  });

  it('falls back through the sid aliases in order', () => {
    expect(salvageFields('{"sessionId":"c","session_id":"b"}').sid).toBe('b');
    expect(salvageFields('{"sessionId":"c"}').sid).toBe('c');
    expect(salvageFields('{"turn_id":"t1"}')).toEqual({ tid: 't1' });
    expect(salvageFields('{"toolName":"Bash"}')).toEqual({ toolName: 'Bash' });
    expect(salvageFields('nothing here')).toEqual({});
  });
});
