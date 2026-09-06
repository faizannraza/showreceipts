/**
 * S31 — ledger append concurrency (§9, Appendix C write contract): 16
 * simultaneous `hook cursor postToolUse` processes × 50 events each, all
 * appending 64 KiB `tool_output` bodies into ONE ledger file. The single
 * `O_APPEND` `appendFileSync` per event must never tear a line: 800 lines,
 * every one parseable, zero `badLines` through the S09 reader, mode `0600`.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionRef } from '../../src/model/types.js';
import { readLedgerSession } from '../../src/readers/ledger/reader.js';
import { PINNED_NOW, pinnedEnv } from '../helpers/env.js';
import { CLI_PATH, NETGUARD_PATH } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const LANES = 16;
const EVENTS_PER_LANE = 50;
const SID = 'concurrent-session';
const BODY_BYTES = 64 * 1024;

const srHome = makeTempDir('sr-hook-conc-');
const cwd = makeTempDir('sr-hook-conc-cwd-');

afterAll(() => {
  rmSync(srHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** One event payload: a unique id and a 64 KiB stdout body. */
function payload(lane: number, i: number): string {
  const marker = `L${lane}E${i}|`;
  const body = marker + 'x'.repeat(BODY_BYTES - marker.length);
  return JSON.stringify({
    conversation_id: SID,
    generation_id: `g${lane}`,
    hook_event_name: 'postToolUse',
    tool_name: 'Shell',
    tool_input: '{"command":"echo x"}',
    tool_output: JSON.stringify({ exitCode: 0, stdout: body }),
    tool_use_id: `t-${lane}-${i}`,
    cwd: '/w/proj',
  });
}

/** Spawns one hook process and resolves with its exit code, stdout, and any stdin write error. */
function spawnHook(env: Record<string, string>, stdin: string): Promise<{ code: number | null; stdout: string; stdinError?: string | undefined }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'hook', 'cursor', 'postToolUse', '--now', PINNED_NOW], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let stdinError: string | undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // A child that exits before draining the 64 KiB payload surfaces here as
    // an asynchronous 'error' (write EPIPE) on our write side; without a
    // listener it becomes an uncaught exception that kills the whole vitest
    // worker. Fold it into the result so the owning lane fails with its
    // event id instead.
    child.stdin.on('error', (err: Error) => {
      stdinError = err.message;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stdinError });
    });
    child.stdin.end(stdin);
  });
}

describe('hook ledger concurrency (§9: 16 × 50 events, one file)', () => {
  it(
    'appends 800 intact lines with zero badLines and mode 0600',
    async () => {
      const env = { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"`, SHOWRECEIPTS_HOME: srHome };
      const lane = async (n: number): Promise<void> => {
        for (let i = 0; i < EVENTS_PER_LANE; i++) {
          const result = await spawnHook(env, payload(n, i));
          expect(result.stdinError, `lane ${n} event ${i}: stdin write error`).toBeUndefined();
          expect(result.code, `lane ${n} event ${i}`).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({});
        }
      };
      await Promise.all(Array.from({ length: LANES }, (_, n) => lane(n)));

      // A zero-byte stdin drain answers {} and deposits its tool-post line
      // under an unknown-* sid file instead — any stray file here pinpoints
      // that drop mechanism on the next flake.
      expect(readdirSync(join(srHome, 'ledger', 'cursor'))).toEqual([`${SID}.jsonl`]);

      const path = join(srHome, 'ledger', 'cursor', `${SID}.jsonl`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(LANES * EVENTS_PER_LANE);

      // Every line parses individually and carries its unique tool id.
      const ids = new Set<string>();
      for (const line of lines) {
        const parsed = JSON.parse(line) as { e: string; id: string; sid: string };
        expect(parsed.e).toBe('tool-post');
        expect(parsed.sid).toBe(SID);
        ids.add(parsed.id);
      }
      expect(ids.size).toBe(LANES * EVENTS_PER_LANE);

      // The S09 reader agrees: zero badLines, one tool call per event.
      const ref: SessionRef = {
        harness: 'cursor',
        sessionId: SID,
        path,
        size: Buffer.byteLength(text, 'utf8'),
        mtimeMs: statSync(path).mtimeMs,
        subagentManifest: [],
        ledger: true,
      };
      const session = readLedgerSession(ref, { home: srHome, lines: { kind: 'text', text, name: `${SID}.jsonl` } });
      expect(session.diagnostics.badLines).toBe(0);
      expect(session.toolCalls).toHaveLength(LANES * EVENTS_PER_LANE);
    },
    600_000,
  );
});
