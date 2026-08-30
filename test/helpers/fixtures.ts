/**
 * The fixture materialiser (PLAN S03, instruction 11). Every later step that
 * needs a Claude Code / Codex tree on disk calls `materialize()` /
 * `materializeAll()`; readers of single files call `readFixtureLines()`.
 *
 * Fixture directories mirror the discovery roots (ARCHITECTURE §4.1):
 * `claude-code/<id>/projects/…` lands under `<into>/claude` (a
 * `CLAUDE_CONFIG_DIR`), `codex/<id>/sessions/…` under `<into>/codex` (a
 * `CODEX_HOME`). Gzipped files are inflated, plain files copied, and every
 * file's mtime is set to the fixture's `endedAt` so `--since` behaves.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** Absolute path of the committed `fixtures/` directory. */
export const FIXTURES_ROOT = fileURLToPath(new URL('../../fixtures/', import.meta.url));
/** Absolute path of `fixtures/readers/`. */
export const READERS_ROOT = join(FIXTURES_ROOT, 'readers');

export type FixtureHarness = 'claude-code' | 'codex';

/** The sections of `expected.json` that S03 writes; later steps add golden sections. */
export interface FixtureExpected {
  fixture: string;
  harness: FixtureHarness;
  confidence: 'real' | 'synthetic';
  source: {
    harnessVersion: string;
    originalLines: number;
    window: string | null;
    freezeLines: number | null;
    startedAt: string | null;
    endedAt: string | null;
    files: Record<string, number>;
    badLines: number;
  };
  shapes: string[];
  redaction: { policyVersion: number; seed: string; reviewedBy: string | null };
  [key: string]: unknown;
}

export interface Materialized {
  fixtureId: string;
  harness: FixtureHarness;
  /** Set for Claude Code fixtures: the directory to use as `CLAUDE_CONFIG_DIR`. */
  claudeConfigDir?: string;
  /** Set for Codex fixtures: the directory to use as `CODEX_HOME`. */
  codexHome?: string;
  /** Absolute paths of every file written, in fixture order. */
  paths: string[];
}

export interface MaterializedAll {
  claudeConfigDir: string;
  codexHome: string;
  fixtures: Record<string, Materialized>;
}

/** Files of a fixture directory that are metadata, not transcript tree. */
const META_FILES = new Set(['expected.json', 'REDACTION-REVIEW.md']);
/** Fallback mtime when a fixture records no `endedAt` (Feb–Aug 2026 window per PLAN §0.4). */
const FALLBACK_MTIME = new Date('2026-08-01T00:00:00Z');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Every fixture id (`claude-code/2.1.214`, `codex/0.98.0`, …), sorted. */
export function listFixtures(): string[] {
  if (!existsSync(READERS_ROOT)) return [];
  return walk(READERS_ROOT)
    .filter((p) => basename(p) === 'expected.json')
    .map((p) => toPosix(relative(READERS_ROOT, dirname(p))))
    .sort();
}

/** Absolute directory of a fixture. */
export function fixtureDir(fixtureId: string): string {
  const dir = join(READERS_ROOT, ...fixtureId.split('/'));
  if (!existsSync(join(dir, 'expected.json'))) throw new Error(`unknown fixture ${fixtureId}`);
  return dir;
}

/** Parsed `expected.json` of a fixture. */
export function readExpected(fixtureId: string): FixtureExpected {
  return JSON.parse(readFileSync(join(fixtureDir(fixtureId), 'expected.json'), 'utf8')) as FixtureExpected;
}

/** Harness of a fixture (from `expected.json`, falling back to the id prefix). */
export function fixtureHarness(fixtureId: string): FixtureHarness {
  const e = readExpected(fixtureId);
  return e.harness === 'codex' || (e.harness === undefined && fixtureId.startsWith('codex')) ? 'codex' : 'claude-code';
}

/**
 * Relative (POSIX) paths of the transcript-tree files of a fixture, as stored
 * (`.gz` suffixes included); `expected.json` and the review file are excluded.
 */
export function listFixtureFiles(fixtureId: string): string[] {
  const dir = fixtureDir(fixtureId);
  return walk(dir)
    .map((p) => toPosix(relative(dir, p)))
    .filter((rel) => !META_FILES.has(basename(rel)));
}

/** Bytes of one fixture file, gunzipped when stored as `.gz`. `rel` may omit the `.gz` suffix. */
export function readFixtureBytes(fixtureId: string, rel: string): Buffer {
  const dir = fixtureDir(fixtureId);
  const plain = join(dir, ...rel.split('/'));
  if (existsSync(plain)) return plain.endsWith('.gz') ? gunzipSync(readFileSync(plain)) : readFileSync(plain);
  const gz = plain + '.gz';
  if (existsSync(gz)) return gunzipSync(readFileSync(gz));
  throw new Error(`no such fixture file: ${fixtureId}/${rel}`);
}

/** The main transcript of a fixture (the `<sid>.jsonl` under a project directory, or the first Codex rollout), relative, without `.gz`. */
export function mainTranscriptOf(fixtureId: string): string {
  const files = listFixtureFiles(fixtureId).map((f) => f.replace(/\.gz$/, ''));
  const harness = fixtureHarness(fixtureId);
  const main = files.find((f) => (harness === 'codex' ? /(^|\/)rollout-[^/]+\.jsonl$/.test(f) : /^projects\/[^/]+\/[^/]+\.jsonl$/.test(f)));
  if (main === undefined) throw new Error(`fixture ${fixtureId} has no main transcript`);
  return main;
}

/**
 * Lines of one fixture transcript, split on `\n` (a trailing empty line
 * dropped). Defaults to the main transcript.
 */
export function readFixtureLines(fixtureId: string, rel?: string): string[] {
  const text = readFixtureBytes(fixtureId, rel ?? mainTranscriptOf(fixtureId)).toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function mtimeOf(fixtureId: string): Date {
  const endedAt = readExpected(fixtureId).source?.endedAt;
  const d = typeof endedAt === 'string' ? new Date(endedAt) : FALLBACK_MTIME;
  return Number.isNaN(d.getTime()) ? FALLBACK_MTIME : d;
}

/**
 * Inflates one fixture into `into` with the real directory layout. Returns
 * the directory to use as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and every path
 * written. Files that several fixtures share (`session_index.jsonl`) are
 * appended to, so fixtures can be materialised into one tree.
 */
export function materialize(fixtureId: string, into: string): Materialized {
  const dir = fixtureDir(fixtureId);
  const harness = fixtureHarness(fixtureId);
  const root = join(into, harness === 'codex' ? 'codex' : 'claude');
  const mtime = mtimeOf(fixtureId);
  const paths: string[] = [];
  for (const rel of listFixtureFiles(fixtureId)) {
    const source = join(dir, ...rel.split('/'));
    const target = join(root, ...rel.replace(/\.gz$/, '').split('/'));
    mkdirSync(dirname(target), { recursive: true });
    const bytes = rel.endsWith('.gz') ? gunzipSync(readFileSync(source)) : readFileSync(source);
    if (existsSync(target) && basename(target) === 'session_index.jsonl') appendFileSync(target, bytes);
    else writeFileSync(target, bytes);
    utimesSync(target, mtime, mtime);
    paths.push(target);
  }
  const out: Materialized = { fixtureId, harness, paths };
  if (harness === 'codex') out.codexHome = root;
  else out.claudeConfigDir = root;
  return out;
}

/** Materialises every fixture into one tree (`<into>/claude`, `<into>/codex`), for e2e runs. */
export function materializeAll(into: string): MaterializedAll {
  const fixtures: Record<string, Materialized> = {};
  for (const id of listFixtures()) fixtures[id] = materialize(id, into);
  const claudeConfigDir = join(into, 'claude');
  const codexHome = join(into, 'codex');
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  return { claudeConfigDir, codexHome, fixtures };
}
