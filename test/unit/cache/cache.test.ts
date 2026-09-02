import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  Cost,
  Diagnostics,
  Ledger,
  Session,
  SessionRef,
  ToolCall,
  Turn,
  UsageRow,
  UsageTotals,
} from '../../../src/model/types.js';
import { cacheKey, createCache, pathKey, trimForCache, type CacheEntry } from '../../../src/cache/cache.js';
import { sha256 } from '../../../src/util/hash.js';
import { makeTempDir, withTempDir } from '../../helpers/tmp.js';

const TOOL_VERSION = '0.1.0';
const SECRET = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function usageTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function emptyLedger(): Ledger {
  return {
    writes: [],
    commands: [],
    testRuns: [],
    checks: [],
    git: [],
    network: [],
    integrity: [],
    danger: [],
    filesChanged: [],
    lastWriteSeq: null,
    lastSourceWriteSeq: null,
    lastGreenSeq: null,
    incomplete: false,
    incompleteReasons: [],
    opaqueTestCapable: 0,
    perTurn: {},
  };
}

function emptyDiagnostics(): Diagnostics {
  return {
    unknownRecordTypes: {},
    unknownSubtypes: {},
    unknownToolShapes: {},
    unknownContentBlocks: {},
    unknownCodexPayloads: {},
    badLines: 0,
    lineSeparatorChars: 0,
    reorderedEvents: 0,
    duplicateUuids: 0,
    duplicateToolResults: 0,
    negativeDeltas: 0,
    orphanAssistantLines: 0,
    notificationPrompts: 0,
    localCommandPrompts: 0,
    incompleteMessages: 0,
    bashWithoutToolUseResult: 0,
    legacyShapes: {},
    subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
    notes: [],
    interimFinals: 0,
    emptySessions: 0,
    excludedSyntheticLines: 0,
    unknownAttachmentTypes: {},
    journals: 0,
    unrecognisedFiles: 0,
    orphanSessionDirs: 0,
    emptyProjects: 0,
    corruptCache: 0,
    copilotTranscriptUnparsed: 0,
    records: 0,
  };
}

function nonEmptyCost(): Cost {
  return {
    usd: 5.5,
    apiCalls: 2,
    input: 100,
    cacheRead: 5,
    cacheWrite5m: 1,
    cacheWrite1h: 0,
    cacheWriteOther: 0,
    output: 50,
    cacheHitPct: 42,
    unverified: true,
    unpriced: ['some-model'],
    apiEquivalent: true,
    pricesVersion: '2026-08-01',
    notes: ['computed pre-cache'],
  };
}

function makeTurn(): Turn {
  return {
    index: 0,
    kind: 'human',
    promptId: 'p1',
    userText: 'SECRET PROMPT TEXT: please fix the bug',
    echoHashes: ['abc123hash'],
    segments: [{ trigger: 'human', promptId: 'p1', seqStart: 1, seqEnd: 9 }],
    seqStart: 1,
    seqEnd: 9,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:05:00.000Z',
    durationMs: 300000,
    finalText: 'Done. I ran the tests and they pass.',
    finalSeq: 9,
    finalMessageId: 'm1',
    finalTrigger: 'human',
    interimFinals: 0,
    harnessVersion: '2.1.235',
    model: 'claude-test-1',
    isDone: true,
    interrupted: false,
    compactions: 0,
    opaqueWriteCommands: 0,
    opaqueTestCommands: 0,
    usage: usageTotals(),
    costUsd: 1.23,
    apiCalls: 2,
    finalStopReason: 'end_turn',
  };
}

function makeToolCall(): ToolCall {
  return {
    seq: 2,
    id: 't1',
    tool: 'Edit',
    kind: 'edit',
    agentId: null,
    turnIndex: 0,
    cwd: '/repo',
    input: {
      file_path: '/repo/x.ts',
      command: 'npm test',
      description: 'Run tests',
      pattern: 'foo.*bar',
      url: 'https://example.test',
      old_string: 'OLD STRING BODY',
      new_string: 'NEW STRING BODY',
      content: 'FILE BODY CONTENT NEVER CACHED',
      originalFile: 'ORIGINAL FILE BODY NEVER CACHED',
    },
    resultText: `ok token=abc12345secret and ${SECRET} trailing`,
    resultBytes: 64,
    isError: false,
    exitCode: 0,
    exitCodeSource: 'harness',
    interrupted: false,
    background: false,
    startedAt: '2026-08-01T00:01:00.000Z',
    endedAt: '2026-08-01T00:01:05.000Z',
    filesTouched: ['/repo/x.ts'],
    patch: { added: ['+SECRET PATCH LINE ADDED'], removed: ['-old line'], hunks: 1 },
    attempted: ['/repo/failed-patch.ts'],
  };
}

function makeUsageRow(): UsageRow {
  return {
    seq: 3,
    agentId: null,
    messageId: 'msg-row-1',
    ts: '2026-08-01T00:01:10.000Z',
    attempts: [{ model: 'claude-test-1', in: 10, w5: 1, w1: 0, wX: 0, wU: 0, rd: 5, out: 20, billed: true }],
    promptTokens: 10,
    inherited: true,
  };
}

function makeSession(transcriptPath = '/roots/claude/projects/-p/57687dd1.jsonl'): Session {
  return {
    harness: 'claude-code',
    harnessVersion: '2.1.235',
    harnessVersions: ['2.1.235'],
    sessionId: '57687dd1-8430-4568-a210-4a3d63ce162c',
    shortId: '57687dd1',
    source: 'transcript',
    transcriptPath,
    cwd: '/repo',
    cwds: ['/repo'],
    repoRoot: '/repo',
    gitBranch: 'main',
    title: null,
    models: ['claude-test-1'],
    primaryModel: 'claude-test-1',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:05:00.000Z',
    durationMs: 300000,
    activeMs: null,
    turns: [makeTurn()],
    preamble: [],
    toolCalls: [makeToolCall()],
    ledger: emptyLedger(),
    usage: usageTotals(),
    cost: nonEmptyCost(),
    compactions: [],
    subagents: [],
    prRefs: [],
    apiErrors: [],
    refusalFallbacks: [],
    diagnostics: emptyDiagnostics(),
    usageRows: [makeUsageRow()],
    tokenDeltas: [{ seq: 4, ts: '2026-08-01T00:01:20.000Z', model: 'claude-test-1', input: 1, cached: 0, output: 2, reasoning: 0, turnIndex: 0, lastInput: null }],
    kind: 'normal',
    records: 10,
    spansDays: 1,
    editedFiles: [],
  };
}

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    harness: 'claude-code',
    sessionId: '57687dd1-8430-4568-a210-4a3d63ce162c',
    path: '/roots/claude/projects/-p/57687dd1.jsonl',
    size: 1234,
    mtimeMs: 1_764_000_000_000,
    subagentManifest: [{ rel: 'sid/subagents/agent-aa.jsonl', size: 10, mtimeMs: 5 }],
    ...overrides,
  };
}

function makeEntry(session: Session, key: string): CacheEntry {
  return { v: 1, key, session, bytesParsed: 4096, tailHash: sha256('tail'), builderState: '{"i":1}' };
}

describe('trimForCache', () => {
  it('never mutates its input', () => {
    const session = makeSession();
    const before = JSON.stringify(session);
    trimForCache(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('drops prompt text but keeps echo hashes', () => {
    const trimmed = trimForCache(makeSession());
    const turn = trimmed.turns[0] as Turn;
    expect(turn.userText).toBeNull();
    expect(turn.echoHashes).toEqual(['abc123hash']);
  });

  it('masks and caps resultText at 512 bytes per call', () => {
    const session = makeSession();
    (session.toolCalls[0] as ToolCall).resultText = `${SECRET} ` + 'x'.repeat(2000);
    const trimmed = trimForCache(session);
    const text = (trimmed.toolCalls[0] as ToolCall).resultText;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512);
    expect(text).toContain('«masked»');
    expect(text).not.toContain(SECRET);
  });

  it('caps finalText at 64 KiB on a code-point boundary', () => {
    const session = makeSession();
    (session.turns[0] as Turn).finalText = 'é'.repeat(40_000); // 80 000 UTF-8 bytes
    const trimmed = trimForCache(session);
    const finalText = (trimmed.turns[0] as Turn).finalText as string;
    expect(Buffer.byteLength(finalText, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(finalText).not.toContain('�');
    expect(finalText.length).toBeGreaterThan(30_000);
  });

  it('keeps a small finalText in full', () => {
    const trimmed = trimForCache(makeSession());
    expect((trimmed.turns[0] as Turn).finalText).toBe('Done. I ran the tests and they pass.');
  });

  it('drops patch, attempted and every input key except the allowed five', () => {
    const trimmed = trimForCache(makeSession());
    const call = trimmed.toolCalls[0] as ToolCall;
    expect(call.patch).toBeUndefined();
    expect(call.attempted).toBeUndefined();
    expect(call.input).toEqual({
      file_path: '/repo/x.ts',
      command: 'npm test',
      description: 'Run tests',
      pattern: 'foo.*bar',
      url: 'https://example.test',
    });
  });

  it('keeps usage rows and token deltas, minus inherited, and never dollars', () => {
    const trimmed = trimForCache(makeSession());
    const row = trimmed.usageRows[0] as UsageRow;
    expect(row.inherited).toBeUndefined();
    expect(row.attempts).toEqual([{ model: 'claude-test-1', in: 10, w5: 1, w1: 0, wX: 0, wU: 0, rd: 5, out: 20, billed: true }]);
    expect(trimmed.tokenDeltas.length).toBe(1);
    expect((trimmed.turns[0] as Turn).costUsd).toBeNull();
    expect(trimmed.cost).toEqual({
      usd: null,
      apiCalls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteOther: 0,
      output: 0,
      cacheHitPct: null,
      unverified: false,
      unpriced: [],
      apiEquivalent: true,
      pricesVersion: '',
      notes: [],
    });
  });
});

describe('cacheKey', () => {
  it('takes only a ref and the tool version — prices/rules cannot enter by signature', () => {
    expect(cacheKey.length).toBe(2);
  });

  it('is deterministic and sensitive to path, size, mtime, toolVersion and the manifest', () => {
    const ref = makeRef();
    const base = cacheKey(ref, TOOL_VERSION);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(makeRef(), TOOL_VERSION)).toBe(base);
    expect(cacheKey(makeRef({ path: '/other.jsonl' }), TOOL_VERSION)).not.toBe(base);
    expect(cacheKey(makeRef({ size: 1235 }), TOOL_VERSION)).not.toBe(base);
    expect(cacheKey(makeRef({ mtimeMs: 1_764_000_000_001 }), TOOL_VERSION)).not.toBe(base);
    expect(cacheKey(ref, '0.2.0')).not.toBe(base);
    expect(cacheKey(makeRef({ subagentManifest: [] }), TOOL_VERSION)).not.toBe(base);
    expect(cacheKey(makeRef({ subagentManifest: [{ rel: 'sid/subagents/agent-aa.jsonl', size: 10, mtimeMs: 6 }] }), TOOL_VERSION)).not.toBe(base);
  });

  it('cannot confuse adjacent manifest fields', () => {
    const a = makeRef({ subagentManifest: [{ rel: 'a', size: 11, mtimeMs: 1 }] });
    const b = makeRef({ subagentManifest: [{ rel: 'a1', size: 1, mtimeMs: 1 }] });
    expect(cacheKey(a, TOOL_VERSION)).not.toBe(cacheKey(b, TOOL_VERSION));
  });
});

describe('createCache', () => {
  it('round-trips an entry unchanged after trimming', async () => {
    await withTempDir((dir) => {
      const cache = createCache({ dir: join(dir, 'cache'), toolVersion: TOOL_VERSION });
      const session = makeSession();
      (session.toolCalls[0] as ToolCall).resultText = 'plain result, no secrets';
      const trimmed = trimForCache(session);
      const key = cacheKey(makeRef(), TOOL_VERSION);
      const entry = makeEntry(trimmed, key);
      cache.put(key, entry);
      expect(cache.get(key)).toEqual(entry);
    });
  });

  it('writes entries with mode 0600 in a 0700 directory', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const key = cacheKey(makeRef(), TOOL_VERSION);
      cache.put(key, makeEntry(trimForCache(makeSession()), key));
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(cacheDir, `${key}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(cacheDir, 'index.json')).mode & 0o777).toBe(0o600);
    });
  });

  it('masks secrets in the written file and stores no prompt text, patch lines or file bodies', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const key = cacheKey(makeRef(), TOOL_VERSION);
      cache.put(key, makeEntry(trimForCache(makeSession()), key));
      const raw = readFileSync(join(cacheDir, `${key}.json`), 'utf8');
      expect((raw.match(/«masked»/g) ?? []).length).toBeGreaterThanOrEqual(1);
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain('SECRET PROMPT TEXT');
      expect(raw).not.toContain('SECRET PATCH LINE');
      expect(raw).not.toContain('ORIGINAL FILE BODY');
      expect(raw).not.toContain('FILE BODY CONTENT');
      expect(raw).not.toContain('originalFile');
      expect(raw).not.toContain('"patch"');
      expect(raw).not.toContain('"inherited"');
      expect(raw).toContain('"userText":null');
      expect(raw).toContain('"echoHashes":["abc123hash"]');
      expect(raw).toContain('"usageRows"');
      expect(raw).toContain('"msg-row-1"');
    });
  });

  it('treats corrupt JSON, foreign versions and mis-keyed files as counted misses', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const key = cacheKey(makeRef(), TOOL_VERSION);
      cache.put(key, makeEntry(trimForCache(makeSession()), key));

      const missingKey = sha256('missing');
      expect(cache.get(missingKey)).toBeNull(); // a plain miss is not corruption
      expect(cache.stats().corrupt).toBe(0);

      writeFileSync(join(cacheDir, `${key}.json`), 'not json at all');
      expect(cache.get(key)).toBeNull();
      expect(cache.stats().corrupt).toBe(1);

      writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify({ v: 2, key, session: {}, bytesParsed: 1, tailHash: 'x' }));
      expect(cache.get(key)).toBeNull();
      expect(cache.stats().corrupt).toBe(2);

      // A valid entry copied under another name fails the stored-key check.
      const key2 = cacheKey(makeRef({ size: 999 }), TOOL_VERSION);
      cache.put(key, makeEntry(trimForCache(makeSession()), key));
      copyFileSync(join(cacheDir, `${key}.json`), join(cacheDir, `${key2}.json`));
      expect(cache.get(key2)).toBeNull();
      expect(cache.stats().corrupt).toBe(3);
    });
  });

  it('is inert when disabled (the flag is passed in, never read from process.env here)', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const enabled = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const key = cacheKey(makeRef(), TOOL_VERSION);
      const entry = makeEntry(trimForCache(makeSession()), key);
      enabled.put(key, entry);

      const disabled = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION, disabled: true });
      expect(disabled.disabled).toBe(true);
      expect(disabled.get(key)).toBeNull();
      expect(disabled.lookupByPath(makeSession().transcriptPath as string)).toBeNull();
      disabled.put(key, entry); // no-op
      expect(enabled.get(key)).toEqual(entry); // and it clobbered nothing

      const fresh = createCache({ dir: join(dir, 'fresh'), toolVersion: TOOL_VERSION, disabled: true });
      fresh.put(key, entry);
      expect(existsSync(join(dir, 'fresh'))).toBe(false); // nothing was created
    });
  });

  it('clears every file and reports stats', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      expect(cache.stats()).toEqual({ entries: 0, bytes: 0, corrupt: 0 });
      const keyA = cacheKey(makeRef(), TOOL_VERSION);
      const keyB = cacheKey(makeRef({ size: 999 }), TOOL_VERSION);
      cache.put(keyA, makeEntry(trimForCache(makeSession()), keyA));
      cache.put(keyB, makeEntry(trimForCache(makeSession()), keyB));
      const stats = cache.stats();
      expect(stats.entries).toBe(2);
      expect(stats.bytes).toBeGreaterThan(0);
      cache.clear();
      expect(cache.stats().entries).toBe(0);
      expect(readdirSync(cacheDir)).toEqual([]);
      expect(cache.get(keyA)).toBeNull();
    });
  });

  it('lookupByPath returns the newest entry for a transcript without re-keying by size/mtime', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const path = '/roots/claude/projects/-p/57687dd1.jsonl';
      const keyA = cacheKey(makeRef(), TOOL_VERSION);
      cache.put(keyA, makeEntry(trimForCache(makeSession(path)), keyA));
      expect(cache.lookupByPath(path)?.key).toBe(keyA);

      const keyB = cacheKey(makeRef({ size: 2000, mtimeMs: 1_764_000_000_500 }), TOOL_VERSION);
      const grown = makeEntry(trimForCache(makeSession(path)), keyB);
      grown.bytesParsed = 8192;
      cache.put(keyB, grown);
      expect(cache.lookupByPath(path)?.key).toBe(keyB);
      expect(cache.lookupByPath(path)?.bytesParsed).toBe(8192);
      expect(cache.lookupByPath('/some/other/file.jsonl')).toBeNull();

      // A different tool version hashes to a different per-path slot.
      const other = createCache({ dir: cacheDir, toolVersion: '9.9.9' });
      expect(other.lookupByPath(path)).toBeNull();
      expect(pathKey(path, TOOL_VERSION)).not.toBe(pathKey(path, '9.9.9'));
    });
  });

  it('skips the path index for sessions without a transcript path', async () => {
    await withTempDir((dir) => {
      const cacheDir = join(dir, 'cache');
      const cache = createCache({ dir: cacheDir, toolVersion: TOOL_VERSION });
      const session = makeSession();
      session.transcriptPath = null;
      const key = cacheKey(makeRef(), TOOL_VERSION);
      cache.put(key, makeEntry(trimForCache(session), key));
      expect(existsSync(join(cacheDir, 'index.json'))).toBe(false);
      expect(cache.get(key)).not.toBeNull();
    });
  });

  it('rejects malformed keys and key/entry mismatches', async () => {
    await withTempDir((dir) => {
      const cache = createCache({ dir: join(dir, 'cache'), toolVersion: TOOL_VERSION });
      const key = cacheKey(makeRef(), TOOL_VERSION);
      const entry = makeEntry(trimForCache(makeSession()), key);
      expect(() => cache.put('../escape', entry)).toThrow(TypeError);
      expect(() => cache.put(sha256('other'), entry)).toThrow(TypeError);
      expect(cache.get('../escape')).toBeNull();
    });
  });
});

describe('cache instances over one directory', () => {
  const dir = makeTempDir('sr-cache-env-');
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second cache instance over the same dir sees entries written by the first', () => {
    const a = createCache({ dir, toolVersion: TOOL_VERSION });
    const key = cacheKey(makeRef(), TOOL_VERSION);
    a.put(key, makeEntry(trimForCache(makeSession()), key));
    const b = createCache({ dir, toolVersion: TOOL_VERSION });
    expect(b.get(key)?.key).toBe(key);
    expect(b.lookupByPath(makeSession().transcriptPath as string)?.key).toBe(key);
  });
});
