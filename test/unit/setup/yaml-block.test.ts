/**
 * S30 — `setup/yaml-block.ts`: the Hermes managed block (§9) — append rules,
 * trailing-newline repair, manual outcomes for foreign `hooks:` keys and
 * multi-document files, exact-block removal. Pure text tests.
 */
import { describe, expect, it } from 'vitest';
import {
  applyHermesBlock,
  HERMES_BLOCK_BEGIN,
  HERMES_BLOCK_END,
  hermesBlock,
  removeHermesBlock,
} from '../../../src/setup/yaml-block.js';

const LAUNCHER = '/home/u/.showreceipts/bin/showreceipts-hook';
const BLOCK = hermesBlock(LAUNCHER);

describe('hermesBlock', () => {
  it('carries all five events with the double-quoted launcher path', () => {
    for (const event of ['post_tool_call', 'post_llm_call', 'on_session_start', 'on_session_end', 'on_session_finalize']) {
      expect(BLOCK).toContain(`command: '"${LAUNCHER}" hook hermes ${event}'`);
    }
    expect(BLOCK.startsWith(`${HERMES_BLOCK_BEGIN}\n`)).toBe(true);
    expect(BLOCK.endsWith(`${HERMES_BLOCK_END}\n`)).toBe(true);
    expect(BLOCK).toContain('- matcher: ".*"');
  });

  it('survives a launcher path with spaces and single quotes', () => {
    const block = hermesBlock("/home/my user/it's bin/showreceipts-hook");
    expect(block).toContain(`'"/home/my user/it''s bin/showreceipts-hook" hook hermes post_llm_call'`);
  });
});

describe('applyHermesBlock', () => {
  it('installs into a missing file (block only)', () => {
    const result = applyHermesBlock(null, BLOCK);
    expect(result.kind).toBe('installed');
    if (result.kind !== 'manual') expect(result.text).toBe(BLOCK);
  });

  it('appends after a hooks_auto_accept-only file, leaving it intact', () => {
    const seed = 'hooks_auto_accept: true\n';
    const result = applyHermesBlock(seed, BLOCK);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'manual') expect(result.text).toBe(seed + BLOCK);
  });

  it('fixes a missing trailing newline before appending', () => {
    const result = applyHermesBlock('model: hermes-4', BLOCK);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'manual') expect(result.text).toBe(`model: hermes-4\n${BLOCK}`);
  });

  it('is unchanged on a second apply and updated when the launcher moves', () => {
    const once = applyHermesBlock('a: 1\n', BLOCK);
    if (once.kind === 'manual') throw new Error('unexpected manual');
    expect(applyHermesBlock(once.text, BLOCK).kind).toBe('unchanged');
    const moved = applyHermesBlock(once.text, hermesBlock('/elsewhere/showreceipts-hook'));
    expect(moved.kind).toBe('updated');
    if (moved.kind !== 'manual') {
      expect(moved.text).toContain('/elsewhere/showreceipts-hook');
      expect(moved.text).not.toContain(LAUNCHER);
    }
  });

  it('refuses a foreign top-level hooks: key (manual)', () => {
    const result = applyHermesBlock('hooks:\n  post_llm_call: []\n', BLOCK);
    expect(result.kind).toBe('manual');
    if (result.kind === 'manual') expect(result.reason).toContain('hooks:');
    // …but hooks_auto_accept must NOT trip the hooks: detector.
    expect(applyHermesBlock('hooks_auto_accept: true\n', BLOCK).kind).toBe('updated');
  });

  it('refuses multi-document YAML (manual)', () => {
    expect(applyHermesBlock('---\na: 1\n', BLOCK).kind).toBe('manual');
    expect(applyHermesBlock('a: 1\n...\n', BLOCK).kind).toBe('manual');
  });
});

describe('removeHermesBlock', () => {
  it('removes exactly the block, restoring the original bytes', () => {
    const seed = 'hooks_auto_accept: true\nmodel: hermes-4\n';
    const installed = applyHermesBlock(seed, BLOCK);
    if (installed.kind === 'manual') throw new Error('unexpected manual');
    const removed = removeHermesBlock(installed.text);
    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(seed);
  });

  it('reports no change when no marker is present', () => {
    const result = removeHermesBlock('a: 1\n');
    expect(result.changed).toBe(false);
    expect(result.text).toBe('a: 1\n');
  });

  it('removes to EOF when the end marker is missing (truncated write)', () => {
    const truncated = `keep: 1\n${HERMES_BLOCK_BEGIN}\nhooks:\n  broken`;
    const result = removeHermesBlock(truncated);
    expect(result.changed).toBe(true);
    expect(result.text).toBe('keep: 1');
  });
});
