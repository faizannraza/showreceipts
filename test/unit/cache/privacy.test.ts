/**
 * Pass-2 closing review — §4.9 privacy of the stored builder state. A cache
 * entry's `builderState` used to carry every turn's raw prompt text verbatim
 * (`groups[].userText`), violating "never prompt text" (§4.9, §13.1: prompt
 * content is ≤ 512 B masked in the cache). `pipeline/redact-state.ts` nulls
 * every finalized group's text at the cache-write seam, memoising its §4.7
 * echo hashes first so a warm incremental resume still reproduces the cold
 * echo check byte for byte; the still-open trailing group keeps its text for
 * the Stop-resume flow (a deliberate, documented exception).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session, SessionRef } from '../../../src/model/types.js';
import { cacheKey, createCache, trimForCache, type CacheEntry } from '../../../src/cache/cache.js';
import { echoHashes } from '../../../src/claims/text.js';
import { redactBuilderState } from '../../../src/pipeline/redact-state.js';
import { enrichSession } from '../../../src/pipeline/resolve-session.js';
import { readClaudeCodeSession, resumeSession } from '../../../src/readers/claude-code/reader.js';
import { cc, type CC } from '../../helpers/cc-lines.js';
import { withTempDir } from '../../helpers/tmp.js';

const TOOL = '0.1.0';
const HOME = '/home/u';
/** Distinctive, sentence-length marker so `echoHashes` produces entries for it. */
const MARKER = 'PROPRIETARY_MARKER_9f3e the quarterly revenue projection is confidential business text that must never be cached.';

function textOf(t: CC): string {
  const src = t.src();
  if (src.kind !== 'text') throw new Error('CC.src() is always a text source');
  return src.text;
}

function refOf(t: CC, path: string): SessionRef {
  const stat = statSync(path);
  return { harness: 'claude-code', sessionId: t.sid, path, size: stat.size, mtimeMs: stat.mtimeMs, subagentManifest: [] };
}

/** One full turn: human prompt → Bash round-trip → final message. */
function pushTurn(t: CC, n: number, prompt?: string): void {
  t.human(prompt ?? `request ${n}`, { promptId: `p${n}` });
  t.assistant({ stop: 'tool_use', tools: [{ id: `tu-${n}`, name: 'Bash', input: { command: 'npm test' } }] });
  t.toolResult(`tu-${n}`, 'ok');
  t.assistant({ text: `done with request ${n}`, stop: 'end_turn' });
}

/** Serialized-state groups, parsed out of a builder state string. */
function groupsOf(state: string): { userText: string | null; echoHashes?: string[] }[] {
  return (JSON.parse(state) as { groups: { userText: string | null; echoHashes?: string[] }[] }).groups;
}

describe('builderState privacy (§4.9: the cache holds no finalized prompt text)', () => {
  it('a completed multi-turn session’s cache entry carries no finalized prompt text', () =>
    withTempDir(async (dir) => {
      const t = cc();
      pushTurn(t, 1, MARKER);
      pushTurn(t, 2);
      const path = join(dir, 'main.jsonl');
      writeFileSync(path, textOf(t));

      const ref = refOf(t, path);
      const parsed = await readClaudeCodeSession(ref, { home: HOME });
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL });
      const key = cacheKey(ref, TOOL);
      const entry: CacheEntry = {
        v: 1,
        key,
        session: trimForCache(parsed.session),
        bytesParsed: parsed.bytesParsed,
        tailHash: parsed.tailHash,
        builderState: redactBuilderState(parsed.builderState),
      };
      cache.put(key, entry);

      // The marker prompt appears nowhere in the entry file on disk.
      const raw = readFileSync(join(cacheDir, `${key}.json`), 'utf8');
      expect(raw).not.toContain('PROPRIETARY_MARKER_9f3e');

      // The finalized group is nulled with its echo hashes preserved; the
      // still-open trailing group keeps its text (Stop-resume exception).
      const stored = cache.get(key);
      if (stored === null || stored.builderState === undefined) throw new Error('entry vanished');
      const groups = groupsOf(stored.builderState);
      expect(groups).toHaveLength(2);
      expect(groups[0]?.userText).toBeNull();
      expect(groups[0]?.echoHashes).toEqual(echoHashes(MARKER));
      expect(groups[1]?.userText).toBe('request 2');
    }));

  it('a warm incremental resume from a redacted state reproduces the cold session (echo hashes included)', () =>
    withTempDir(async (dir) => {
      const t = cc();
      pushTurn(t, 1, MARKER);
      pushTurn(t, 2);
      const path = join(dir, 'main.jsonl');
      writeFileSync(path, textOf(t));

      const first = await readClaudeCodeSession(refOf(t, path), { home: HOME });
      const anchor = {
        bytesParsed: first.bytesParsed,
        tailHash: first.tailHash,
        builderState: redactBuilderState(first.builderState),
      };

      // A third turn lands between the Stops; the file grows in place.
      pushTurn(t, 3);
      writeFileSync(path, textOf(t));
      const ref = refOf(t, path);
      const resumed = enrichSession((await resumeSession(ref, anchor, { home: HOME })).session);
      const cold = enrichSession((await readClaudeCodeSession(ref, { home: HOME })).session);

      // §4.7/§4.9 parity: identical echo hashes cold and warm, so the echo
      // check judges identically; turn 1's text itself is privacy-nulled.
      expect(resumed.turns).toHaveLength(3);
      expect(resumed.turns.map((turn) => turn.echoHashes)).toEqual(cold.turns.map((turn) => turn.echoHashes));
      expect(resumed.turns[0]?.echoHashes).toEqual(echoHashes(MARKER));
      expect(resumed.turns[0]?.userText).toBeNull();
      expect(resumed.turns[1]?.userText).toBe('request 2'); // trailing at serialize time
      expect(resumed.turns[2]?.userText).toBe('request 3'); // parsed from the appended tail

      // Everything except the privacy-nulled prompt text is identical.
      const stripped = (s: Session): Session => {
        const clone = structuredClone(s);
        for (const turn of clone.turns) turn.userText = null;
        return clone;
      };
      expect(stripped(resumed)).toEqual(stripped(cold));
    }));

  it('redactBuilderState is tolerant and idempotent', () => {
    expect(redactBuilderState('not json {')).toBe('not json {');
    expect(redactBuilderState('{"v":2}')).toBe('{"v":2}');
    expect(redactBuilderState('{"v":1,"groups":"nope"}')).toBe('{"v":1,"groups":"nope"}');
    const state = JSON.stringify({
      v: 1,
      currentGroup: 2,
      groups: [
        { promptId: 'a', userText: 'finalized prompt one — long enough to hash as a sentence.' },
        { promptId: 'b', userText: null },
        { promptId: 'c', userText: 'the still-open current prompt' },
      ],
    });
    const once = redactBuilderState(state);
    expect(redactBuilderState(once)).toBe(once);
    const groups = groupsOf(once);
    expect(groups[0]?.userText).toBeNull();
    expect(groups[0]?.echoHashes).toEqual(echoHashes('finalized prompt one — long enough to hash as a sentence.'));
    expect(groups[1]?.userText).toBeNull();
    expect(groups[1]?.echoHashes).toBeUndefined();
    expect(groups[2]?.userText).toBe('the still-open current prompt'); // current AND trailing
  });
});
