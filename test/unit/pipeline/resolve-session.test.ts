/**
 * S21 — `pipeline/resolve-session.ts` over the real fixture tree: `latest`,
 * full id, unique 4-char prefix, a transcript-filename prefix (§4.1),
 * ambiguous prefix (candidates listed), a
 * path to a fixture file, a path outside every root, a nonexistent path,
 * and `latest` over a tree holding only no-turns sessions. The fixtures
 * used are `codex/0.98.0` (two real rollouts whose ids share the `019c`
 * prefix — the ambiguity case) and `claude-code/2.1.243` (the no-turns
 * session).
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Roots, Session } from '../../../src/model/types.js';
import { resolveRoots } from '../../../src/discover/roots.js';
import { AmbiguousError, MIN_PREFIX, NotFoundError, resolveSession } from '../../../src/pipeline/resolve-session.js';
import { loadSessions } from '../../../src/pipeline/run.js';
import { parseIso } from '../../../src/util/time.js';
import { TOOL_VERSION } from '../../../src/version.js';
import { materialize } from '../../helpers/fixtures.js';
import { GOLDEN_HOME } from '../../helpers/goldens.js';
import { makeTempDir } from '../../helpers/tmp.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');

// ---------------------------------------------------------------------------
// One materialised tree: two Codex rollouts + the no-turns Claude Code session.
// ---------------------------------------------------------------------------

const tmp = makeTempDir('showreceipts-resolve-');
const fx = join(tmp, 'fx');
const codexFixture = materialize('codex/0.98.0', fx);
const claudeFixture = materialize('claude-code/2.1.243', fx);
const roots: Roots = resolveRoots(
  { CLAUDE_CONFIG_DIR: join(fx, 'claude'), CODEX_HOME: join(fx, 'codex'), SHOWRECEIPTS_HOME: join(tmp, 'sr') },
  GOLDEN_HOME,
);
const { sessions, diagnostics } = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now: NOW });
if (diagnostics.problems.length > 0) throw new Error(diagnostics.problems.join('; '));
const ctx = { sessions, roots, cwd: tmp };

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const codexSessions = sessions.filter((s) => s.harness === 'codex');
const claudeSession = sessions.find((s) => s.harness === 'claude-code');

function hasDoneTurn(s: Session): boolean {
  return s.kind === 'normal' && s.turns.some((t) => t.isDone);
}

/** The §4.1 recency order the resolver promises for `latest`. */
function newestDone(list: readonly Session[]): Session | undefined {
  return [...list]
    .sort((a, b) => {
      const aMs = parseIso(a.endedAt) ?? 0;
      const bMs = parseIso(b.endedAt) ?? 0;
      if (aMs !== bMs) return bMs - aMs;
      return a.sessionId < b.sessionId ? -1 : 1;
    })
    .find(hasDoneTurn);
}

describe('resolve-session', () => {
  it('materialised tree holds two codex sessions and the no-turns claude-code session', () => {
    expect(codexSessions).toHaveLength(2);
    expect(claudeSession).toBeDefined();
    expect(claudeSession?.kind).toBe('no-turns');
  });

  it('latest → the newest session with ≥ 1 done turn', async () => {
    const expected = newestDone(sessions);
    expect(expected).toBeDefined();
    const resolved = await resolveSession('latest', ctx);
    expect(resolved).toBe(expected);
    expect(hasDoneTurn(resolved)).toBe(true);
  });

  it('a full session id resolves exactly, case-insensitively', async () => {
    const target = codexSessions[0] as Session;
    expect(await resolveSession(target.sessionId, ctx)).toBe(target);
    expect(await resolveSession(target.sessionId.toUpperCase(), ctx)).toBe(target);
  });

  it('a unique 4-char prefix over sessionId/shortId resolves', async () => {
    // Find a session whose 4-char shortId prefix is unique in the tree — the
    // Codex shortIds are the last 8 hex of distinct v7 uuids, so one exists.
    const unique = sessions.find((s) => {
      const prefix = s.shortId.slice(0, MIN_PREFIX).toLowerCase();
      const matches = sessions.filter(
        (o) => o.sessionId.toLowerCase().startsWith(prefix) || o.shortId.toLowerCase().startsWith(prefix),
      );
      return matches.length === 1;
    });
    expect(unique, 'a session with a unique 4-char shortId prefix must exist').toBeDefined();
    const target = unique as Session;
    expect(await resolveSession(target.shortId.slice(0, MIN_PREFIX), ctx)).toBe(target);
  });

  it('an ambiguous prefix throws AmbiguousError listing every candidate', async () => {
    // Both real rollout ids are UUIDv7s minted the same epoch: they share `019c`.
    expect.assertions(4);
    try {
      await resolveSession('019c', ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousError);
      const ambiguous = err as AmbiguousError;
      expect(ambiguous.candidates.length).toBeGreaterThanOrEqual(2);
      const ids = ambiguous.candidates.map((c) => c.sessionId);
      for (const s of codexSessions) expect(ids).toContain(s.sessionId);
    }
  });

  it('a transcript filename and its unique prefix resolve (§4.1)', async () => {
    const target = codexSessions.find((s) => s.transcriptPath !== null) as Session;
    const other = codexSessions.find((s) => s !== target) as Session;
    expect(target).toBeDefined();
    expect(other?.transcriptPath).toBeTruthy();
    const name = basename(target.transcriptPath as string);
    // The full `rollout-….jsonl` name is spelled like a path but names no
    // file under cwd — §4.1 says it still matches the scanned session.
    expect(await resolveSession(name, ctx)).toBe(target);
    // A unique filename prefix: one character past the shared stem.
    const otherName = basename(other.transcriptPath as string).toLowerCase();
    let len = MIN_PREFIX;
    while (otherName.startsWith(name.slice(0, len).toLowerCase()) && len < name.length) len += 1;
    expect(await resolveSession(name.slice(0, len), ctx)).toBe(target);
  });

  it("the shared 'rollout-' filename stem is ambiguous across the two rollouts", async () => {
    await expect(resolveSession('rollout-', ctx)).rejects.toThrow(AmbiguousError);
  });

  it('a prefix shorter than 4 characters is refused (exit 5, never a guess)', async () => {
    await expect(resolveSession('01', ctx)).rejects.toThrow(NotFoundError);
    await expect(resolveSession('01', ctx)).rejects.toThrow(/at least 4/);
  });

  it('a path to a fixture transcript reads that file directly', async () => {
    const main = claudeFixture.paths.find((p) => /projects\/[^/]+\/[^/]+\.jsonl$/.test(p.split('\\').join('/')));
    expect(main).toBeDefined();
    const resolved = await resolveSession(main as string, ctx);
    expect(resolved.harness).toBe('claude-code');
    expect(resolved.sessionId).toBe(claudeSession?.sessionId);
    expect(resolved.kind).toBe('no-turns');
  });

  it('a path outside every known root still reads when the file exists', async () => {
    const rollout = codexFixture.paths.find((p) => /rollout-.*\.jsonl$/.test(basename(p)));
    expect(rollout).toBeDefined();
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const copy = join(elsewhere, basename(rollout as string));
    copyFileSync(rollout as string, copy);
    const resolved = await resolveSession(copy, ctx);
    expect(resolved.harness).toBe('codex');
    expect(codexSessions.map((s) => s.sessionId)).toContain(resolved.sessionId);
    // The direct read runs the full post-read chain: the ledger is built.
    expect(resolved.ledger.commands.length + resolved.ledger.writes.length).toBeGreaterThan(0);
  });

  it('a nonexistent path exits 5 (NotFoundError, "no such file")', async () => {
    await expect(resolveSession(join(tmp, 'nope.jsonl'), ctx)).rejects.toThrow(NotFoundError);
    await expect(resolveSession(join(tmp, 'nope.jsonl'), ctx)).rejects.toThrow(/no such file/);
  });

  it('latest over only no-turns sessions exits 5 with a message', async () => {
    const onlyNoTurns = { ...ctx, sessions: sessions.filter((s) => s.harness === 'claude-code') };
    await expect(resolveSession('latest', onlyNoTurns)).rejects.toThrow(NotFoundError);
    await expect(resolveSession('latest', onlyNoTurns)).rejects.toThrow(/done turn/);
  });

  it('an unmatched id exits 5', async () => {
    await expect(resolveSession('feedfacecafe', ctx)).rejects.toThrow(NotFoundError);
    await expect(resolveSession('feedfacecafe', ctx)).rejects.toThrow(/no session matches/);
  });
});
