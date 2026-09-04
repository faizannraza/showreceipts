/**
 * S27b — resumable parse for the Stop path (reader side). For every Claude
 * Code fixture the cold parse is deep-equal to parse(prefix) + resume(tail)
 * at 5 split points: 4 line boundaries (mid-turn by construction — real
 * fixtures have far more lines than turns) plus one trailing partial line.
 * A byte flipped inside the guard window before `bytesParsed` forces a cold
 * parse; an intact tail window proves the prefix is never re-read; file
 * truncation and corrupt/absent builder state fall back cold; subagent
 * files are always rescanned; `bytesParsed` advances after a resume.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionRef } from '../../../../src/model/types.js';
import {
  readClaudeCodeSession,
  resumeSession,
  type ClaudeCodeReadOptions,
  type ClaudeCodeReadResult,
} from '../../../../src/readers/claude-code/reader.js';
import { listFixtures, materialize } from '../../../helpers/fixtures.js';
import { makeTempDir } from '../../../helpers/tmp.js';

const HOME = '/home/u';
const MAIN_RE = /^projects\/[^/]+\/[^/]+\.jsonl$/;
const NL = 0x0a;

const tmp = makeTempDir('showreceipts-resume-');
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Fx {
  id: string;
  /** Absolute path of the materialised main transcript (rewritten by tests). */
  path: string;
  /** The full original bytes of the main transcript. */
  bytes: Buffer;
  ref: SessionRef;
  opts: ClaudeCodeReadOptions;
  /** Absolute offsets just past each `\n` (every line boundary > 0). */
  boundaries: number[];
}

/** Materialises one fixture into its own directory and indexes its main transcript. */
function loadFixture(id: string, dirName: string): Fx {
  const m = materialize(id, join(tmp, dirName));
  const root = m.claudeConfigDir;
  if (root === undefined) throw new Error(`fixture ${id} is not a Claude Code fixture`);
  const path = m.paths.find((p) => MAIN_RE.test(relative(root, p).split(sep).join('/')));
  if (path === undefined) throw new Error(`fixture ${id} has no main transcript`);
  const bytes = readFileSync(path);
  const sessionId = basename(path, '.jsonl');
  const ref: SessionRef = { harness: 'claude-code', sessionId, path, size: bytes.length, mtimeMs: 0, subagentManifest: [] };
  const opts: ClaudeCodeReadOptions = { home: HOME };
  const subagentsDir = join(dirname(path), sessionId, 'subagents');
  if (existsSync(subagentsDir)) opts.subagents = { kind: 'dir', path: subagentsDir };
  const boundaries: number[] = [];
  let at = bytes.indexOf(NL);
  while (at !== -1) {
    boundaries.push(at + 1);
    at = bytes.indexOf(NL, at + 1);
  }
  return { id, path, bytes, ref, opts, boundaries };
}

/** The line boundary closest to fraction `f` of the fixture's lines (never 0, never EOF unless unavoidable). */
function boundaryAt(fx: Fx, f: number): number {
  const n = fx.boundaries.length;
  const k = Math.max(1, Math.floor(n * f));
  return fx.boundaries[k - 1] as number;
}

/** The 5 split offsets: 4 line boundaries at fixed fractions + one mid-line (trailing partial) cut. */
function splitPoints(fx: Fx): { offset: number; partial: boolean }[] {
  const out = new Map<number, boolean>();
  for (const f of [0.15, 0.4, 0.65, 0.9]) {
    const s = boundaryAt(fx, f);
    if (s < fx.bytes.length && !out.has(s)) out.set(s, false);
  }
  // The partial cut lands halfway into the line that follows the middle
  // boundary (`starts` prepends offset 0 so one-line fixtures still get one).
  const starts = [0, ...fx.boundaries];
  const km = Math.floor(fx.boundaries.length / 2);
  const base = starts[km] as number;
  const next = starts[km + 1] ?? fx.bytes.length;
  const cut = base + Math.max(1, Math.floor((next - base) / 2));
  if (cut > base && cut < next && cut < fx.bytes.length) out.set(cut, true);
  return [...out.entries()].map(([offset, partial]) => ({ offset, partial }));
}

// ---------------------------------------------------------------------------
// Equivalence: cold ≡ parse(prefix) + resume(tail), every fixture, 5 splits.
// ---------------------------------------------------------------------------

const ccFixtures = listFixtures().filter((id) => id.startsWith('claude-code/'));

it('there are Claude Code fixtures to cover', () => {
  expect(ccFixtures.length).toBeGreaterThan(0);
});

for (const id of ccFixtures) {
  describe(`cold ≡ prefix + resume — ${id}`, () => {
    const fx = loadFixture(id, `eq-${id.replace(/\//g, '__')}`);
    let cold: ClaudeCodeReadResult;

    beforeAll(async () => {
      writeFileSync(fx.path, fx.bytes);
      cold = await readClaudeCodeSession(fx.ref, fx.opts);
    });

    it('cold parse consumes the file to a line boundary', () => {
      expect(cold.bytesParsed).toBeGreaterThan(0);
      expect(fx.bytes[cold.bytesParsed - 1]).toBe(NL);
    });

    for (const sp of splitPoints(fx)) {
      const kind = sp.partial ? 'trailing-partial-line' : 'line-boundary';
      it(`${kind} split at byte ${sp.offset} of ${fx.bytes.length}`, async () => {
        writeFileSync(fx.path, fx.bytes.subarray(0, sp.offset));
        const prefix = await readClaudeCodeSession(fx.ref, fx.opts);
        if (sp.partial) {
          // The anchor stops at the last complete line, never inside one.
          expect(prefix.bytesParsed).toBeLessThan(sp.offset);
        } else {
          expect(prefix.bytesParsed).toBe(sp.offset);
        }
        expect(prefix.bytesParsed === 0 || fx.bytes[prefix.bytesParsed - 1] === NL).toBe(true);

        writeFileSync(fx.path, fx.bytes);
        const resumed = await resumeSession(fx.ref, prefix, fx.opts);
        expect(resumed.session).toEqual(cold.session);
        expect(resumed.bytesParsed).toBe(cold.bytesParsed);
        expect(resumed.tailHash).toBe(cold.tailHash);
        // The next Stop's anchor has advanced past the previous one.
        expect(resumed.bytesParsed).toBeGreaterThan(prefix.bytesParsed);
        // …and its builder state matches the cold pass's, so a third Stop
        // resumes identically from either history.
        expect(JSON.parse(resumed.builderState)).toEqual(JSON.parse(cold.builderState));
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Guard behaviour (2.1.215: large enough that the 4 KiB window < prefix).
// ---------------------------------------------------------------------------

describe('resume guard (claude-code/2.1.215)', () => {
  const fx = loadFixture('claude-code/2.1.215', 'guard-2.1.215');
  let cold: ClaudeCodeReadResult;

  beforeAll(async () => {
    writeFileSync(fx.path, fx.bytes);
    cold = await readClaudeCodeSession(fx.ref, fx.opts);
  });

  /** Parses the prefix at ~60 % of the lines and returns its anchor. */
  async function prefixAnchor(): Promise<ClaudeCodeReadResult> {
    writeFileSync(fx.path, fx.bytes.subarray(0, boundaryAt(fx, 0.6)));
    const prefix = await readClaudeCodeSession(fx.ref, fx.opts);
    expect(prefix.bytesParsed).toBeGreaterThan(4096); // the guard window is a strict tail
    return prefix;
  }

  it('a resume reads only the tail: garbage before the guard window is never seen', async () => {
    const prefix = await prefixAnchor();
    const doctored = Buffer.from(fx.bytes);
    // Destroy everything a cold parse would read before the guard window.
    doctored.fill(0x23 /* '#' */, 0, prefix.bytesParsed - 4096);
    writeFileSync(fx.path, doctored);
    const resumed = await resumeSession(fx.ref, prefix, fx.opts);
    // Equal to the *original* cold parse — the doctored prefix was skipped.
    expect(resumed.session).toEqual(cold.session);
    expect(resumed.bytesParsed).toBe(cold.bytesParsed);
  });

  it('a byte flipped before bytesParsed (inside the guard window) triggers a cold parse', async () => {
    const prefix = await prefixAnchor();
    const doctored = Buffer.from(fx.bytes);
    doctored.fill(0x23 /* '#' */, 0, prefix.bytesParsed - 4096);
    // One changed byte inside the window: the stored tailHash no longer matches.
    const pos = prefix.bytesParsed - 50;
    doctored[pos] = doctored[pos] === 0x41 ? 0x42 : 0x41;
    writeFileSync(fx.path, doctored);
    const coldDoctored = await readClaudeCodeSession(fx.ref, fx.opts);
    const resumed = await resumeSession(fx.ref, prefix, fx.opts);
    // The stored state was NOT trusted: the parse saw the doctored prefix…
    expect(resumed.session).toEqual(coldDoctored.session);
    expect(resumed.session.diagnostics.badLines).toBeGreaterThan(0);
    // …which a short-circuited resume could never have (positive control above).
    expect(resumed.session).not.toEqual(cold.session);
  });

  it('truncation below bytesParsed falls back to a cold parse of the shorter file', async () => {
    writeFileSync(fx.path, fx.bytes);
    const full = await readClaudeCodeSession(fx.ref, fx.opts);
    const short = boundaryAt(fx, 0.4);
    writeFileSync(fx.path, fx.bytes.subarray(0, short));
    const coldShort = await readClaudeCodeSession(fx.ref, fx.opts);
    const resumed = await resumeSession(fx.ref, full, fx.opts);
    expect(resumed.session).toEqual(coldShort.session);
    expect(resumed.bytesParsed).toBe(short);
  });

  it('a corrupt builderState with a matching tail falls back to a cold parse', async () => {
    const prefix = await prefixAnchor();
    writeFileSync(fx.path, fx.bytes);
    const resumed = await resumeSession(
      fx.ref,
      { bytesParsed: prefix.bytesParsed, tailHash: prefix.tailHash, builderState: '{"v":1,' },
      fx.opts,
    );
    expect(resumed.session).toEqual(cold.session);
  });

  it('a resume with no new bytes (duplicate Stop) reproduces the cold parse without advancing', async () => {
    writeFileSync(fx.path, fx.bytes);
    const full = await readClaudeCodeSession(fx.ref, fx.opts);
    const resumed = await resumeSession(fx.ref, full, fx.opts);
    expect(resumed.session).toEqual(cold.session);
    expect(resumed.bytesParsed).toBe(full.bytesParsed);
    expect(resumed.tailHash).toBe(full.tailHash);
    expect(JSON.parse(resumed.builderState)).toEqual(JSON.parse(full.builderState));
  });

  it('an anchor without builderState (a non-resumable entry) falls back to a cold parse', async () => {
    const prefix = await prefixAnchor();
    writeFileSync(fx.path, fx.bytes);
    const resumed = await resumeSession(fx.ref, { bytesParsed: prefix.bytesParsed, tailHash: prefix.tailHash }, fx.opts);
    expect(resumed.session).toEqual(cold.session);
  });
});

// ---------------------------------------------------------------------------
// Subagents are always rescanned (2.1.235 carries a real subagent tree).
// ---------------------------------------------------------------------------

describe('subagent rescan (claude-code/2.1.235)', () => {
  const fx = loadFixture('claude-code/2.1.235', 'rescan-2.1.235');

  it('a subagent file added after the prefix parse is picked up by the resume', async () => {
    const subagentsDir = fx.opts.subagents;
    if (subagentsDir === undefined || subagentsDir.kind !== 'dir') throw new Error('2.1.235 must have a subagents directory');
    writeFileSync(fx.path, fx.bytes);
    const before = await readClaudeCodeSession(fx.ref, fx.opts);

    writeFileSync(fx.path, fx.bytes.subarray(0, boundaryAt(fx, 0.5)));
    const prefix = await readClaudeCodeSession(fx.ref, fx.opts);

    // A new (unlinked) agent transcript appears between the two Stops.
    const extra = join(subagentsDir.path, 'agent-abcdef012345.jsonl');
    const line = {
      type: 'user',
      uuid: 'extra-u1',
      parentUuid: null,
      isSidechain: true,
      agentId: 'abcdef012345',
      promptId: 'extra-p1',
      message: { role: 'user', content: 'synthetic follow-up task' },
      timestamp: '2026-05-01T00:00:00.000Z',
      sessionId: fx.ref.sessionId,
      version: '2.1.235',
      cwd: '/home/u/proj',
    };
    writeFileSync(extra, JSON.stringify(line) + '\n');
    writeFileSync(fx.path, fx.bytes);

    const resumed = await resumeSession(fx.ref, prefix, fx.opts);
    const coldWithExtra = await readClaudeCodeSession(fx.ref, fx.opts);
    expect(resumed.session).toEqual(coldWithExtra.session);
    // The scan really ran on the resume: the added file is in the counts.
    expect(resumed.session.diagnostics.subagentFiles.unlinked).toBe(before.session.diagnostics.subagentFiles.unlinked + 1);

    rmSync(extra, { force: true });
  });
});
