/**
 * S30 — `setup/json-merge.ts`: format detection, strict/comment/malformed
 * classification, marker matching, the strip-and-append merge engine and the
 * §9 removal rules, over temp files.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../../src/setup/diff.js';
import {
  applyJsonWriter,
  classifyJsonText,
  detectJsonFormat,
  entryMarked,
  serializeJson,
} from '../../../src/setup/json-merge.js';
import type { WriterContext } from '../../../src/setup/plan.js';
import { desiredClaudeCode } from '../../../src/setup/writers/claude-code.js';
import { makeTempDir } from '../../helpers/tmp.js';

const LAUNCHER = '/opt/sr/bin/showreceipts-hook';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = makeTempDir('sr-json-merge-');
  dirs.push(dir);
  return dir;
}

interface CtxHandle {
  ctx: WriterContext;
  backups: string[];
}

function makeCtx(dir: string, overrides: Partial<WriterContext> = {}): CtxHandle {
  const backups: string[] = [];
  const ctx: WriterContext = {
    harness: 'claude-code',
    target: { path: join(dir, 'settings.json'), scope: 'user', notes: [] },
    launcherPath: LAUNCHER,
    launcherCmdPath: `${LAUNCHER}.cmd`,
    strict: false,
    remove: false,
    dryRun: false,
    nowMs: 1_700_000_000_000,
    home: dir,
    showreceiptsHome: join(dir, '.sr'),
    codexHome: join(dir, '.codex'),
    createdHooksKey: false,
    backup: (text) => {
      const path = join(dir, `backup.${backups.length}`);
      writeFileSync(path, text);
      backups.push(path);
      return path;
    },
    ...overrides,
  };
  return { ctx, backups };
}

describe('detectJsonFormat', () => {
  it('detects two-space, four-space and tab indentation', () => {
    expect(detectJsonFormat('{\n  "a": 1\n}\n').indent).toBe('  ');
    expect(detectJsonFormat('{\n    "a": 1\n}\n').indent).toBe('    ');
    expect(detectJsonFormat('{\n\t"a": 1\n}\n').indent).toBe('\t');
    expect(detectJsonFormat('{}').indent).toBe('  ');
  });

  it('remembers the trailing newline', () => {
    expect(detectJsonFormat('{}\n').trailingNewline).toBe(true);
    expect(detectJsonFormat('{}').trailingNewline).toBe(false);
    expect(serializeJson({ a: 1 }, { indent: '\t', trailingNewline: false })).toBe('{\n\t"a": 1\n}');
  });
});

describe('classifyJsonText', () => {
  it('classifies strict, comment-bearing, malformed and non-object JSON', () => {
    expect(classifyJsonText('{"a": 1}\n').kind).toBe('ok');
    expect(classifyJsonText('[1, 2]\n').kind).toBe('not-object');
    expect(classifyJsonText('// hello\n{"a": 1}\n').kind).toBe('comments');
    expect(classifyJsonText('{"a": /* inline */ 1}\n').kind).toBe('comments');
    expect(classifyJsonText('{"a": \n').kind).toBe('malformed');
  });
});

describe('entryMarked', () => {
  it('recognises our commands in every dialect field and ignores foreign ones', () => {
    expect(entryMarked({ command: `"${LAUNCHER}" hook claude-code Stop` })).toBe(true);
    expect(entryMarked({ command: 'showreceipts hook cursor stop' })).toBe(true);
    expect(entryMarked({ bash: `"${LAUNCHER}" hook copilot agentStop` })).toBe(true);
    expect(entryMarked({ powershell: `"${LAUNCHER}.cmd" hook copilot agentStop` })).toBe(true);
    expect(entryMarked({ commandWindows: `"${LAUNCHER}.cmd" hook codex Stop` })).toBe(true);
    expect(entryMarked({ command: 'echo done' })).toBe(false);
    expect(entryMarked('not an object')).toBe(false);
  });
});

describe('applyJsonWriter — install', () => {
  it('creates a fresh 0600 file with two-space indent and reports installed', () => {
    const dir = tempDir();
    const { ctx, backups } = makeCtx(dir);
    const outcome = applyJsonWriter(ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.exit).toBe(0);
    expect(outcome.result.action).toBe('installed');
    expect(outcome.result.backup).toBeNull();
    expect(outcome.createdHooksKey).toBe(true);
    // absolute labels are emitted verbatim (Pass 3: no `a//` doubled slash)
    expect(outcome.result.diff).toContain(`+++ ${ctx.target.path}`);
    expect(outcome.result.diff).not.toContain('+++ b/');
    expect(backups).toEqual([]);
    const text = readFileSync(ctx.target.path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain(`"\\"${LAUNCHER}\\" hook claude-code Stop"`);
  });

  it('is idempotent: a second run is byte-identical, unchanged, and makes no backup', () => {
    const dir = tempDir();
    const first = makeCtx(dir);
    applyJsonWriter(first.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    const before = readFileSync(first.ctx.target.path, 'utf8');
    const second = makeCtx(dir, { createdHooksKey: true });
    const outcome = applyJsonWriter(second.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('unchanged');
    expect(outcome.result.diff).toBe('');
    expect(second.backups).toEqual([]);
    expect(readFileSync(first.ctx.target.path, 'utf8')).toBe(before);
  });

  it('preserves tab indentation, foreign keys and foreign hooks on merge', () => {
    const dir = tempDir();
    const { ctx, backups } = makeCtx(dir);
    const seed = '{\n\t"model": "opus",\n\t"hooks": {\n\t\t"Stop": [\n\t\t\t{\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",\n\t\t\t\t\t\t"command": "echo foreign"\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n\t\t]\n\t}\n}\n';
    writeFileSync(ctx.target.path, seed);
    const outcome = applyJsonWriter(ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('updated');
    expect(outcome.result.backup).toBe(backups[0]);
    expect(outcome.createdHooksKey).toBe(false); // the hooks key was theirs
    const text = readFileSync(ctx.target.path, 'utf8');
    expect(text).toContain('\t"model": "opus"');
    expect(text).toContain('"command": "echo foreign"');
    expect(text.split('echo foreign').length).toBe(2);
    expect(readFileSync(backups[0] as string, 'utf8')).toBe(seed);
  });

  it('drops a strict-only event array when strict is turned back off', () => {
    const dir = tempDir();
    const strictRun = makeCtx(dir);
    applyJsonWriter(strictRun.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, true) });
    expect(readFileSync(strictRun.ctx.target.path, 'utf8')).toContain('SessionStart');
    const plainRun = makeCtx(dir, { createdHooksKey: true });
    const outcome = applyJsonWriter(plainRun.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('updated');
    const text = readFileSync(plainRun.ctx.target.path, 'utf8');
    expect(text).not.toContain('SessionStart');
    expect(text).not.toContain('--strict');
  });

  it('never rewrites comment-bearing JSON (exit 3) or malformed JSON (exit 1)', () => {
    const dir = tempDir();
    const withComments = makeCtx(dir);
    const commented = '// managed by hand\n{\n  "hooks": {}\n}\n';
    writeFileSync(withComments.ctx.target.path, commented);
    const manual = applyJsonWriter(withComments.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(manual.exit).toBe(3);
    expect(manual.result.action).toBe('manual');
    expect(manual.snippet).toContain('showreceipts-hook');
    expect(readFileSync(withComments.ctx.target.path, 'utf8')).toBe(commented);

    const broken = makeCtx(dir, { target: { path: join(dir, 'broken.json'), scope: 'user', notes: [] } });
    writeFileSync(broken.ctx.target.path, '{"hooks": \n');
    const failed = applyJsonWriter(broken.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(failed.exit).toBe(1);
    expect(failed.error).toContain('not valid JSON');
    expect(readFileSync(broken.ctx.target.path, 'utf8')).toBe('{"hooks": \n');
  });
});

describe('applyJsonWriter — remove (§9)', () => {
  it('removes only marked entries and keeps a hooks key we did not create', () => {
    const dir = tempDir();
    const install = makeCtx(dir);
    const seed = serializeJson(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] } },
      { indent: '  ', trailingNewline: true },
    );
    writeFileSync(install.ctx.target.path, seed);
    applyJsonWriter(install.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });

    const remove = makeCtx(dir, { remove: true, createdHooksKey: false });
    const outcome = applyJsonWriter(remove.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('removed');
    expect(outcome.createdHooksKey).toBe(false);
    // Byte-for-byte back to the pre-install file: foreign entries intact.
    expect(readFileSync(remove.ctx.target.path, 'utf8')).toBe(seed);
  });

  it('drops empty event arrays and the hooks key only when created by us', () => {
    const dir = tempDir();
    const install = makeCtx(dir);
    applyJsonWriter(install.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    const remove = makeCtx(dir, { remove: true, createdHooksKey: true });
    const outcome = applyJsonWriter(remove.ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('removed');
    expect(readFileSync(remove.ctx.target.path, 'utf8')).toBe('{}\n');
  });

  it('reports unchanged when there is nothing of ours to remove', () => {
    const dir = tempDir();
    const { ctx } = makeCtx(dir, { remove: true });
    const outcome = applyJsonWriter(ctx, { shape: 'nested', desired: desiredClaudeCode(LAUNCHER, false) });
    expect(outcome.result.action).toBe('unchanged');
    expect(outcome.exit).toBe(0);
  });
});

describe('unifiedDiff', () => {
  it('produces standard headers and hunks, and empty output for equal texts', () => {
    expect(unifiedDiff('a\n', 'a\n', 'x')).toBe('');
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'cfg.json');
    expect(diff).toContain('--- a/cfg.json');
    expect(diff).toContain('+++ b/cfg.json');
    expect(diff).toContain('@@ -1,3 +1,3 @@');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
  });

  it('emits absolute labels verbatim (no a// doubled slash — Pass 3)', () => {
    const diff = unifiedDiff('a\n', 'b\n', '/private/tmp/fresh-home/.claude/settings.json');
    expect(diff).toContain('--- /private/tmp/fresh-home/.claude/settings.json');
    expect(diff).toContain('+++ /private/tmp/fresh-home/.claude/settings.json');
    expect(diff).not.toContain('a//');
  });
});
