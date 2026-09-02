/**
 * S08: the Codex output grammar (§4.3.3) — four parsers tried in order, and
 * the harness truncation markers stripped before runner parsers.
 */
import { describe, expect, it } from 'vitest';
import { parseCodexOutput } from '../../../../src/readers/codex/output.js';
import { jsonOutput, unifiedOutput } from '../../../helpers/codex-lines.js';

describe('unified-exec header (parser 1)', () => {
  it('parses chunk id, wall time, exit code, original token count and body', () => {
    const out = parseCodexOutput(unifiedOutput({ chunk: '8f5533', wall: '0.0520', exit: 0, originalTokens: 91, body: 'a\nb\n' }));
    expect(out.parser).toBe('unified');
    expect(out.exitCode).toBe(0);
    expect(out.exitCodeSource).toBe('harness');
    expect(out.chunkId).toBe('8f5533');
    expect(out.wallTimeMs).toBe(52);
    expect(out.originalTokens).toBe(91);
    expect(out.body).toBe('a\nb\n');
    expect(out.truncated).toBe(false);
    expect(out.isError).toBe(false);
  });

  it('parses a header without Original token count', () => {
    const out = parseCodexOutput('Chunk ID: aa\nWall time: 1.0000 seconds\nProcess exited with code 2\nOutput:\nx\n');
    expect(out.parser).toBe('unified');
    expect(out.exitCode).toBe(2);
    expect(out.originalTokens).toBeUndefined();
  });

  it('parses a running process (no exit yet)', () => {
    const out = parseCodexOutput(unifiedOutput({ session: 3055, originalTokens: 0, body: '' }));
    expect(out.running).toBe(true);
    expect(out.execSessionId).toBe(3055);
    expect(out.exitCode).toBeNull();
    expect(out.exitCodeSource).toBe('unknown');
  });

  it('passes a -1 exit through raw (the reader maps it to null + terminated)', () => {
    const out = parseCodexOutput(unifiedOutput({ exit: -1 }));
    expect(out.exitCode).toBe(-1);
    expect(out.exitCodeSource).toBe('harness');
  });

  it('only parses the header up to the first Output: line', () => {
    const body = 'literal\nOutput:\nProcess exited with code 9\n';
    const out = parseCodexOutput(unifiedOutput({ exit: 0, body }));
    expect(out.exitCode).toBe(0);
    expect(out.body).toBe(body);
  });
});

describe('JSON string output (parser 2, shell dialects)', () => {
  it('parses {output, metadata{exit_code, duration_seconds}}', () => {
    const out = parseCodexOutput(jsonOutput('Tests  12 passed (12)\n', 0, 2.3));
    expect(out.parser).toBe('json');
    expect(out.exitCode).toBe(0);
    expect(out.exitCodeSource).toBe('harness');
    expect(out.wallTimeMs).toBe(2300);
    expect(out.body).toBe('Tests  12 passed (12)\n');
  });

  it('rejects JSON without the expected shape', () => {
    expect(parseCodexOutput('{"stdout":"x"}').parser).toBe('none');
    expect(parseCodexOutput('{"output":"x","metadata":{}}').parser).toBe('none');
  });
});

describe('plain header (parser 3)', () => {
  it('parses Exit code + Wall time + Output', () => {
    const out = parseCodexOutput('Exit code: -2\nWall time: 1.5 seconds\nOutput:\nhi\n');
    expect(out.parser).toBe('plain');
    expect(out.exitCode).toBe(-2);
    expect(out.exitCodeSource).toBe('harness');
    expect(out.wallTimeMs).toBe(1500);
    expect(out.body).toBe('hi\n');
  });

  it('requires all three header parts', () => {
    expect(parseCodexOutput('Exit code: 0\nOutput:\nhi\n').parser).toBe('none');
    expect(parseCodexOutput('Exit code: 0\nWall time: 1 seconds\nhi').parser).toBe('none');
  });
});

describe('failure prefixes (parser 4)', () => {
  it('reads shell_command failed: with an embedded exit_code', () => {
    const out = parseCodexOutput('shell_command failed: something went wrong exit_code: 1, more');
    expect(out.parser).toBe('failure');
    expect(out.isError).toBe(true);
    expect(out.exitCode).toBe(1);
    expect(out.exitCodeSource).toBe('parsed');
    expect(out.denied).toBeUndefined();
  });

  it('flags a sandbox denial (never a run, never a danger/network fact)', () => {
    const out = parseCodexOutput(
      'exec_command failed: CreateProcess { message: "Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 1, ... }))" }',
    );
    expect(out.denied).toBe('sandbox-denied');
    expect(out.isError).toBe(true);
    expect(out.exitCode).toBe(1);
    expect(out.exitCodeSource).toBe('parsed');
  });

  it('leaves the exit unknown when nothing is embedded (write_stdin failed:)', () => {
    const out = parseCodexOutput('write_stdin failed: session not found');
    expect(out.parser).toBe('failure');
    expect(out.exitCode).toBeNull();
    expect(out.exitCodeSource).toBe('unknown');
  });
});

describe('no parser matches', () => {
  it('returns parser none with an unknown exit — never green', () => {
    const out = parseCodexOutput('just some plain text without any header');
    expect(out.parser).toBe('none');
    expect(out.exitCode).toBeNull();
    expect(out.exitCodeSource).toBe('unknown');
    expect(out.body).toBe('just some plain text without any header');
  });
});

describe('harness truncation markers (§4.3.3)', () => {
  it('strips a leading Total output lines marker and sets truncated', () => {
    const out = parseCodexOutput(unifiedOutput({ exit: 0, originalTokens: 24000, body: 'Total output lines: 4000\nkeep me\n' }));
    expect(out.truncated).toBe(true);
    expect(out.body).toBe('keep me\n');
    expect(out.originalTokens).toBe(24000);
  });

  it('removes a …N tokens truncated… marker line anywhere in the body', () => {
    const out = parseCodexOutput(unifiedOutput({ exit: 0, body: 'head\n…14000 tokens truncated…\ntail\n' }));
    expect(out.truncated).toBe(true);
    expect(out.body).toBe('head\ntail\n');
  });

  it('handles both markers together and inside JSON outputs too', () => {
    const out = parseCodexOutput(jsonOutput('Total output lines: 9\na\n…3 tokens truncated…\nb\n', 0));
    expect(out.truncated).toBe(true);
    expect(out.body).toBe('a\nb\n');
  });

  it('does not touch bodies without markers', () => {
    const out = parseCodexOutput(unifiedOutput({ exit: 0, body: 'Total output lines exceeded\n' }));
    expect(out.truncated).toBe(false);
    expect(out.body).toBe('Total output lines exceeded\n');
  });
});
