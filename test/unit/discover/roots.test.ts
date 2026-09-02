import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRoots, rootRealpath } from '../../../src/discover/roots.js';
import { withTempDir } from '../../helpers/tmp.js';

describe('resolveRoots', () => {
  it('defaults every root under the injected home when the env is empty', () => {
    const roots = resolveRoots({}, '/nowhere/home');
    expect(roots.userHome).toBe('/nowhere/home');
    expect(roots.claudeConfigDir).toBe(join('/nowhere/home', '.claude'));
    expect(roots.codexHome).toBe(join('/nowhere/home', '.codex'));
    expect(roots.showreceiptsHome).toBe(join('/nowhere/home', '.showreceipts'));
  });

  it('lets the env override each root and ignores empty or whitespace-only values', () => {
    const roots = resolveRoots(
      { CLAUDE_CONFIG_DIR: '/opt/claude', CODEX_HOME: '  ', SHOWRECEIPTS_HOME: '' },
      '/nowhere/home',
    );
    expect(roots.claudeConfigDir).toBe('/opt/claude');
    expect(roots.codexHome).toBe(join('/nowhere/home', '.codex'));
    expect(roots.showreceiptsHome).toBe(join('/nowhere/home', '.showreceipts'));
  });

  it('marks absent roots with a null realpath and never throws', () => {
    const roots = resolveRoots({}, '/definitely/not/a/home');
    expect(roots.realpaths['userHome']).toBeNull();
    expect(roots.realpaths['claudeConfigDir']).toBeNull();
    expect(roots.realpaths['codexHome']).toBeNull();
    expect(roots.realpaths['showreceiptsHome']).toBeNull();
    expect(rootRealpath(roots, 'claudeConfigDir')).toBeNull();
  });

  it('realpath-resolves existing roots exactly once, following a symlinked root', async () => {
    await withTempDir((dir) => {
      const real = join(dir, 'real-claude');
      const link = join(dir, 'link-claude');
      mkdirSync(real);
      symlinkSync(real, link);
      const roots = resolveRoots({ CLAUDE_CONFIG_DIR: link }, dir);
      expect(roots.claudeConfigDir).toBe(link);
      expect(roots.realpaths['claudeConfigDir']).toBe(realpathSync(real));
      expect(rootRealpath(roots, 'claudeConfigDir')).toBe(realpathSync(real));
      expect(roots.realpaths['userHome']).toBe(realpathSync(dir));
    });
  });

  it('keys realpaths by the same names as the root fields', () => {
    const roots = resolveRoots({}, '/nowhere/home');
    expect(Object.keys(roots.realpaths).sort()).toEqual(['claudeConfigDir', 'codexHome', 'showreceiptsHome', 'userHome']);
  });
});

describe('discover/cache source hygiene (review checklist)', () => {
  const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
  const FILES = [
    ...readdirSync(join(SRC, 'discover')).map((name) => join(SRC, 'discover', name)),
    join(SRC, 'cache', 'cache.ts'),
  ].filter((p) => p.endsWith('.ts'));

  /** True for a line that is only a comment (JSDoc prose may mention the forbidden names). */
  function isCommentLine(line: string): boolean {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  }

  it('never reads process.env, the wall clock, randomness or locale data', () => {
    const forbidden = [/\bprocess\.env\b/, /\bDate\.now\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bMath\.random\b/, /\bIntl\./];
    const problems: string[] = [];
    for (const file of FILES) {
      const relPath = file.slice(SRC.length).split(sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (isCommentLine(line)) return;
          for (const re of forbidden) {
            if (re.test(line)) problems.push(`${relPath}:${index + 1}: ${re.source}`);
          }
        });
    }
    expect(problems).toEqual([]);
    expect(FILES.length).toBeGreaterThanOrEqual(3);
  });
});
