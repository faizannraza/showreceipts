/**
 * S27b — cache side of the resumable Stop path. Entries carry the resume
 * anchor `{bytesParsed (always a line boundary), tailHash (sha256 of the
 * ≤ 4 KiB preceding it), builderState}`; `lookupByPath` returns the newest
 * entry for a transcript path without re-keying by size/mtime; the
 * two-Stop flow (parse → put → grow → lookup → resume → put) advances
 * `bytesParsed`; entries never carry cost, `inherited`, or anything derived
 * from `--since`/`--as-of`; and the path index is keyed by the
 * discovery-spelled realpath, so a Stop hook must realpath its
 * `transcript_path` before `lookupByPath` (W1 merge note).
 */
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheKey, createCache, trimForCache, type CacheEntry } from '../../../src/cache/cache.js';
import type { SessionRef } from '../../../src/model/types.js';
import { readClaudeCodeSession, resumeSession } from '../../../src/readers/claude-code/reader.js';
import { sha256 } from '../../../src/util/hash.js';
import { cc, type CC } from '../../helpers/cc-lines.js';
import { withTempDir } from '../../helpers/tmp.js';

const TOOL = '0.1.0';
const HOME = '/home/u';

/** The transcript's current text (CC sources are always `kind: 'text'`). */
function textOf(t: CC): string {
  const src = t.src();
  if (src.kind !== 'text') throw new Error('CC.src() is always a text source');
  return src.text;
}

/** A `SessionRef` for the transcript file as it currently is on disk. */
function refOf(t: CC, path: string): SessionRef {
  const stat = statSync(path);
  return { harness: 'claude-code', sessionId: t.sid, path, size: stat.size, mtimeMs: stat.mtimeMs, subagentManifest: [] };
}

/** One full turn: human prompt → Bash tool round-trip → final message. */
function pushTurn(t: CC, n: number): void {
  t.human(`request ${n}`, { promptId: `p${n}` });
  t.assistant({ stop: 'tool_use', tools: [{ id: `tu-${n}`, name: 'Bash', input: { command: 'npm test' } }] });
  t.toolResult(`tu-${n}`, 'ok');
  t.assistant({ text: `done with request ${n}`, stop: 'end_turn' });
}

/** The entry a Stop hook would store after a parse. */
function entryFor(key: string, parsed: Awaited<ReturnType<typeof readClaudeCodeSession>>): CacheEntry {
  return {
    v: 1,
    key,
    session: trimForCache(parsed.session),
    bytesParsed: parsed.bytesParsed,
    tailHash: parsed.tailHash,
    builderState: parsed.builderState,
  };
}

describe('the two-Stop flow (S27b)', () => {
  it('put → lookupByPath → resume → put advances bytesParsed without re-keying by size/mtime', () =>
    withTempDir(async (dir) => {
      const t = cc();
      pushTurn(t, 1);
      const path = join(dir, 'main.jsonl');
      writeFileSync(path, textOf(t));

      const cache = createCache({ dir: join(dir, 'cache'), toolVersion: TOOL });
      const ref1 = refOf(t, path);
      const first = await readClaudeCodeSession(ref1, { home: HOME });
      const key1 = cacheKey(ref1, TOOL);
      cache.put(key1, entryFor(key1, first));

      // Stop 2 knows only the transcript path — no size, no mtime.
      const hit = cache.lookupByPath(path);
      if (hit === null) throw new Error('lookupByPath missed the entry just stored');
      expect(hit.key).toBe(key1);
      expect(hit.bytesParsed).toBe(first.bytesParsed);
      expect(typeof hit.builderState).toBe('string');

      // The anchor is a line boundary and the hash covers the window before it.
      const bytes1 = readFileSync(path);
      expect(hit.bytesParsed).toBeGreaterThan(0);
      expect(bytes1[hit.bytesParsed - 1]).toBe(0x0a);
      const win = Math.min(4096, hit.bytesParsed);
      expect(hit.tailHash).toBe(sha256(bytes1.subarray(hit.bytesParsed - win, hit.bytesParsed)));

      // A second turn lands between the Stops; the file grows in place.
      pushTurn(t, 2);
      writeFileSync(path, textOf(t));
      const ref2 = refOf(t, path);
      const resumed = await resumeSession(ref2, hit, { home: HOME });
      const cold = await readClaudeCodeSession(ref2, { home: HOME });
      expect(resumed.session).toEqual(cold.session);
      expect(resumed.session.turns).toHaveLength(2);
      expect(resumed.bytesParsed).toBeGreaterThan(hit.bytesParsed);

      // The grown file re-keys (size/mtime changed) but the path index follows.
      const key2 = cacheKey(ref2, TOOL);
      expect(key2).not.toBe(key1);
      cache.put(key2, entryFor(key2, resumed));
      const hit2 = cache.lookupByPath(path);
      if (hit2 === null) throw new Error('lookupByPath missed the second entry');
      expect(hit2.key).toBe(key2);
      expect(hit2.bytesParsed).toBeGreaterThan(hit.bytesParsed);
    }));

  it('a stored entry carries no cost, no inherited marks, nothing from --since/--as-of', () =>
    withTempDir(async (dir) => {
      const t = cc();
      pushTurn(t, 1);
      const path = join(dir, 'main.jsonl');
      writeFileSync(path, textOf(t));

      const ref = refOf(t, path);
      const parsed = await readClaudeCodeSession(ref, { home: HOME });
      // Simulate a fully-costed, dedupe-marked in-memory session (what the
      // pipeline holds after cost/reconcile ran) — none of it may be stored.
      parsed.session.cost.usd = 3.14;
      parsed.session.cost.pricesVersion = '2026-08-01';
      for (const turn of parsed.session.turns) turn.costUsd = 1.23;
      for (const row of parsed.session.usageRows) row.inherited = true;

      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL });
      const key = cacheKey(ref, TOOL);
      cache.put(key, entryFor(key, parsed));

      const raw = readFileSync(join(cacheDir, `${key}.json`), 'utf8');
      expect(raw).not.toContain('"inherited"');
      expect(raw).not.toContain('3.14');
      expect(raw).not.toContain('"asOf"');
      expect(raw).not.toContain('"since"');
      const stored = cache.get(key);
      if (stored === null) throw new Error('entry vanished');
      expect(stored.bytesParsed).toBe(parsed.bytesParsed);
      expect(stored.tailHash).toBe(parsed.tailHash);
      expect(stored.session.cost.usd).toBeNull();
      expect(stored.session.cost.pricesVersion).toBe('');
      for (const turn of stored.session.turns) {
        expect(turn.costUsd).toBeNull();
        expect(turn.userText).toBeNull();
      }
      for (const row of stored.session.usageRows) expect(row.inherited).toBeUndefined();
    }));

  it('lookupByPath misses a symlink spelling: realpath before the lookup (W1 merge note)', () =>
    withTempDir(async (dir) => {
      const realDir = join(dir, 'real');
      mkdirSync(realDir, { recursive: true });
      const t = cc();
      pushTurn(t, 1);
      const realPath = join(realDir, 'main.jsonl');
      writeFileSync(realPath, textOf(t));
      const linkDir = join(dir, 'link');
      symlinkSync(realDir, linkDir);
      const linkPath = join(linkDir, 'main.jsonl');

      const cache = createCache({ dir: join(dir, 'cache'), toolVersion: TOOL });
      const ref = refOf(t, realPath); // discovery hands out realpath-rooted refs
      const parsed = await readClaudeCodeSession(ref, { home: HOME });
      const key = cacheKey(ref, TOOL);
      cache.put(key, entryFor(key, parsed));

      // A Stop hook's transcript_path may arrive spelled through the symlink…
      expect(cache.lookupByPath(linkPath)).toBeNull();
      // …and hits only once realpath'd to the discovery spelling.
      expect(cache.lookupByPath(realpathSync(linkPath))?.key).toBe(key);
    }));
});
