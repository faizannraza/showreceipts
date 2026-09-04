/**
 * S22 (g) — `--hash-paths` (§11.2): the hashed report contains neither the
 * home directory, the username (as `extraTokens`, per the W3 integration
 * decision), nor any fixture absolute path outside the session cwd; `both`
 * embeds two payloads and the app's toggle references both. The pass is the
 * imported S18 `hashStrings` — never reimplemented here.
 */
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/render/html.js';
import { buildReportPayload, payloadKey, type ReportSessionInput } from '../../src/render/payload.js';
import { stableStringify } from '../../src/util/json.js';
import { dataBlock, makeEntry, makeInput, makeRateRow, NOW } from './harness.js';

// Deterministic sensitive tokens, always asserted…
const FAKE_HOME = '/Users/hashme-home';
const FAKE_USER = 'hashmeuser';
// …plus the real ones from the OS, asserted when they cannot collide with
// benign payload/template text (a short or generic username like "test"
// would make .not.toContain meaningless).
const REAL_HOME = homedir();
const REAL_USER = userInfo().username;

const CWD = '/home/u/proj';

function inputs(): ReportSessionInput[] {
  return [
    makeInput(1, {
      card: { cwd: CWD, title: `notes at ${FAKE_HOME}/journal.md by ${FAKE_USER} and ${REAL_USER}` },
      receipt: {
        cwd: CWD,
        finalText: `wrote ${FAKE_HOME}/secret/notes.txt, ${REAL_HOME}/real/notes.txt, /Users/eve/secret/place.txt and src/x.ts for ${FAKE_USER}`,
        lines: [
          {
            glyph: 'ok',
            claim: `updated ${FAKE_HOME}/dotfiles/zshrc`,
            evidence: [`Edit /Users/eve/secret/place.txt (10:05) by ${FAKE_USER}`],
            refs: [{ seq: 12, label: 'write', at: '2026-08-01T10:05:00.000Z' }],
          },
        ],
      },
      timeline: [
        makeEntry({ summary: `cat ${REAL_HOME}/.ssh/config`, files: ['/Users/eve/secret/place.txt', `${CWD}/src/x.ts`] }),
      ],
    }),
  ];
}

const extraTokens = [FAKE_HOME, FAKE_USER, REAL_HOME, ...(REAL_USER.length >= 2 ? [REAL_USER] : [])];

function renderMode(mode: 'off' | 'on' | 'both'): string {
  // meta.hashPaths is stamped by the renderer's hashed copy itself; the base
  // payload stays `false` (it is the clear half under `both`).
  const { payload } = buildReportPayload(inputs(), { now: NOW, rows: [makeRateRow()] });
  return renderHtml(payload, mode === 'off' ? {} : { hashPaths: mode, salt: 'hashpaths-test-salt', extraTokens });
}

describe('mode on', () => {
  const html = renderMode('on');
  const clear = renderMode('off');
  const data = dataBlock(html).text;

  it('the clear render leaks (sanity: the assertions below mean something)', () => {
    const clearData = dataBlock(clear).text;
    expect(clearData).toContain(FAKE_HOME);
    expect(clearData).toContain(FAKE_USER);
    expect(clearData).toContain('/Users/eve/secret/place.txt');
  });

  it('contains neither the home dir nor the username', () => {
    expect(html).not.toContain(FAKE_HOME);
    expect(html).not.toContain(FAKE_USER);
    // Real OS tokens, guarded against benign collisions with the template.
    const template = html.slice(0, dataBlock(html).start) + html.slice(dataBlock(html).end);
    if (!template.includes(REAL_HOME)) expect(data).not.toContain(REAL_HOME);
    if (REAL_USER.length >= 6 && !template.includes(REAL_USER)) expect(data).not.toContain(REAL_USER);
  });

  it('contains no fixture absolute path outside the cwd', () => {
    expect(html).not.toContain('/Users/eve/secret/place.txt');
    expect(html).not.toContain('/Users/eve');
    expect(data).toMatch(/p:[0-9a-f]{8}\/place\.txt/);
  });

  it('keeps cwd-relative paths readable', () => {
    expect(data).toContain('src/x.ts');
  });

  it('marks the payload as hashed and never emits the salt', () => {
    const parsed = JSON.parse(data) as { mode: string; payload: { meta: { hashPaths: boolean } } };
    expect(parsed.mode).toBe('hashed');
    expect(parsed.payload.meta.hashPaths).toBe(true);
    expect(html).not.toContain('hashpaths-test-salt');
  });
});

describe('mode both', () => {
  const html = renderMode('both');

  it('embeds two payloads — clear and hashed — in one data block', () => {
    const parsed = JSON.parse(dataBlock(html).text) as {
      mode: string;
      payload: { meta: { hashPaths: boolean } };
      hashed: { meta: { hashPaths: boolean }; receipts: Record<string, { hashPaths?: boolean }> };
    };
    expect(parsed.mode).toBe('both');
    expect(parsed.payload.meta.hashPaths).toBe(false);
    expect(parsed.hashed.meta.hashPaths).toBe(true);
    expect(Object.values(parsed.hashed.receipts)[0]?.hashPaths).toBe(true);
    expect(stableStringify(parsed.hashed)).not.toBe(stableStringify(parsed.payload));
  });

  it('the toggle source references both payloads', () => {
    const src = readFileSync(new URL('../../src/render/report.js', import.meta.url), 'utf8');
    expect(src).toContain('DATA.payload');
    expect(src).toContain('DATA.hashed');
    expect(src).toMatch(/mode.*both|both.*mode/);
  });

  it('still has exactly one data block (three scripts total)', () => {
    expect(html.match(/<script/g)).toHaveLength(3);
  });
});

describe('salt determinism', () => {
  it('one salt is deterministic; different salts differ', () => {
    const a = renderMode('on');
    const b = renderMode('on');
    expect(a).toBe(b);
    const { payload } = buildReportPayload(inputs(), { now: NOW, rows: [makeRateRow()], hashPaths: true });
    const c = renderHtml(payload, { hashPaths: 'on', salt: 'another-salt', extraTokens });
    expect(dataBlock(c).text).not.toBe(dataBlock(a).text);
  });

  it('a fresh random salt is used when none is given (still no leak)', () => {
    const { payload } = buildReportPayload(inputs(), { now: NOW, rows: [makeRateRow()], hashPaths: true });
    const html = renderHtml(payload, { hashPaths: 'on', extraTokens });
    expect(html).not.toContain(FAKE_HOME);
    expect(html).not.toContain('/Users/eve/secret/place.txt');
  });
});
