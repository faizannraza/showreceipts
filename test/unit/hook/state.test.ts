/**
 * S27 — `hook/state.ts`: tolerant reads (missing, corrupt, wrongly typed),
 * atomic `0600`/`0700` writes, hostile sids staying inside the state
 * directory, and the tolerant `setup.json` helper.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { statePath } from '../../../src/hook/paths.js';
import { freshHookState, readHookState, readSetupState, writeHookState } from '../../../src/hook/state.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];

function tempHome(): string {
  const dir = makeTempDir('sr-state-');
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => fs.statSync(path).mode & 0o777;

describe('readHookState / writeHookState', () => {
  it('a missing file is a fresh state', () => {
    expect(readHookState(tempHome(), 'cursor', 'sess-1')).toEqual({ nudges: 0, turnIds: [] });
  });

  it('round-trips through an atomic 0600 file in 0700 directories', () => {
    const home = tempHome();
    const state = { lastNudgeFinalHash: 'ab'.repeat(32), nudges: 2, turnIds: ['1', '2'] };
    writeHookState(home, 'cursor', 'sess-1', state);
    expect(readHookState(home, 'cursor', 'sess-1')).toEqual(state);
    const path = statePath(home, 'cursor', 'sess-1');
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
  });

  it('a corrupt file is a fresh state', () => {
    const home = tempHome();
    const path = statePath(home, 'gemini', 'sess-2');
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, 'not json');
    expect(readHookState(home, 'gemini', 'sess-2')).toEqual(freshHookState());
  });

  it('wrongly typed fields are dropped or coerced', () => {
    const home = tempHome();
    const path = statePath(home, 'gemini', 'sess-3');
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ nudges: 'x', turnIds: [1, 'a', null], lastNudgeFinalHash: 5, extra: true }));
    expect(readHookState(home, 'gemini', 'sess-3')).toEqual({ nudges: 0, turnIds: ['a'] });
    fs.writeFileSync(path, JSON.stringify({ nudges: 3.9, turnIds: 'nope' }));
    expect(readHookState(home, 'gemini', 'sess-3')).toEqual({ nudges: 3, turnIds: [] });
  });

  it('a hostile sid stays inside the state directory', () => {
    const home = tempHome();
    writeHookState(home, 'cursor', '../../evil', { nudges: 1, turnIds: [] });
    const entries = fs.readdirSync(join(home, 'state', 'cursor'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^h[0-9a-f]{32}\.json$/);
    expect(fs.existsSync(join(home, 'evil'))).toBe(false);
    expect(readHookState(home, 'cursor', '../../evil')).toEqual({ nudges: 1, turnIds: [] });
  });

  it('freshHookState returns a new object each call', () => {
    expect(freshHookState()).not.toBe(freshHookState());
  });
});

describe('readSetupState', () => {
  it('is {} for a missing or malformed file', () => {
    const home = tempHome();
    expect(readSetupState(home)).toEqual({});
    fs.mkdirSync(join(home, 'state'), { recursive: true });
    fs.writeFileSync(join(home, 'state', 'setup.json'), '[broken');
    expect(readSetupState(home)).toEqual({});
  });

  it('keeps only boolean createdHooksKey entries', () => {
    const home = tempHome();
    fs.mkdirSync(join(home, 'state'), { recursive: true });
    fs.writeFileSync(
      join(home, 'state', 'setup.json'),
      JSON.stringify({ createdHooksKey: { 'claude-code': true, gemini: false, x: 'no' }, other: 1 }),
    );
    expect(readSetupState(home)).toEqual({ createdHooksKey: { 'claude-code': true, gemini: false } });
    fs.writeFileSync(join(home, 'state', 'setup.json'), JSON.stringify({ createdHooksKey: 'nope' }));
    expect(readSetupState(home)).toEqual({});
  });
});
