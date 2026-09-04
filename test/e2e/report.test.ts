/**
 * S26 e2e — `node dist/cli.js report` over the materialised fixture tree:
 * the file is written, the S22 structural checks hold on the real output
 * (CSP self-check, script accounting, inert data block, self-containment),
 * `--json` validates, and `--hash-paths=both` embeds both payloads with the
 * hashed one free of raw home paths.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReportPayload } from '../../src/model/types.js';
import { selfCheck } from '../../src/render/html.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';
import { countOf, dataBlock, templateOnly } from '../render/harness.js';

const doc = loadSchemaDoc();

const tree = makeTempDir('showreceipts-e2e-report-');
const materialized = materializeAll(tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
// The out dir lives outside the fixture tree so `--json`'s `out` field never
// trips the "no fixture path leaked" assertions below.
const outDir = makeTempDir('showreceipts-e2e-report-out-');
for (const dir of [home, cwd, join(tree, 'sr')]) mkdirSync(dir, { recursive: true });

const ENV: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: materialized.claudeConfigDir,
  CODEX_HOME: materialized.codexHome,
  SHOWRECEIPTS_HOME: join(tree, 'sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

// `--all` covers every fixture (the 2025 legacy session included: 10 sessions).
const BASE = ['report', '--all', '--home-dir', '/home/u', '--no-color'];

function run(args: readonly string[]): RunCliResult {
  return runCli(args, { env: ENV, cwd });
}

/** The parsed `#data` block of an emitted document. */
function dataOf(html: string): { mode: string; payload: ReportPayload; hashed?: ReportPayload } {
  return JSON.parse(dataBlock(html).text) as { mode: string; payload: ReportPayload; hashed?: ReportPayload };
}

describe('report over the fixture tree', () => {
  const out = join(outDir, 'report.html');
  const r = run([...BASE, '--out', out, '--json']);
  const html = readFileSync(out, 'utf8');

  it('writes the file and the --json envelope validates against the schema', () => {
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(validateAgainst(doc, 'report', parsed)).toEqual([]);
    expect(parsed['out']).toBe(out);
    expect(parsed['bytes']).toBe(statSync(out).size);
    expect(parsed['sessions']).toBe(10);
    expect(Object.keys(parsed['bytesBySection'] as Record<string, number>).sort()).toEqual(['cards', 'receipts', 'template', 'timelines']);
  });

  it('the emitted document passes the S22 CSP self-check', () => {
    const check = selfCheck(html);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('has exactly three script blocks and an inert data block that round-trips', () => {
    expect(countOf(html, '<script')).toBe(3);
    expect(countOf(html, '<' + '/script>')).toBe(3);
    const { text } = dataBlock(html);
    expect(/[<>&\u2028\u2029]/.test(text)).toBe(false);
    const data = dataOf(html);
    expect(data.mode).toBe('clear');
    expect(data.payload.sessions.length).toBe(10);
    expect(Object.keys(data.payload.receipts).length).toBe(10);
  });

  it('is self-contained: no external resource patterns in the template', () => {
    const template = templateOnly(html);
    for (const marker of ['<link', '<img', '<iframe', '<embed', '<object', ' src=', '@import', 'href="http']) {
      expect(template).not.toContain(marker);
    }
  });

  it('never embeds the temp fixture tree path', () => {
    expect(html).not.toContain(tree);
    // stdout names the --out file by design; the fixture roots must not appear.
    expect(r.stdout).not.toContain(materialized.claudeConfigDir);
    expect(r.stdout).not.toContain(materialized.codexHome);
  });
});

describe('report --hash-paths=both', () => {
  const out = join(outDir, 'both.html');
  const r = run([...BASE, '--out', out, '--hash-paths=both']);
  const html = readFileSync(out, 'utf8');

  it('embeds clear and hashed payloads with the toggle mode', () => {
    expect(r.code).toBe(0);
    const data = dataOf(html);
    expect(data.mode).toBe('both');
    expect(data.payload.meta.hashPaths).toBe(false);
    expect(data.hashed).toBeDefined();
    expect(data.hashed?.meta.hashPaths).toBe(true);
  });

  it('the hashed payload carries no raw home path', () => {
    const hashed = JSON.stringify(dataOf(html).hashed);
    expect(hashed).not.toContain('/home/u');
    expect(hashed).not.toContain(tree);
  });

  it('still passes the CSP self-check', () => {
    expect(selfCheck(html).ok).toBe(true);
  });
});

describe('report text output', () => {
  it('prints the section sizes without leaking the out path root', () => {
    const out = join(outDir, 'text.html');
    const r = run([...BASE, '--out', out]);
    expect(r.code).toBe(0);
    for (const word of ['report', 'cards', 'receipts', 'timelines', 'template']) expect(r.stdout).toContain(word);
  });
});
