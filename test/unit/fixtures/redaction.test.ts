/**
 * Redaction privacy test (PLAN S03, instruction 12; ARCHITECTURE §14.1).
 * Runs without the real transcripts: it reads only `fixtures/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT, fixtureDir, listFixtureFiles, listFixtures, readExpected, readFixtureBytes, readFixtureLines } from '../../helpers/fixtures.js';

const FIXED_OWNER_ACCOUNT = '00000000-0000-4000-8000-000000000001';
const FIXED_OWNER_ORG = '00000000-0000-4000-8000-000000000002';
const ROOT = join(FIXTURES_ROOT, '..');
const SCRIPTS_LIB = join(ROOT, 'scripts', 'lib');

/** Every file under `dir`, recursively, in sorted order. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

interface KeepLists {
  KEEP_SENTENCE_RE: RegExp;
  MAX_KEPT_SENTENCE_CHARS: number;
  MAX_COMMAND_LITERAL_CHARS: number;
  MAX_COMMAND_BYTES: number;
  STUB_RE: RegExp;
  SECRET_SHAPE_RE: RegExp;
}
interface IdMapModule {
  createIdMap(seed: string): {
    mapUuid(u: string): string;
    rewrite(s: string): string;
    register(token: string, kind: string): void;
    mapAgent(id: string): string;
    mapTask(id: string): string;
  };
}
interface SentencesModule {
  splitSentences(text: string): string[];
  segmentLine(line: string): { text: string; sep: string }[];
}
interface RedactPolicyModule {
  canonicalToken(token: string): string;
  forbiddenRegExp(token: string): RegExp | null;
}
interface PathMapModule {
  createPathMap(opts: { user: string; home: string; primaryProject: string; hashSegment: (s: string) => string }): {
    registerCwd(p: string): void;
    rewrite(s: string, wholePath?: boolean): string;
  };
}

/** Dynamic import of a plain-JS policy module (no declaration file; the specifier is not a literal, so TS types it `any`). */
async function loadLib<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(join(SCRIPTS_LIB, name)).href)) as T;
}

/**
 * The accepted shapes of a long (> 80 chars) string value (criterion c),
 * pinned here on purpose and independent of `scripts/lib/keep-lists.mjs`:
 *  - it contains a stub token; or
 *  - it is a JSON document (Codex `payload.output` / `arguments`) whose string
 *    values all satisfy this rule; or
 *  - under a command key (`input.command`, `cmd`, `command[]`) it is a command
 *    skeleton: at most MAX_COMMAND_BYTES, every token short, path-like or a
 *    stub, no e-mail; or
 *  - otherwise it is kept prose / kept result lines: every sentence of every
 *    line (table cells split first) is at most MAX_KEPT_SENTENCE_CHARS long
 *    and matches the plan's keep superset PINNED_KEEP_SENTENCE_RE.
 * Every branch rejects real home paths and e-mails. Loosening the generator
 * policy (a wider keep superset, a longer cap) therefore fails this test.
 */
const STUB_TOKEN = /<(?:[a-z]+:\d+b|img|sig|enc|t)>/;
const MAX_KEPT_SENTENCE_CHARS = 300;
const MAX_COMMAND_BYTES = 400;
const MAX_COMMAND_LITERAL_CHARS = 32;
const MAX_BARE_TOKEN_CHARS = 40;
const EMAIL_IN_TEXT = /(?<![\w.-])(?!git@|u@example\.com)[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w-])/;
const COMMAND_KEY = /(?:\.command|\.cmd)(?:\[\d+\])?$/;
const LINE_PREFIX = /^\s*(?:[-*+•]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)?(?:\[[ xX]\]\s+)?/;
const ABBREVIATION_END = /(?:\b(?:e\.g|i\.e|etc|vs|v|cf|approx|incl)|\b[A-Za-z])\.$/i;
/** Harness / Codex / runner grammar lines that carry no keep-superset word but are legitimately kept whole. */
const PINNED_RESULT_LINE =
  /^(?:Chunk ID: [0-9a-f]+|Wall time: [\d.]+ seconds|Process (?:exited with code|running with session ID) -?\d+|Original token count: \d+|Output:|Total output lines: \d+|…\d+ tokens truncated…|(?:<tool_use_error>)?(?:Error: )?Exit code:? -?\d+|Success\. Updated the following files:|[AMD] \S+|Shell cwd was reset to \S+|No matches found|<\/?persisted-output>|All checks passed!|(?:ok|FAIL|PASS)\b.{0,100}|--- (?:PASS|FAIL|SKIP): \S+(?: \([\d.]+s\))?|\[[\w./-]+ (?:\(root-commit\) )?[0-9a-f]{7,}\]|! \[rejected\].{0,120}|error: failed to push.{0,120}|https:\/\/github\.com\/u\/proj\/pull\/\d+\S{0,40}|Output too large \([\d.]+ ?[KMG]?B\)\. Full output saved to: \S+|Preview \(first [\d.]+ ?[KMG]?B\):|\s*\d+ (?:passing(?: \([^)]*\))?|pending|failing)|[#ℹ] (?:tests|pass|fail|cancelled|skipped|todo|suites|duration_ms) [\d.]+|Found \d+ errors?\b.{0,60}|Success: no issues found in \d+ source files?|INFO\s+-\s+Documentation built in [\d.]+ seconds|Duration\s+[\d.]+ ?m?s(?: \(.{0,80}\))?|\d+ files? (?:reformatted|left unchanged|would be reformatted|already formatted)\b.{0,80})$/;

/** Naive sentence split: terminator + whitespace, re-joining abbreviation and lowercase continuations. */
function sentencesOf(line: string): string[] {
  const out: string[] = [];
  for (const chunk of line.split(/(?<=[.!?])\s+/)) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (/^[a-z]/.test(chunk) || ABBREVIATION_END.test(prev))) out[out.length - 1] = `${prev} ${chunk}`;
    else out.push(chunk);
  }
  return out;
}

function isCommandSkeleton(s: string): boolean {
  if (Buffer.byteLength(s, 'utf8') > MAX_COMMAND_BYTES || s.includes('/Users/') || EMAIL_IN_TEXT.test(s)) return false;
  return s.split(/\s+/).every((tok) => {
    const bare = tok.replace(/^["']|["']$/g, '');
    return bare.length <= MAX_BARE_TOKEN_CHARS || bare.includes('/') || STUB_TOKEN.test(bare);
  });
}

function isKeptProse(s: string): boolean {
  if (s.includes('/Users/') || EMAIL_IN_TEXT.test(s)) return false;
  return s.split('\n').every((line) => {
    const cells = /^\s*\|/.test(line) ? line.split('|') : [line];
    return cells.every((cell) => {
      const t = cell.replace(LINE_PREFIX, '').trim();
      if (t === '' || /^[\s|:-]+$/.test(t) || /^(?:```|~~~)/.test(t) || PINNED_RESULT_LINE.test(t)) return true;
      return sentencesOf(t).every((sentence) => sentence.length <= MAX_KEPT_SENTENCE_CHARS && PINNED_KEEP_SENTENCE_RE.test(sentence));
    });
  });
}

function allowedLongString(path: string, s: string): boolean {
  if (s.length <= 80 || STUB_TOKEN.test(s)) return true;
  if (/^\s*[[{]/.test(s)) {
    try {
      const nested: { path: string; value: string }[] = [];
      stringValues(JSON.parse(s), path, nested);
      return nested.every((v) => allowedLongString(v.path, v.value));
    } catch {
      /* not JSON: fall through */
    }
  }
  if (COMMAND_KEY.test(path)) return isCommandSkeleton(s);
  // One mapped path (`file_path`, `outputFile`, a URL): a single token with a separator, never a real home path.
  if (!/\s/.test(s) && s.includes('/') && s.length <= MAX_COMMAND_BYTES && !s.includes('/Users/')) return true;
  return isKeptProse(s);
}

/** Credential-shaped material that must never survive redaction, placeholders included. */
const SECRET_SHAPES = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_.-]{3,}|sk_(?:live|test)_\w+|gh[opsu]_[A-Za-z0-9]{4,}|github_pat_\w+|glpat-\S+|xox[bapr]-\S+|AKIA[0-9A-Z]{8,}|AIza[A-Za-z0-9_-]{8,}|ya29\.\S+|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/;

/** The S03 keep superset, verbatim from the plan (instruction 6); the generator's regex must equal it. */
const PINNED_KEEP_SENTENCE_RE =
  /tests?|pass|passing|green|fail|lint|ruff|eslint|mypy|pyright|tsc|typecheck|build|compil|format|prettier|black|commit|push|pull request|\bPR\b|branch|tag|creat|add|updat|edit|modif|chang|remov|delet|renam|mov|wrote|written|implement|install|\bran\b|re-ran|executed|verif|confirm|double-check|validat|works|working|done|complete|finished|ready|clean|no changes|files? changed|skip|TODO|should|you can|haven't|didn't|couldn't|won't|not yet|left|❌|✅|✔|✘/i;

let keepLists: KeepLists;
let forbidden: Set<string>;
let forbiddenAlgorithm = '';
const fixtures = listFixtures();
const realFixtures = fixtures.filter((id) => readExpected(id).confidence === 'real');

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The hash list stores sha256 of this canonical form (`scripts/lib/redact-policy.mjs` `canonicalToken`). */
const FORBIDDEN_ALGORITHM = 'sha256(canonical token: lower-case, every non-alphanumeric character removed)';
/** Longest forbidden entry, in alphanumeric runs (a UUID is five). */
const MAX_TOKEN_RUNS = 5;

/**
 * Every candidate token of `text` in the separator-tolerant canonical form:
 * each alphanumeric run alone, and each chain of up to MAX_TOKEN_RUNS runs
 * whose neighbours are one non-alphanumeric character apart, joined without
 * the separators. So `example.corp`, `example-corp`, `Example Corp`, a UUID, a
 * home path and an e-mail all reach the same hash as the list entry, whatever
 * separator they were written with. Returns the original spellings that hit.
 */
function canonicalMatches(text: string, list: readonly string[] | Set<string>): string[] {
  const hashes = list instanceof Set ? list : new Set(list.map((t) => sha256(t.toLowerCase().replace(/[^a-z0-9]+/g, ''))));
  const lower = text.toLowerCase();
  const runs: { s: string; start: number; end: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) runs.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  const hits = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    let joined = runs[i]?.s ?? '';
    let end = runs[i]?.end ?? 0;
    for (let k = i; ; k++) {
      if (joined.length >= 3 && hashes.has(sha256(joined))) hits.add(lower.slice(runs[i]?.start ?? 0, end));
      const next = runs[k + 1];
      if (k + 1 - i >= MAX_TOKEN_RUNS || next === undefined || next.start - end !== 1) break;
      joined += next.s;
      end = next.end;
    }
  }
  return [...hits];
}

function forbiddenHits(text: string): string[] {
  return canonicalMatches(text, forbidden);
}

/** Documented placeholder and the synthetic personas the pathmap unit test uses; any other home-directory user segment in a source file is real. */
const SOURCE_HOME_PLACEHOLDERS = new Set(['<name>', 'alice', 'bob']);

function realHomePaths(text: string, allowPlaceholders = false): string[] {
  const placeholder = (hit: string, prefix: string): boolean => allowPlaceholders && SOURCE_HOME_PLACEHOLDERS.has(hit.slice(prefix.length).replace(/[,.;:)]+$/, ''));
  const hits: string[] = [];
  for (const m of text.matchAll(/\/Users\/[^\s"'\\/]+/g)) if (!placeholder(m[0], '/Users/')) hits.push(m[0]);
  for (const m of text.matchAll(/\/home\/(?!u(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g)) if (!placeholder(m[0], '/home/')) hits.push(m[0]);
  return hits;
}

function emailTokens(text: string): string[] {
  const hits: string[] = [];
  for (const t of text.split(/[\s"'`<>()[\],;{}]+/)) {
    if (!t.includes('@')) continue;
    if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}$/.test(t) && t !== 'u@example.com' && !t.startsWith('git@github.com')) hits.push(t);
  }
  return hits;
}

/** Every string value of a JSON tree with its key path (skips `__pad`). */
function stringValues(v: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof v === 'string') out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => stringValues(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '__pad') stringValues(x, `${path}.${k}`, out);
}

beforeAll(async () => {
  keepLists = await loadLib<KeepLists>('keep-lists.mjs');
  const list = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'redaction', 'forbidden.sha256.json'), 'utf8')) as { algorithm: string; hashes: string[] };
  forbidden = new Set(list.hashes);
  forbiddenAlgorithm = list.algorithm;
});

describe('fixture tree', () => {
  it('has every real-shape and synthetic fixture the plan lists', () => {
    for (const id of ['claude-code/2.1.214', 'claude-code/2.1.215', 'claude-code/2.1.235', 'claude-code/2.1.241', 'claude-code/2.1.243', 'claude-code/2.1.251', 'claude-code/legacy', 'codex/0.98.0', 'codex/shell_command']) {
      expect(fixtures, id).toContain(id);
    }
  });

  it('carries a hashed forbidden list and no plaintext one in the committed tree', () => {
    expect(forbidden.size).toBeGreaterThan(10);
    expect(forbiddenAlgorithm).toBe(FORBIDDEN_ALGORITHM);
    for (const h of forbidden) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const gitignore = readFileSync(join(FIXTURES_ROOT, '..', '.gitignore'), 'utf8');
    expect(gitignore).toContain('fixtures/.forbidden.local');
  });

  it.each(fixtures)('%s: expected.json has the S03 sections and a review file when real', (id) => {
    const e = readExpected(id);
    expect(e.fixture).toBe(id);
    expect(['claude-code', 'codex']).toContain(e.harness);
    expect(['real', 'synthetic']).toContain(e.confidence);
    expect(e.redaction.policyVersion).toBe(1);
    expect(e.redaction.seed).toBe('showreceipts-fixtures-1');
    expect(Array.isArray(e.shapes) && e.shapes.length > 0).toBe(true);
    expect(typeof e.source.endedAt).toBe('string');
    if (e.confidence === 'real') expect(existsSync(join(fixtureDir(id), 'REDACTION-REVIEW.md'))).toBe(true);
    for (const [rel, lines] of Object.entries(e.source.files)) {
      expect(readFixtureLines(id, rel).length, `${id}/${rel}`).toBe(lines);
    }
  });
});

describe('privacy scan of every committed fixture file', () => {
  const files = fixtures.flatMap((id) => listFixtureFiles(id).map((rel) => [id, rel] as const));

  it.each(files)('%s/%s decompresses and contains no forbidden token, real home path or e-mail', (id, rel) => {
    const text = readFixtureBytes(id, rel).toString('utf8');
    expect(forbiddenHits(text)).toEqual([]);
    expect(realHomePaths(text)).toEqual([]);
    expect(emailTokens(text)).toEqual([]);
  });

  it.each(fixtures.flatMap((id) => listFixtureFiles(id).filter((rel) => /\.jsonl(\.gz)?$/.test(rel)).map((rel) => [id, rel] as const)))(
    '%s/%s: every line parses, long strings are stubbed or kept skeletons, no credential shapes, owner ids are fixed',
    (id, rel) => {
      const lines = readFixtureLines(id, rel);
      expect(lines.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      const secrets: string[] = [];
      for (const [i, line] of lines.entries()) {
        const record = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line) as Record<string, unknown>;
        if ('ownerAccountUuid' in record) expect(record['ownerAccountUuid']).toBe(FIXED_OWNER_ACCOUNT);
        if ('ownerOrganizationUuid' in record) expect(record['ownerOrganizationUuid']).toBe(FIXED_OWNER_ORG);
        const values: { path: string; value: string }[] = [];
        stringValues(record, `line ${i + 1}`, values);
        for (const { path, value } of values) {
          if (!allowedLongString(path, value)) offenders.push(`${path}: ${value.slice(0, 120)}`);
          const secret = SECRET_SHAPES.exec(value);
          if (secret) secrets.push(`${path}: ${secret[0].slice(0, 40)}`);
        }
      }
      expect(offenders).toEqual([]);
      expect(secrets).toEqual([]);
    },
  );

  it.each(fixtures)('%s: expected.json and the review file carry no forbidden token, home path or e-mail', (id) => {
    for (const name of ['expected.json', 'REDACTION-REVIEW.md']) {
      const p = join(fixtureDir(id), name);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      expect(forbiddenHits(text), name).toEqual([]);
      expect(realHomePaths(text), name).toEqual([]);
      expect(emailTokens(text), name).toEqual([]);
      expect(SECRET_SHAPES.exec(text)?.[0], name).toBeUndefined();
    }
  });

  it('pins the generator policy constants so a loosened policy fails loudly', () => {
    expect(keepLists.MAX_KEPT_SENTENCE_CHARS).toBe(MAX_KEPT_SENTENCE_CHARS);
    expect(keepLists.MAX_COMMAND_LITERAL_CHARS).toBe(MAX_COMMAND_LITERAL_CHARS);
    expect(keepLists.MAX_COMMAND_BYTES).toBe(MAX_COMMAND_BYTES);
    expect(keepLists.KEEP_SENTENCE_RE.source).toBe(PINNED_KEEP_SENTENCE_RE.source);
    expect(keepLists.KEEP_SENTENCE_RE.flags).toBe('i');
    expect(keepLists.STUB_RE.source).toBe(STUB_TOKEN.source);
    for (const sample of ['ANTHROPIC_API_KEY=sk-ant-...', 'token ghp_abcd1234', 'AKIAIOSFODNN7EXAMPLE', 'Authorization: Bearer abc', 'eyJhbGciOiJIUzI1NiJ9.x']) {
      expect(keepLists.SECRET_SHAPE_RE.test(sample), sample).toBe(true);
    }
    expect(keepLists.SECRET_SHAPE_RE.test('All 12 tests pass; the task-runner is green.')).toBe(false);
  });

  it('manifest.json and README carry no forbidden token, real path or e-mail', () => {
    for (const name of ['manifest.json', 'README.md']) {
      const text = readFileSync(join(FIXTURES_ROOT, name), 'utf8');
      expect(forbiddenHits(text), name).toEqual([]);
      expect(realHomePaths(text), name).toEqual([]);
      expect(emailTokens(text), name).toEqual([]);
    }
  });

  it('the redaction scripts, the fixture helper and these tests carry no forbidden token, real home path or e-mail', () => {
    // Real ids reached a test vector once; the committed sources are scanned like the fixtures (the hash file itself excluded).
    const sources = [
      ...walkFiles(join(ROOT, 'scripts')).filter((p) => p.endsWith('.mjs')),
      join(ROOT, 'test', 'helpers', 'fixtures.ts'),
      ...walkFiles(join(ROOT, 'test', 'unit', 'fixtures')).filter((p) => p.endsWith('.ts')),
    ];
    expect(sources.length).toBeGreaterThanOrEqual(10);
    for (const p of sources) {
      const text = readFileSync(p, 'utf8');
      const rel = relative(ROOT, p);
      expect(forbiddenHits(text), rel).toEqual([]);
      expect(realHomePaths(text, true), rel).toEqual([]);
      expect(emailTokens(text), rel).toEqual([]);
    }
  });

  it('no file under src/ or test/ carries a forbidden token in any spelling', () => {
    // A hash scan has no false positives, so it covers every step's sources: a real id used as a test vector fails here.
    const files = [...walkFiles(join(ROOT, 'src')), ...walkFiles(join(ROOT, 'test'))];
    expect(files.length).toBeGreaterThanOrEqual(20);
    const offenders: string[] = [];
    for (const p of files) {
      for (const hit of forbiddenHits(readFileSync(p, 'utf8'))) offenders.push(`${relative(ROOT, p)}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('shape guarantees the plan pins per fixture', () => {
  it('2.1.235 contains a record of at least 1 MiB (padded)', () => {
    const lines = readFixtureLines('claude-code/2.1.235');
    const big = lines.filter((l) => Buffer.byteLength(l, 'utf8') >= 1048576);
    expect(big.length).toBeGreaterThanOrEqual(1);
    const record = JSON.parse(big[0] ?? '') as Record<string, unknown>;
    expect(typeof record['__pad']).toBe('string');
  });

  it('2.1.214 contains a raw U+2028 inside a string that still parses', () => {
    const lines = readFixtureLines('claude-code/2.1.214');
    const hazard = lines.filter((l) => l.includes(' '));
    expect(hazard.length).toBeGreaterThanOrEqual(1);
    for (const l of hazard) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.stringify(JSON.parse(hazard[0] ?? '{}'))).toContain(' ');
  });

  it('2.1.243 has zero assistant lines', () => {
    const types = readFixtureLines('claude-code/2.1.243').map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types.length).toBe(13);
    expect(types.filter((t) => t === 'assistant')).toEqual([]);
  });

  it('2.1.251 has exactly 512 main lines and a journal', () => {
    expect(readFixtureLines('claude-code/2.1.251').length).toBe(512);
    expect(readExpected('claude-code/2.1.251').source.freezeLines).toBe(512);
    expect(listFixtureFiles('claude-code/2.1.251').some((f) => f.endsWith('journal.jsonl.gz'))).toBe(true);
  });

  it('every real fixture records its window and is under the size budget with the rest of fixtures/', () => {
    for (const id of realFixtures) {
      const e = readExpected(id);
      expect(e.source.originalLines).toBeGreaterThan(0);
      expect(e.source.harnessVersion).toMatch(/^\d+(\.\d+){1,3}$/);
    }
  });

  it('ids are consistent between file names and record fields (2.1.214 subagents)', () => {
    const files = listFixtureFiles('claude-code/2.1.214');
    const agentFiles = files.filter((f) => /subagents\/agent-[0-9a-f]{17}\.jsonl\.gz$/.test(f));
    expect(agentFiles.length).toBe(5);
    const mainIds = new Set<string>();
    for (const line of readFixtureLines('claude-code/2.1.214')) {
      const r = JSON.parse(line) as { toolUseResult?: { agentId?: string } };
      if (typeof r.toolUseResult?.agentId === 'string') mainIds.add(r.toolUseResult.agentId);
    }
    for (const f of agentFiles) {
      const id = /agent-([0-9a-f]{17})\.jsonl\.gz$/.exec(f)?.[1] ?? '';
      expect(mainIds.has(id), f).toBe(true);
      const first = JSON.parse(readFixtureLines('claude-code/2.1.214', f)[0] ?? '{}') as { type?: string; agentId?: string; isSidechain?: boolean };
      expect(first.agentId).toBe(id);
      // The fork's file opens with its `fork-context-ref` record; every other file opens with a sidechain user line.
      if (first.type === 'fork-context-ref') expect(first.isSidechain).toBeUndefined();
      else expect(first.isSidechain).toBe(true);
      expect(existsSync(join(fixtureDir('claude-code/2.1.214'), f.replace(/\.jsonl\.gz$/, '.meta.json')))).toBe(true);
    }
  });
});

describe('fixtures/hazards/u2028.jsonl', () => {
  const bytes = readFileSync(join(FIXTURES_ROOT, 'hazards', 'u2028.jsonl'));
  const text = bytes.toString('utf8');

  it('has 10 valid JSON lines split on 0x0A only, ending with a newline', () => {
    let count = 0;
    for (const b of bytes) if (b === 10) count++;
    expect(count).toBe(10);
    expect(bytes[bytes.length - 1]).toBe(10);
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(10);
    lines.forEach((l, i) => {
      const r = JSON.parse(l.endsWith('\r') ? l.slice(0, -1) : l) as { n: number };
      expect(r.n).toBe(i + 1);
    });
  });

  it('carries raw U+2028/U+2029/NEL, an escaped \\u2028, a 3 MB line and a CRLF ending on line 5', () => {
    const lines = text.split('\n');
    expect(text).toContain(' ');
    expect(text).toContain(' ');
    expect(text).toContain('');
    expect(text).toContain('\\u2028');
    expect(lines[4]?.endsWith('\r')).toBe(true);
    expect(lines.some((l) => Buffer.byteLength(l, 'utf8') >= 3000000)).toBe(true);
  });
});

describe('scripts/lib helpers', () => {
  it('idmap keeps UUID version/variant nibbles, the v7 timestamp prefix, and is deterministic', async () => {
    const { createIdMap } = await loadLib<IdMapModule>('idmap.mjs');
    const a = createIdMap('showreceipts-fixtures-1');
    const b = createIdMap('showreceipts-fixtures-1');
    // Synthetic vectors only: a real session/agent/task id in this file would publish what the pipeline hashes away.
    const v4 = '12345678-1234-4abc-8def-123456789abc';
    const v7 = '01900000-0000-7000-8000-000000000001';
    expect(a.mapUuid(v4)).toBe(b.mapUuid(v4));
    expect(a.mapUuid(v4)).not.toBe(v4);
    expect(a.mapUuid(v4)[14]).toBe('4');
    expect(a.mapUuid(v4)[19]).toBe('8');
    expect(a.mapUuid(v7).slice(0, 13)).toBe(v7.slice(0, 13));
    expect(a.mapUuid(v7)[14]).toBe('7');
    expect(a.mapUuid(v7).slice(15)).not.toBe(v7.slice(15));
    expect(createIdMap('other-seed').mapUuid(v4)).not.toBe(a.mapUuid(v4));
    expect(a.rewrite(`path/${v4}/x`)).toBe(`path/${a.mapUuid(v4)}/x`);
    expect(a.rewrite('agent-a0123456789abcdef.jsonl')).toMatch(/^agent-a[0-9a-f]{16}\.jsonl$/);
    expect(a.rewrite('agent-a0123456789abcdef')).toBe('agent-' + a.mapAgent('a0123456789abcdef'));
    expect(a.mapAgent('a0123456789abcdef')).not.toBe('a0123456789abcdef');
    expect(a.rewrite('msg_01ABC def toolu_XYZ')).toMatch(/^msg_[A-Za-z0-9]{5} def toolu_[A-Za-z0-9]{3}$/);
    a.register('abc123xyz', 'task');
    expect(a.mapTask('abc123xyz')).toMatch(/^[a-z0-9]{9}$/);
    expect(a.mapTask('abc123xyz')).not.toBe('abc123xyz');
    expect(a.rewrite('<task-id>abc123xyz</task-id> tool-results/abc123xyz.txt')).toBe(`<task-id>${a.mapTask('abc123xyz')}</task-id> tool-results/${a.mapTask('abc123xyz')}.txt`);
  });

  it('forbidden entries mask every separator spelling and hash to one canonical form', async () => {
    const { canonicalToken, forbiddenRegExp } = await loadLib<RedactPolicyModule>('redact-policy.mjs');
    expect(canonicalToken('Example-Corp.io')).toBe('examplecorpio');
    expect(canonicalToken('Example Corp')).toBe(canonicalToken('example_corp'));
    expect(canonicalToken('12345678-1234-4abc-8def-123456789abc')).toBe('123456781234' + '4abc8def123456789abc');
    expect(forbiddenRegExp('ab')).toBeNull();
    expect(forbiddenRegExp('a-b')).toBeNull();
    const re = forbiddenRegExp('example-corp');
    expect(re).not.toBeNull();
    for (const spelling of ['example-corp', 'example.corp', 'example_corp', 'Example Corp', 'examplecorp', 'EXAMPLE/CORP']) {
      expect(spelling.replace(re as RegExp, 'u'), spelling).toBe('u');
    }
    // Only whole alphanumeric runs: neither a prefix nor an inner substring is masked.
    expect('examples-corp example-corporation xexample-corp'.replace(re as RegExp, 'u')).toBe('examples-corp example-corporation xexample-corp');
    expect('see (example.corp) now'.replace(re as RegExp, 'u')).toBe('see (u) now');
    expect(canonicalMatches('demo_app', ['demo-app'])).toEqual(['demo_app']);
    expect(canonicalMatches('Widget-Sorting Robot System', ['widget-sorting-robot'])).toEqual(['widget-sorting robot']);
    expect(canonicalMatches('the sender domain is `example.corp`', ['example-corp'])).toEqual(['example.corp']);
    expect(canonicalMatches('12345678-1234-4abc-8def-123456789abc', ['12345678-1234-4abc-8def-123456789abc'])).toEqual(['12345678-1234-4abc-8def-123456789abc']);
    expect(canonicalMatches('mail u@example.com now', ['u@example.com'])).toEqual(['u@example.com']);
    expect(canonicalMatches('examples corp / example - corp', ['example-corp'])).toEqual([]);
  });

  it('sentences.mjs splits on terminators + whitespace, not inside backticks or after abbreviations', async () => {
    const { splitSentences, segmentLine } = await loadLib<SentencesModule>('sentences.mjs');
    expect(splitSentences('All tests pass. I added `a.b.c` too! Done?')).toEqual(['All tests pass.', 'I added `a.b.c` too!', 'Done?']);
    expect(splitSentences('Run e.g. the suite. Version 2.1.214 is fine.')).toEqual(['Run e.g. the suite.', 'Version 2.1.214 is fine.']);
    expect(splitSentences('Edited `foo.py`. Then `bar. baz` was left.')).toEqual(['Edited `foo.py`.', 'Then `bar. baz` was left.']);
    expect(splitSentences('He said "done." Next line\nsecond line')).toEqual(['He said "done."', 'Next line', 'second line']);
    const line = '  First one.  Second (ok)?  ';
    expect(segmentLine(line).map((s) => s.text + s.sep).join('')).toBe(line);
  });

  it('pathmap maps home, projects, dash dirs, tmpdir and hashes other home segments', async () => {
    const { createPathMap } = await loadLib<PathMapModule>('pathmap.mjs');
    const pm = createPathMap({ user: 'alice', home: '/Users/alice', primaryProject: '/Users/alice/Desktop/Wattage', hashSegment: (s) => `h${s.length}` });
    pm.registerCwd('/Users/alice/Desktop/Other');
    expect(pm.rewrite('cd /Users/alice/Desktop/Wattage/site && ls')).toBe('cd /home/u/proj/site && ls');
    expect(pm.rewrite('/Users/alice/Desktop/Other/src/x.py')).toBe('/home/u/proj1/src/x.py');
    expect(pm.rewrite('~/.claude/projects/-Users-alice-Desktop-Wattage/ab12cd34e')).toBe('~/.claude/projects/-home-u-proj/ab12cd34e');
    expect(pm.rewrite('-Users-alice')).toBe('-home-u');
    expect(pm.rewrite('-Users-alice-Desktop-Unknown')).toBe('-home-u-proj2');
    expect(pm.rewrite('/private/tmp/claude-501/-Users-alice/abc/scratchpad/f')).toBe('/tmp/claude/-home-u/abc/scratchpad/f');
    expect(pm.rewrite('/var/folders/ab/cd/T/x.txt')).toBe('/tmp/t/x.txt');
    expect(pm.rewrite('/Users/alice/Documents/secret plan.pdf', true)).toBe('/home/u/Documents/h11.pdf');
    expect(pm.rewrite('/Users/bob/x')).toBe('/home/u/h1');
    expect(pm.rewrite('src/wattage/models.py')).toBe('src/wattage/models.py');
    expect(pm.rewrite('cd ~/Desktop/Other2/secret-app && npx tsx apps/x.ts')).toBe('cd ~/Desktop/h6/h10 && npx tsx apps/x.ts');
    expect(pm.rewrite('put it in `~/Desktop/Other2/secret-app/.env`')).toBe('put it in `~/Desktop/h6/h10/.env`');
    expect(pm.rewrite('~/.claude/projects/-Users-alice/x.md')).toBe('~/.claude/projects/-home-u/h1.md');
    expect(pm.rewrite('ls ~/Desktop/Wattage/site')).toBe('ls ~/proj/site');
  });
});
