/**
 * S08: `apply_patch` parsing (§4.3.4). Writes are gated on the output, never
 * on `status`; failed patches keep `attempted[]` and no `filesTouched`.
 */
import { describe, expect, it } from 'vitest';
import {
  customPatchOutcome,
  extractPatchFromCommand,
  headerPaths,
  parsePatchText,
  patchOutcome,
} from '../../../../src/readers/codex/patch.js';

const FULL_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.py',
  '+line one',
  '+line two',
  '*** Delete File: src/old.py',
  '*** Update File: src/from.py',
  '*** Move to: src/to.py',
  '@@',
  '-removed line',
  '+added line',
  '*** End Patch',
].join('\n');

describe('parsePatchText', () => {
  it('parses Add/Update/Delete/Move headers, hunks and ± counts', () => {
    const p = parsePatchText(FULL_PATCH);
    expect(p).not.toBeNull();
    expect(p?.ops).toEqual([
      { verb: 'create', path: 'src/new.py' },
      { verb: 'delete', path: 'src/old.py' },
      { verb: 'update', path: 'src/from.py', movedTo: 'src/to.py' },
    ]);
    expect(p?.hunks).toBe(1);
    expect(p?.added).toEqual(['line one', 'line two', 'added line']);
    expect(p?.removed).toEqual(['removed line']);
    expect(p?.truncated).toBe(false);
  });

  it('returns null without a Begin Patch block', () => {
    expect(parsePatchText('no patch here')).toBeNull();
  });

  it('never counts header lines as ± lines and caps at 2,000 combined lines', () => {
    const big = ['*** Begin Patch', '*** Update File: a.txt', '@@', ...Array.from({ length: 2001 }, (_, i) => `+l${i}`), '*** End Patch'];
    const p = parsePatchText(big.join('\n'));
    expect(p?.added.length).toBe(2000);
    expect(p?.truncated).toBe(true);
    expect(p?.ops).toEqual([{ verb: 'update', path: 'a.txt' }]);
  });

  it('ignores content after End Patch', () => {
    const p = parsePatchText(`${FULL_PATCH}\n+not counted`);
    expect(p?.added).toEqual(['line one', 'line two', 'added line']);
  });
});

describe('extractPatchFromCommand', () => {
  it('finds the patch in a heredoc command', () => {
    const cmd = `apply_patch <<'EOF'\n${FULL_PATCH}\nEOF`;
    expect(extractPatchFromCommand(cmd)).toBe(cmd);
    expect(parsePatchText(extractPatchFromCommand(cmd) ?? '')).not.toBeNull();
  });

  it('finds the patch in a quoted argv[1]', () => {
    const cmd = `apply_patch '${FULL_PATCH}'`;
    expect(extractPatchFromCommand(cmd)).not.toBeNull();
  });

  it('returns null for other commands and for apply_patch without a block', () => {
    expect(extractPatchFromCommand('npm test')).toBeNull();
    expect(extractPatchFromCommand('apply_patch --help')).toBeNull();
    expect(extractPatchFromCommand('echo apply_patch')).toBeNull();
  });
});

describe('headerPaths', () => {
  it('lists create/delete paths and both ends of a move (target first)', () => {
    const p = parsePatchText(FULL_PATCH);
    expect(p === null ? [] : headerPaths(p)).toEqual(['src/new.py', 'src/old.py', 'src/to.py', 'src/from.py']);
  });
});

describe('patchOutcome (exec-delivered patches)', () => {
  const parsed = parsePatchText(FULL_PATCH);

  it('succeeds only on exit 0 + Success. body; [AMD] lines are authoritative', () => {
    const body = 'Success. Updated the following files:\nA src/new.py\nD src/old.py\nM src/to.py\n';
    const o = patchOutcome(parsed, body, 0);
    expect(o.ok).toBe(true);
    expect(o.isError).toBe(false);
    expect(o.exitCode).toBe(0);
    expect(o.filesTouched).toEqual(['src/new.py', 'src/old.py', 'src/to.py']);
    expect(o.attempted).toEqual([]);
  });

  it('falls back to the input headers when the body lists no [AMD] lines', () => {
    const o = patchOutcome(parsed, 'Success.', 0);
    expect(o.filesTouched).toEqual(['src/new.py', 'src/old.py', 'src/to.py', 'src/from.py']);
  });

  it('fails on a nonzero exit even when the body says Success.', () => {
    const o = patchOutcome(parsed, 'Success. Updated the following files:\nM src/to.py\n', 1);
    expect(o.ok).toBe(false);
    expect(o.isError).toBe(true);
    expect(o.filesTouched).toEqual([]);
    expect(o.attempted).toEqual(['src/new.py', 'src/old.py', 'src/to.py', 'src/from.py']);
  });

  it('fails without a Success. prefix and defaults an unreported exit to 1', () => {
    const o = patchOutcome(parsed, 'apply_patch verification failed: Failed to find expected lines in /home/u/x.py:', null);
    expect(o.ok).toBe(false);
    expect(o.exitCode).toBe(1);
    expect(o.attempted.length).toBeGreaterThan(0);
  });
});

describe('customPatchOutcome (custom_tool_call_output)', () => {
  const parsed = parsePatchText(FULL_PATCH);

  it('gates through the JSON envelope', () => {
    const o = customPatchOutcome(parsed, JSON.stringify({ output: 'Success. Updated the following files:\nM src/to.py\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }));
    expect(o.ok).toBe(true);
    expect(o.filesTouched).toEqual(['src/to.py']);
    expect(o.body.startsWith('Success.')).toBe(true);
  });

  it('treats a JSON envelope with a nonzero exit as a failed patch', () => {
    const o = customPatchOutcome(parsed, JSON.stringify({ output: 'error', metadata: { exit_code: 2 } }));
    expect(o.ok).toBe(false);
    expect(o.exitCode).toBe(2);
    expect(o.filesTouched).toEqual([]);
    expect(o.attempted.length).toBe(4);
  });

  it('treats non-JSON output (verification failed) as isError + exit 1 + attempted', () => {
    const o = customPatchOutcome(parsed, 'apply_patch verification failed: Failed to find expected lines in /home/u/proj/a.py:');
    expect(o.ok).toBe(false);
    expect(o.isError).toBe(true);
    expect(o.exitCode).toBe(1);
    expect(o.filesTouched).toEqual([]);
    expect(o.attempted).toEqual(['src/new.py', 'src/old.py', 'src/to.py', 'src/from.py']);
  });

  it('handles a missing parsed patch (no attempted paths to report)', () => {
    const o = customPatchOutcome(null, 'garbage');
    expect(o.attempted).toEqual([]);
    expect(o.isError).toBe(true);
  });
});
