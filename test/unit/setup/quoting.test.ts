/**
 * Closing-review regression (Pass 1): `hookCommand` interpolated the
 * launcher path into double quotes without escaping, so a HOME containing a
 * `"` (or `$`, backtick, backslash) produced a broken hook command in every
 * harness config. It now routes through the launcher's `shQuote`; the win32
 * `.cmd` script doubles embedded quotes the cmd way.
 */
import { describe, expect, it } from 'vitest';
import { launcherScriptCmd, launcherScriptSh } from '../../../src/setup/launcher.js';
import { hookCommand } from '../../../src/setup/plan.js';

describe('hookCommand quoting', () => {
  it('an ordinary path keeps the exact previous shape', () => {
    expect(hookCommand('/Users/u/.showreceipts/bin/showreceipts-hook', 'claude-code', 'Stop')).toBe(
      '"/Users/u/.showreceipts/bin/showreceipts-hook" hook claude-code Stop',
    );
  });

  it('a path with spaces stays one shell word', () => {
    expect(hookCommand('/Users/a b/bin/hook', 'codex', 'Stop', true)).toBe('"/Users/a b/bin/hook" hook codex Stop --strict');
  });

  it('embedded double quotes, dollars and backticks are escaped', () => {
    const cmd = hookCommand('/Users/we"ird/$x/`y/bin/hook', 'claude-code', 'Stop');
    expect(cmd).toBe('"/Users/we\\"ird/\\$x/\\`y/bin/hook" hook claude-code Stop');
  });
});

describe('launcher script quoting', () => {
  it('the POSIX script escapes the node and cli paths', () => {
    const sh = launcherScriptSh('/opt/we"ird/node', '/opt/we"ird/node', '/opt/we"ird/cli.js');
    expect(sh).toContain('"/opt/we\\"ird/node"');
    expect(sh).toContain('"/opt/we\\"ird/cli.js"');
  });

  it('the .cmd script doubles embedded quotes', () => {
    const cmd = launcherScriptCmd('C:\\we"ird\\node.exe', 'C:\\we"ird\\cli.js');
    expect(cmd).toContain('"C:\\we""ird\\node.exe"');
    expect(cmd).toContain('"C:\\we""ird\\cli.js"');
    expect(cmd).not.toContain('"C:\\we"ird');
  });
});
