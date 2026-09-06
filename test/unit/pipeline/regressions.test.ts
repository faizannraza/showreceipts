/**
 * Closing-review regressions (Pass 1) for the pipeline seams:
 *
 *  - `enrichSession` masks every string and caps `finalText` at the §4.9
 *    64 KiB budget — the same bytes a warm (cache-restored) session carries,
 *    closing the cold-path secret leak into receipts and reports.
 *  - a windowed id lookup that misses names the window instead of falsely
 *    implying the session does not exist.
 */
import { describe, expect, it } from 'vitest';
import type { Roots } from '../../../src/model/types.js';
import { enrichSession, NotFoundError, resolveSession } from '../../../src/pipeline/resolve-session.js';
import { MASK } from '../../../src/util/mask.js';
import { call, session, turn } from '../reconcile/harness.js';

describe('enrichSession masks and caps at the §4.9 seam', () => {
  it('masks secrets in finalText and command strings', () => {
    const s = session();
    s.turns[1] = turn({
      finalText: 'Deployed with token=SECRETVALUE123456 and key sk-abcdefghijklmnopqrstuvwxyz123456.',
    });
    s.toolCalls = [call(50, { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://x' })];
    const out = enrichSession(s);
    const final = out.turns.find((t) => t.index === 1)?.finalText ?? '';
    expect(final).not.toContain('SECRETVALUE123456');
    expect(final).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(final).toContain(MASK);
    expect(out.toolCalls[0]?.command).not.toContain('Bearer abcdefghijklmnopqrstuvwx');
  });

  it('caps finalText at 64 KiB (warm-cache parity)', () => {
    const s = session();
    s.turns[1] = turn({ finalText: 'a'.repeat(70 * 1024) });
    const out = enrichSession(s);
    expect(Buffer.byteLength(out.turns.find((t) => t.index === 1)?.finalText ?? '', 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('windowed id lookups name the window on a miss', () => {
  const roots = { userHome: '/home/u' } as unknown as Roots;

  it('a miss over a windowed set says how to widen it', async () => {
    await expect(resolveSession('a54ed0e9', { sessions: [], roots, cwd: '/home/u', window: { all: false, since: '90d' } })).rejects.toThrow(
      /no session matches 'a54ed0e9' in the selected window \(--since 90d\).*--all/,
    );
  });

  it('a miss under --all keeps the plain message', async () => {
    await expect(resolveSession('a54ed0e9', { sessions: [], roots, cwd: '/home/u', window: { all: true, since: '90d' } })).rejects.toThrow(
      /no session matches 'a54ed0e9'$/,
    );
  });

  it('the error stays a NotFoundError (exit 5 contract)', async () => {
    await expect(
      resolveSession('a54ed0e9', { sessions: [], roots, cwd: '/home/u', window: { all: false, since: '30d' } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
