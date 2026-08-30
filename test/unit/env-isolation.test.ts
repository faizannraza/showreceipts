/**
 * Determinism guard (PLAN §0.2): the readers, ledger, claims, reconcile and
 * cost modules never read the environment, the wall clock, randomness or
 * locale data. Missing directories pass vacuously (they land in later waves).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

const RESTRICTED: readonly string[] = ['ledger/', 'readers/', 'claims/', 'reconcile/', 'cost/cost.ts'];

const FORBIDDEN: readonly { name: string; re: RegExp }[] = [
  { name: 'process.env', re: /\bprocess\.env\b/ },
  { name: 'Date.now(', re: /\bDate\.now\s*\(/ },
  { name: 'new Date()', re: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'Math.random', re: /\bMath\.random\b/ },
  { name: 'Intl.', re: /\bIntl\./ },
];

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith('.ts') ? [path] : [];
  const out: string[] = [];
  for (const name of readdirSync(path)) out.push(...walk(`${path.replace(/\/?$/, '/')}${name}`));
  return out;
}

/** True for a line that is only a comment (JSDoc prose may legitimately mention the forbidden names). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

export function scanForbidden(source: string): { line: number; name: string }[] {
  const hits: { line: number; name: string }[] = [];
  source.split('\n').forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const { name, re } of FORBIDDEN) {
      if (re.test(line)) hits.push({ line: index + 1, name });
    }
  });
  return hits;
}

describe('environment isolation of the deterministic core', () => {
  it('finds no process.env, Date.now(), new Date(), Math.random or Intl. in the restricted modules', () => {
    const problems: string[] = [];
    for (const target of RESTRICTED) {
      for (const file of walk(`${SRC}${target}`)) {
        const relPath = relative(SRC, file).split(sep).join('/');
        for (const hit of scanForbidden(readFileSync(file, 'utf8'))) problems.push(`${relPath}:${hit.line}: ${hit.name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('detects every forbidden pattern and ignores comment lines', () => {
    const sample = [
      "const a = process.env['HOME'];",
      'const b = Date.now();',
      'const c = new Date();',
      'const d = new Date(ms);',
      'const e = Math.random();',
      "const f = new Intl.DateTimeFormat('en');",
      '// Date.now() is forbidden here',
      ' * process.env is read by the context only',
      '/* Math.random */',
    ].join('\n');
    expect(scanForbidden(sample)).toEqual([
      { line: 1, name: 'process.env' },
      { line: 2, name: 'Date.now(' },
      { line: 3, name: 'new Date()' },
      { line: 5, name: 'Math.random' },
      { line: 6, name: 'Intl.' },
    ]);
  });

  it('walks files and directories and skips what does not exist', () => {
    expect(walk(`${SRC}does-not-exist/`)).toEqual([]);
    expect(walk(`${SRC}cli.ts`)).toEqual([`${SRC}cli.ts`]);
    expect(walk(`${SRC}util`).length).toBeGreaterThan(5);
  });
});
