/**
 * S04 — streaming JSONL reader (§4.2.1): byte-only splitting, hazard
 * tolerance, type sniffing with count-only skipping, byte offsets and the
 * tail hash for incremental resume (§4.9).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RawLine } from '../../../src/model/types.js';
import {
  DEFAULT_COUNT_ONLY_TYPES,
  readJsonl,
  sniffType,
  splitLines,
  type JsonlSummary,
} from '../../../src/readers/jsonl.js';
import { sha256 } from '../../../src/util/hash.js';
import { FIXTURES_ROOT } from '../../helpers/fixtures.js';
import { makeTempDir } from '../../helpers/tmp.js';

const HAZARDS = join(FIXTURES_ROOT, 'hazards', 'u2028.jsonl');
const tmp = makeTempDir('showreceipts-jsonl-');
let fileCounter = 0;

afterAll(() => {
  // Cleaned up here so repeated runs never accumulate multi-MB temp files.
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes `content` to a fresh temp file and returns a file LineSource. */
function fileSource(content: string | Buffer): { kind: 'file'; path: string } {
  const path = join(tmp, `case-${fileCounter++}.jsonl`);
  writeFileSync(path, content);
  return { kind: 'file', path };
}

function textSource(text: string): { kind: 'text'; text: string; name: string } {
  return { kind: 'text', text, name: 'inline' };
}

/** Drains the generator, capturing both the yielded records and the returned summary. */
async function collect(gen: AsyncGenerator<RawLine, JsonlSummary, void>): Promise<{ records: RawLine[]; summary: JsonlSummary }> {
  const records: RawLine[] = [];
  let step = await gen.next();
  while (!step.done) {
    records.push(step.value);
    step = await gen.next();
  }
  return { records, summary: step.value };
}

function texts(records: RawLine[]): string[] {
  return records.map((r) => {
    const json = r.json as { text?: string; t?: string } | undefined;
    return json?.t ?? json?.text ?? '';
  });
}

describe('fixtures/hazards/u2028.jsonl (acceptance)', () => {
  it('parses all 10 records with hazards intact', async () => {
    const { records, summary } = await collect(readJsonl({ kind: 'file', path: HAZARDS }));

    expect(summary.lines).toBe(10);
    expect(summary.badLines).toBe(0);
    expect(records).toHaveLength(10);
    expect(records.every((r) => r.json !== undefined && r.bad === undefined && r.countOnly === undefined)).toBe(true);
    expect(records.map((r) => (r.json as { n: number }).n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Raw U+2028 ×3 + U+2029 ×2 in the file.
    expect(summary.lineSeparatorChars).toBeGreaterThanOrEqual(2);
    expect(summary.lineSeparatorChars).toBe(5);
    // Line 5 ends with \r\n and its value carries no \r.
    expect(summary.crlf).toBe(true);
    const t = texts(records);
    expect(t[0]).toBe('line one\u2028still line one');
    expect(t[1]).toBe('para one\u2029still para one');
    expect(t[4]).toBe('this line ends with CRLF');
    expect(t[6]).toContain('\u0085');
    // The 3 MB line parsed in one piece across chunk boundaries.
    const big = t[5] ?? '';
    expect(big.length).toBeGreaterThanOrEqual(2_900_000);
    expect(summary.maxLineBytes).toBeGreaterThanOrEqual(3_000_000);
  });

  it('chains byteOffset/bytes exactly and hashes the parsed tail (stable)', async () => {
    const bytes = readFileSync(HAZARDS);
    const first = await collect(readJsonl({ kind: 'file', path: HAZARDS }));
    const second = await collect(readJsonl({ kind: 'file', path: HAZARDS }));

    expect(first.records[0]?.byteOffset).toBe(0);
    for (let i = 1; i < first.records.length; i++) {
      const prev = first.records[i - 1]!;
      expect(first.records[i]!.byteOffset).toBe(prev.byteOffset + prev.bytes);
    }
    // File ends with \n: everything is parsed.
    expect(first.summary.bytesParsed).toBe(bytes.length);
    expect(first.summary.bytes).toBe(bytes.length);
    expect(first.summary.tailHash).toBe(sha256(bytes.subarray(bytes.length - 4096)));
    expect(second.summary.tailHash).toBe(first.summary.tailHash);
  });
});

describe('line splitting and termination', () => {
  it('yields nothing for an empty file', async () => {
    const { records, summary } = await collect(readJsonl(fileSource('')));
    expect(records).toEqual([]);
    expect(summary).toEqual({
      lines: 0,
      bytes: 0,
      badLines: 0,
      bytesParsed: 0,
      tailHash: sha256(Buffer.alloc(0)),
      countOnly: {},
      lineSeparatorChars: 0,
      maxLineBytes: 0,
      crlf: false,
    });
  });

  it('parses a valid trailing line without a newline but excludes it from bytesParsed/tailHash', async () => {
    const src = fileSource('{"a":1}\n{"b":2}');
    const { records, summary } = await collect(readJsonl(src));
    expect(records.map((r) => r.json)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(summary.lines).toBe(2);
    expect(summary.badLines).toBe(0);
    expect(summary.bytes).toBe(15);
    expect(summary.bytesParsed).toBe(8);
    expect(summary.tailHash).toBe(sha256('{"a":1}\n'));
    expect(records[1]!.bytes).toBe(7); // no terminator
  });

  it('counts an invalid trailing partial line as bad without throwing', async () => {
    const { records, summary } = await collect(readJsonl(fileSource('{"a":1}\n{"b":')));
    expect(records[1]!.bad).toBe(true);
    expect(records[1]!.json).toBeUndefined();
    expect(summary.lines).toBe(1);
    expect(summary.badLines).toBe(1);
    expect(summary.bytesParsed).toBe(8);
  });

  it('tolerates \\r\\n endings, stripping exactly one trailing \\r', async () => {
    const { records, summary } = await collect(readJsonl(fileSource('{"t":"a"}\r\n{"t":"b\\r"}\r\n')));
    expect(texts(records)).toEqual(['a', 'b\r']);
    expect(summary.crlf).toBe(true);
    expect(summary.lines).toBe(2);
    expect(records[0]!.bytes).toBe(11);
    expect(records[1]!.byteOffset).toBe(11);
    expect(summary.bytesParsed).toBe(24);
  });

  it('a complete bad line is included in bytesParsed (resume never re-reads it)', async () => {
    const { records, summary } = await collect(readJsonl(fileSource('not json\n{"a":1}\n')));
    expect(records[0]!.bad).toBe(true);
    expect(summary.badLines).toBe(1);
    expect(summary.lines).toBe(1);
    expect(summary.bytesParsed).toBe(17);
  });

  it('skips blank lines without counting them', async () => {
    const { records, summary } = await collect(readJsonl(fileSource('\n\n{"a":1}\n\r\n')));
    expect(records).toHaveLength(1);
    expect(records[0]!.byteOffset).toBe(2);
    expect(summary.lines).toBe(1);
    expect(summary.badLines).toBe(0);
    expect(summary.bytesParsed).toBe(12);
  });

  it('reassembles a 2 MB line split across 1 MiB chunk boundaries', async () => {
    const y = 'y'.repeat(2 * 1024 * 1024);
    const src = fileSource(`{"t":"first"}\n{"t":"${y}"}\n{"t":"last"}\n`);
    const { records, summary } = await collect(readJsonl(src));
    expect(summary.lines).toBe(3);
    expect(summary.badLines).toBe(0);
    expect(texts(records)[1]).toBe(y);
    expect(summary.maxLineBytes).toBe(y.length + 8);
  });
});

describe('hazard bytes inside strings', () => {
  it('keeps raw U+2028, U+2029 and NEL intact (one record each, no splitting)', async () => {
    const text = '{"t":"a\u2028b"}\n{"t":"a\u2029b"}\n{"t":"a\u0085b"}\n';
    const { records, summary } = await collect(readJsonl(textSource(text)));
    expect(summary.lines).toBe(3);
    expect(summary.badLines).toBe(0);
    expect(texts(records)).toEqual(['a\u2028b', 'a\u2029b', 'a\u0085b']);
    expect(summary.lineSeparatorChars).toBe(2);
  });

  it('keeps an escaped NUL intact and reports a raw NUL byte as bad, never throwing', async () => {
    // Strict JSON rejects raw control bytes < 0x20 inside strings, so the raw
    // NUL line becomes `bad` (gracefully); the escaped form round-trips.
    const raw = Buffer.concat([
      Buffer.from('{"t":"a\\u0000b"}\n'),
      Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0x61, 0x00, 0x62, 0x22, 0x7d, 0x0a]), // {"t":"a<NUL>b"}\n
      Buffer.from('{"t":"after"}\n'),
    ]);
    const { records, summary } = await collect(readJsonl(fileSource(raw)));
    expect(records).toHaveLength(3);
    expect(texts([records[0]!])[0]).toBe('a\u0000b');
    expect(records[1]!.bad).toBe(true);
    expect(records[2]!.json).toEqual({ t: 'after' });
    expect(summary.badLines).toBe(1);
    expect(summary.lines).toBe(2);
  });

  it('decodes invalid UTF-8 bytes inside a string to replacement characters without throwing', async () => {
    const raw = Buffer.concat([Buffer.from('{"t":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('b"}\n')]);
    const { records, summary } = await collect(readJsonl(fileSource(raw)));
    expect(summary.badLines).toBe(0);
    expect(summary.lines).toBe(1);
    expect(texts(records)[0]).toBe('a\uFFFD\uFFFDb');
  });
});

describe('type sniffing and count-only skipping', () => {
  it('exports the §4.2.1 default count-only set', () => {
    expect(DEFAULT_COUNT_ONLY_TYPES.size).toBe(12);
    for (const t of ['mode', 'permission-mode', 'ai-title', 'last-prompt', 'agent-name', 'atis-latch', 'queue-operation', 'attachment', 'file-history-snapshot', 'file-history-delta', 'bridge-session', 'frame-link']) {
      expect(DEFAULT_COUNT_ONLY_TYPES.has(t)).toBe(true);
    }
  });

  it('counts count-only lines without materialising their JSON', async () => {
    const text =
      '{"type":"mode","mode":"default"}\n' +
      '{"type":"mode","mode":"plan"}\n' +
      '{"type":"last-prompt","text":"hi"}\n' +
      '{"type":"file-history-snapshot","big":"blob"}\n' +
      '{"type":"user","text":"kept"}\n';
    const { records, summary } = await collect(readJsonl(textSource(text)));
    expect(summary.lines).toBe(5);
    expect(summary.countOnly).toEqual({ mode: 2, 'last-prompt': 1, 'file-history-snapshot': 1 });
    const skipped = records.filter((r) => r.countOnly === true);
    expect(skipped).toHaveLength(4);
    expect(skipped.every((r) => r.json === undefined && r.sniffedType !== null)).toBe(true);
    expect(records[4]!.json).toEqual({ type: 'user', text: 'kept' });
    expect(records[4]!.sniffedType).toBe('user');
  });

  it('returns null (and parses) when "type" appears after the 256-byte window', async () => {
    const line = `{"pad":"${'a'.repeat(300)}","type":"mode"}`;
    expect(sniffType(Buffer.from(line))).toBeNull();
    const { records, summary } = await collect(readJsonl(textSource(`${line}\n`)));
    expect(records[0]!.sniffedType).toBeNull();
    expect(records[0]!.countOnly).toBeUndefined();
    expect(records[0]!.json).toEqual({ pad: 'a'.repeat(300), type: 'mode' });
    expect(summary.countOnly).toEqual({});
  });

  it('parses an attachment only when its bytes carry the edited_text_file or hook_system_message marker', async () => {
    const text =
      '{"type":"attachment","attachment":{"type":"edited_text_file","filename":"a.ts","snippet":"x"}}\n' +
      '{"type":"attachment","attachment":{"type":"hook_system_message","content":"receipt"}}\n' +
      '{"type":"attachment","attachment":{"type":"image","path":"p.png"}}\n';
    const { records, summary } = await collect(readJsonl(textSource(text)));
    expect(records[0]!.json).toBeDefined();
    expect(records[0]!.countOnly).toBeUndefined();
    expect(records[1]!.json).toBeDefined();
    expect(records[2]!.countOnly).toBe(true);
    expect(records[2]!.json).toBeUndefined();
    expect(summary.countOnly).toEqual({ attachment: 1 });
  });

  it('parseCountOnly drives ai-title: parsed until a title is seen, counted afterwards', async () => {
    const text = '{"type":"ai-title","title":"first"}\n{"type":"ai-title","title":"second"}\n';
    let titleSeen = false;
    const gen = readJsonl(textSource(text), { parseCountOnly: (t) => t === 'ai-title' && !titleSeen });
    const records: RawLine[] = [];
    let step = await gen.next();
    while (!step.done) {
      const r = step.value;
      records.push(r);
      if (r.sniffedType === 'ai-title' && r.json !== undefined) titleSeen = true;
      step = await gen.next();
    }
    expect(records[0]!.json).toEqual({ type: 'ai-title', title: 'first' });
    expect(records[1]!.countOnly).toBe(true);
    expect(step.value.countOnly).toEqual({ 'ai-title': 1 });
    expect(step.value.lines).toBe(2);
  });

  it('sniff: false parses everything and never sniffs', async () => {
    const { records, summary } = await collect(readJsonl(textSource('{"type":"mode","mode":"plan"}\n'), { sniff: false }));
    expect(records[0]!.sniffedType).toBeNull();
    expect(records[0]!.json).toEqual({ type: 'mode', mode: 'plan' });
    expect(summary.countOnly).toEqual({});
  });

  it('a custom countOnlyTypes set replaces the default', async () => {
    const { records } = await collect(
      readJsonl(textSource('{"type":"user","text":"skipped"}\n{"type":"mode"}\n'), { countOnlyTypes: new Set(['user']) }),
    );
    expect(records[0]!.countOnly).toBe(true);
    expect(records[1]!.json).toEqual({ type: 'mode' });
  });
});

describe('incremental resume (startOffset, bytesParsed, tailHash)', () => {
  it('resuming at a record boundary yields exactly the lines after the offset', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `{"type":"user","n":${i}}`);
    const src = fileSource(`${lines.join('\n')}\n`);
    const full = await collect(readJsonl(src));
    const resumeAt = full.records[2]!.byteOffset;

    const resumed = await collect(readJsonl(src, { startOffset: resumeAt }));
    expect(resumed.records.map((r) => (r.json as { n: number }).n)).toEqual([2, 3, 4]);
    expect(resumed.records.map((r) => r.byteOffset)).toEqual(full.records.slice(2).map((r) => r.byteOffset));
    expect(resumed.records.map((r) => r.seq)).toEqual([0, 1, 2]);
    // Absolute coordinates agree with the full pass, so the §4.9 cache can
    // store them interchangeably.
    expect(resumed.summary.bytesParsed).toBe(full.summary.bytesParsed);
    expect(resumed.summary.tailHash).toBe(full.summary.tailHash);
    expect(resumed.summary.bytes).toBe(full.summary.bytes - resumeAt);
  });

  it('resume after a partial-tail read picks up exactly the completed record', async () => {
    const path = join(tmp, 'grow.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":2');
    const first = await collect(readJsonl({ kind: 'file', path }));
    expect(first.summary.bytesParsed).toBe(8);

    writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const second = await collect(readJsonl({ kind: 'file', path }, { startOffset: first.summary.bytesParsed }));
    expect(second.records.map((r) => r.json)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(second.summary.bytesParsed).toBe(24);
  });

  it('hashes the tail window across the resume boundary (bytes the resumed pass never streamed)', async () => {
    // 8 KB file, resume just before the last line: the 4096-byte tail window
    // starts inside the region the resumed pass did not read.
    const filler = Array.from({ length: 80 }, (_, i) => `{"n":${i},"pad":"${'p'.repeat(80)}"}`);
    const src = fileSource(`${filler.join('\n')}\n`);
    const full = await collect(readJsonl(src));
    const last = full.records[full.records.length - 1]!;

    const resumed = await collect(readJsonl(src, { startOffset: last.byteOffset }));
    expect(resumed.records).toHaveLength(1);
    expect(resumed.summary.tailHash).toBe(full.summary.tailHash);
    const bytes = readFileSync(src.path);
    expect(full.summary.tailHash).toBe(sha256(bytes.subarray(bytes.length - 4096)));
  });

  it('startOffset works on text sources too', async () => {
    const text = '{"n":1}\n{"n":2}\n';
    const { records, summary } = await collect(readJsonl(textSource(text), { startOffset: 8 }));
    expect(records.map((r) => r.json)).toEqual([{ n: 2 }]);
    expect(records[0]!.byteOffset).toBe(8);
    expect(summary.bytesParsed).toBe(16);
    expect(summary.tailHash).toBe(sha256(Buffer.from(text)));
  });
});

describe('maxLineBytes guard', () => {
  it('reports an oversized line as bad without decoding it and still tracks the largest line', async () => {
    const long = `{"t":"${'z'.repeat(200)}"}`;
    const { records, summary } = await collect(readJsonl(textSource(`{"t":"ok"}\n${long}\n`), { maxLineBytes: 100 }));
    expect(records[0]!.json).toEqual({ t: 'ok' });
    expect(records[1]!.bad).toBe(true);
    expect(records[1]!.json).toBeUndefined();
    expect(summary.badLines).toBe(1);
    expect(summary.maxLineBytes).toBe(long.length);
  });
});

describe('exported helpers', () => {
  it('sniffType finds the first type within 256 bytes', () => {
    expect(sniffType(Buffer.from('{"type":"assistant","message":{}}'))).toBe('assistant');
    expect(sniffType(Buffer.from('{"type":"file-history-snapshot"}'))).toBe('file-history-snapshot');
    expect(sniffType(Buffer.from('{"parentUuid":null}'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });

  it('splitLines splits on 0x0A only and carries the remainder across calls', () => {
    const a = splitLines(Buffer.from('{"x":1}\n{"y'), Buffer.alloc(0));
    expect(a.lines.map(String)).toEqual(['{"x":1}']);
    expect(String(a.carry)).toBe('{"y');
    const b = splitLines(Buffer.from('":2}\r\n{"z":3}'), a.carry);
    expect(b.lines.map(String)).toEqual(['{"y":2}\r']); // \r kept: the caller strips it
    expect(String(b.carry)).toBe('{"z":3}');
    const c = splitLines(Buffer.from('\u2028between\n'), Buffer.alloc(0));
    expect(c.lines.map(String)).toEqual(['\u2028between']); // U+2028 never splits
    expect(c.carry.length).toBe(0);
  });
});
