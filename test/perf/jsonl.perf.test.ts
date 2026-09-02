/**
 * S04 throughput floor (§4.2.1): full read + JSON.parse of a 60 MB synthetic
 * transcript at ≥ 60 MB/s. Runs only under `npm run test:perf`
 * (`SHOWRECEIPTS_PERF=1` via scripts/perf.mjs); self-skips otherwise. The
 * synthetic file is generated once into os.tmpdir() and reused across runs.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonl } from '../../src/readers/jsonl.js';

const PERF = process.env['SHOWRECEIPTS_PERF'] === '1';
const TARGET_BYTES = 60 * 1024 * 1024;
const FLOOR_MB_PER_S = 60;

/** Deterministic, realistically shaped transcript line (no Math.random). */
function syntheticLine(i: number): string {
  const filler = 'the quick brown fox jumps over the lazy dog while tokens stream past '.repeat(4);
  const ts = `2026-08-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
  switch (i % 7) {
    case 0:
      return JSON.stringify({
        type: 'user',
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        timestamp: ts,
        message: { role: 'user', content: [{ type: 'text', text: `prompt ${i}: ${filler}` }] },
      });
    case 3:
      return JSON.stringify({ type: 'mode', mode: i % 2 === 0 ? 'default' : 'plan', timestamp: ts, filler });
    case 5:
      return JSON.stringify({
        type: 'user',
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        timestamp: ts,
        toolUseResult: { stdout: filler, stderr: '', interrupted: false, isImage: false },
      });
    default:
      return JSON.stringify({
        type: 'assistant',
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        timestamp: ts,
        message: {
          id: `msg_${String(i).padStart(8, '0')}`,
          role: 'assistant',
          model: 'claude-fable-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: `answer ${i}: ${filler}` }],
          usage: { input_tokens: 12, output_tokens: 345, cache_read_input_tokens: 67890 },
        },
      });
  }
}

/** Generates (once) and returns the 60 MB synthetic transcript path. */
function ensureBigFile(): string {
  const dir = join(tmpdir(), 'showreceipts-perf');
  const path = join(dir, 'jsonl-60mb-v1.jsonl');
  if (existsSync(path) && statSync(path).size >= TARGET_BYTES) return path;
  mkdirSync(dir, { recursive: true });
  const block = `${Array.from({ length: 4096 }, (_, i) => syntheticLine(i)).join('\n')}\n`;
  const blockBytes = Buffer.byteLength(block);
  const repeats = Math.ceil(TARGET_BYTES / blockBytes);
  writeFileSync(path, block.repeat(repeats));
  return path;
}

describe.skipIf(!PERF)('readJsonl throughput (§4.2.1 floor)', () => {
  it(`fully parses a 60 MB transcript at >= ${FLOOR_MB_PER_S} MB/s`, async () => {
    const path = ensureBigFile();

    // Warm pass: OS page cache + JIT, so the floor measures the reader.
    const warmGen = readJsonl({ kind: 'file', path });
    let warm = await warmGen.next();
    while (!warm.done) warm = await warmGen.next();

    const gen = readJsonl({ kind: 'file', path });
    const t0 = performance.now();
    let records = 0;
    let step = await gen.next();
    while (!step.done) {
      records++;
      step = await gen.next();
    }
    const seconds = (performance.now() - t0) / 1000;
    const summary = step.value;

    const mb = summary.bytes / (1024 * 1024);
    const rate = mb / seconds;
    process.stdout.write(`jsonl: ${mb.toFixed(1)} MB in ${seconds.toFixed(2)} s = ${rate.toFixed(0)} MB/s (${records} records, ${summary.badLines} bad)\n`);

    expect(summary.badLines).toBe(0);
    expect(records).toBeGreaterThan(50_000);
    expect(mb).toBeGreaterThanOrEqual(60);
    expect(rate).toBeGreaterThanOrEqual(FLOOR_MB_PER_S);
  }, 120_000);
});
