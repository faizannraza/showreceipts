/**
 * Enforces the §0.5 module dependency direction and the import prohibitions
 * over `src/**\/*.ts` (so it runs before `dist/` exists):
 *
 *   util ← model ← readers ← ledger ← claims / cost ← reconcile ← pipeline ← render ← commands ← cli
 *
 * `discover/*`, `cache/*`, `demo/*` sit beside `readers` (util/model only;
 * demo may import readers). `hook/*`, `setup/*` import pipeline, readers,
 * discover, cache, util, model, `render/term.ts`, `render/md.ts` — never
 * `render/html*`. `child_process` only in `commands/report.ts`; network
 * modules nowhere; `node:fs`/`node:os` never inside ledger, claims,
 * reconcile, `cost/cost.ts`, or readers except the files that open transcripts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

type Layer =
  | 'util'
  | 'model'
  | 'readers'
  | 'discover'
  | 'cache'
  | 'demo'
  | 'ledger'
  | 'claims'
  | 'cost'
  | 'reconcile'
  | 'pipeline'
  | 'render'
  | 'hook'
  | 'setup'
  | 'commands'
  | 'cli';

const RANK: Readonly<Record<Layer, number>> = {
  util: 0,
  model: 1,
  readers: 2,
  discover: 2,
  cache: 2,
  demo: 2,
  ledger: 3,
  claims: 4,
  cost: 4,
  reconcile: 5,
  pipeline: 6,
  render: 7,
  hook: 7,
  setup: 7,
  commands: 8,
  cli: 9,
};

const NETWORK = new Set(['http', 'https', 'http2', 'net', 'tls', 'dns', 'dgram']);
const FS_OS = new Set(['fs', 'fs/promises', 'os']);

/** Files under readers/ that may open transcript files. */
const READERS_FS_ALLOWED = [/^readers\/jsonl\.ts$/, /^readers\/[^/]+\/reader\.ts$/, /^readers\/claude-code\/subagents\.ts$/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(`${full}/`));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Project-relative POSIX path (`commands/report.ts`). */
function rel(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

function layerOf(relPath: string): Layer {
  const top = relPath.includes('/') ? (relPath.split('/')[0] as string) : relPath.replace(/\.ts$/, '');
  if (top === 'cli' || relPath === 'cli.ts') return 'cli';
  if (relPath === 'version.ts') return 'util';
  if (top in RANK) return top as Layer;
  throw new Error(`deps-direction: unclassified module ${relPath} — add its directory to the layer table`);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

interface Specifier {
  spec: string;
  /** Every occurrence is `import type` / `export type` (erased at compile time). */
  typeOnly: boolean;
}

/** Every import/export/dynamic-import/require specifier in a source file. */
function specifiers(source: string): Specifier[] {
  const code = stripComments(source);
  const out = new Map<string, boolean>();
  const add = (spec: string, typeOnly: boolean): void => {
    out.set(spec, (out.get(spec) ?? true) && typeOnly);
  };
  for (const m of code.matchAll(/\b(import|export)\b(\s+type\b)?([^'"]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    add(m[4] as string, m[2] !== undefined);
  }
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(m[1] as string, false);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1] as string, false);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1] as string, false);
  return [...out].map(([spec, typeOnly]) => ({ spec, typeOnly }));
}

/**
 * The one sanctioned upward edge: `commands/*` take a `CommandContext`, whose
 * type lives in `cli/context.ts` (S01's contract). Type-only, so nothing of
 * `cli` is loaded at runtime by a command module.
 */
const TYPE_ONLY_EXCEPTIONS: readonly { from: RegExp; to: RegExp }[] = [{ from: /^commands\/[^/]+\.ts$/, to: /^cli\/(context|args)\.ts$/ }];

function builtinName(spec: string): string | null {
  if (spec.startsWith('node:')) return spec.slice(5);
  const bare = spec.split('/')[0] as string;
  const builtins = new Set([...NETWORK, ...FS_OS, 'child_process', 'path', 'crypto', 'util', 'url', 'stream', 'events', 'buffer', 'zlib', 'readline', 'process', 'tty', 'assert', 'module', 'worker_threads', 'perf_hooks', 'timers', 'string_decoder', 'querystring', 'v8', 'vm']);
  return builtins.has(bare) ? spec : null;
}

interface Violation {
  file: string;
  spec: string;
  why: string;
}

function checkInternal(fromRel: string, spec: string, violations: Violation[], typeOnly = false): void {
  const fromLayer = layerOf(fromRel);
  const targetRel = posix.normalize(posix.join(posix.dirname(fromRel), spec)).replace(/\.js$/, '.ts');
  let toLayer: Layer;
  try {
    toLayer = layerOf(targetRel);
  } catch {
    violations.push({ file: fromRel, spec, why: 'imports an unclassified module' });
    return;
  }
  const fail = (why: string): void => {
    violations.push({ file: fromRel, spec, why });
  };
  if (fromLayer === toLayer) return;
  if (typeOnly && TYPE_ONLY_EXCEPTIONS.some((x) => x.from.test(fromRel) && x.to.test(targetRel))) return;
  switch (fromLayer) {
    case 'discover':
    case 'cache':
      if (!['util', 'model'].includes(toLayer)) fail(`${fromLayer} may import only util/model`);
      return;
    case 'demo':
      if (!['util', 'model', 'readers'].includes(toLayer)) fail('demo may import only util/model/readers');
      return;
    case 'hook':
    case 'setup': {
      if (['util', 'model', 'readers', 'discover', 'cache', 'pipeline'].includes(toLayer)) return;
      if (toLayer === 'render' && /^render\/(term|md)\.ts$/.test(targetRel)) return;
      fail(`${fromLayer} may import util/model/readers/discover/cache/pipeline and render/{term,md}.ts only`);
      return;
    }
    default:
      if (RANK[toLayer] >= RANK[fromLayer]) fail(`${fromLayer} (rank ${RANK[fromLayer]}) must not import ${toLayer} (rank ${RANK[toLayer]})`);
  }
}

function checkBuiltin(fromRel: string, spec: string, name: string, violations: Violation[]): void {
  const fail = (why: string): void => {
    violations.push({ file: fromRel, spec, why });
  };
  const bare = name.split('/')[0] as string;
  if (NETWORK.has(bare)) fail('network modules are never imported (§13.4)');
  if (bare === 'child_process' && fromRel !== 'commands/report.ts') fail('child_process is allowed only in commands/report.ts');
  if (FS_OS.has(name) || bare === 'fs' || bare === 'os') {
    const restricted =
      fromRel.startsWith('ledger/') ||
      fromRel.startsWith('claims/') ||
      fromRel.startsWith('reconcile/') ||
      fromRel === 'cost/cost.ts' ||
      (fromRel.startsWith('readers/') && !READERS_FS_ALLOWED.some((re) => re.test(fromRel)));
    if (restricted) fail('node:fs/node:os must be injected here, never imported (§0.5)');
  }
}

describe('module dependency direction (§0.5)', () => {
  const files = walk(SRC);

  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => rel(f) === 'cli.ts')).toBe(true);
  });

  it('every import respects the layer order and the prohibitions', () => {
    const violations: Violation[] = [];
    for (const file of files) {
      const fromRel = rel(file);
      for (const { spec, typeOnly } of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          checkInternal(fromRel, spec, violations, typeOnly);
        } else {
          const builtin = builtinName(spec);
          if (builtin === null) {
            violations.push({ file: fromRel, spec, why: 'non-builtin package import (zero runtime dependencies)' });
          } else {
            checkBuiltin(fromRel, spec, builtin, violations);
          }
        }
      }
    }
    expect(violations.map((v) => `${v.file} → ${v.spec}: ${v.why}`)).toEqual([]);
  });

  it('classifies the layers it knows about and rejects unknown directories', () => {
    expect(layerOf('cli.ts')).toBe('cli');
    expect(layerOf('cli/args.ts')).toBe('cli');
    expect(layerOf('version.ts')).toBe('util');
    expect(layerOf('util/hash.ts')).toBe('util');
    expect(layerOf('model/types.ts')).toBe('model');
    expect(layerOf('readers/claude-code/reader.ts')).toBe('readers');
    expect(() => layerOf('mystery/x.ts')).toThrow(/unclassified/);
  });

  it('extracts static, type, side-effect, dynamic and require specifiers, ignoring comments', () => {
    const source = [
      "import fs from 'node:fs';",
      "import type { A } from './a.js';",
      "import './side.js';",
      "export { b } from '../b.js';",
      "export * from './c.js';",
      "const m = () => import('./d.js');",
      "const r = require('node:os');",
      "// import x from 'node:net';",
      "/* import y from 'node:http'; */",
      "const url = 'https://example.test';",
      "import { z, type Z } from './z.js';",
      "export type { W } from './w.js';",
      "import type { A2 } from './a.js';",
    ].join('\n');
    const found = specifiers(source).sort((x, y) => x.spec.localeCompare(y.spec));
    expect(found).toEqual([
      { spec: '../b.js', typeOnly: false },
      { spec: './a.js', typeOnly: true },
      { spec: './c.js', typeOnly: false },
      { spec: './d.js', typeOnly: false },
      { spec: './side.js', typeOnly: false },
      { spec: './w.js', typeOnly: true },
      { spec: './z.js', typeOnly: false },
      { spec: 'node:fs', typeOnly: false },
      { spec: 'node:os', typeOnly: false },
    ]);
    expect(specifiers("import type { A } from './a.js';\nimport { a } from './a.js';")).toEqual([{ spec: './a.js', typeOnly: false }]);
  });

  it('allows commands → cli/context.ts only as a type-only import', () => {
    const v: Violation[] = [];
    checkInternal('commands/audit.ts', '../cli/context.js', v, true);
    checkInternal('commands/audit.ts', '../cli/args.js', v, true);
    expect(v).toEqual([]);
    checkInternal('commands/audit.ts', '../cli/context.js', v, false);
    checkInternal('commands/audit.ts', '../cli/help.js', v, true);
    checkInternal('render/term.ts', '../cli/context.js', v, true);
    expect(v.map((x) => `${x.file} → ${x.spec}`)).toEqual([
      'commands/audit.ts → ../cli/context.js',
      'commands/audit.ts → ../cli/help.js',
      'render/term.ts → ../cli/context.js',
    ]);
  });

  it('flags the prohibited edges when asked directly', () => {
    const v: Violation[] = [];
    checkInternal('ledger/writes.ts', '../claims/rules.js', v);
    checkInternal('claims/rules.ts', '../cost/cost.js', v);
    checkInternal('render/term.ts', '../commands/audit.js', v);
    checkInternal('hook/runtime.ts', '../render/html.js', v);
    checkInternal('hook/runtime.ts', '../render/term.js', v);
    checkInternal('setup/index.ts', '../render/md.js', v);
    checkInternal('discover/roots.ts', '../readers/jsonl.js', v);
    checkInternal('demo/gen.ts', '../readers/claude-code/records.js', v);
    checkInternal('demo/gen.ts', '../ledger/index.js', v);
    checkInternal('cache/cache.ts', '../model/types.js', v);
    checkInternal('cache/cache.ts', '../pipeline/index.js', v);
    checkInternal('pipeline/index.ts', '../nowhere/x.js', v);
    checkInternal('util/paths.ts', '../model/types.js', v);
    checkInternal('commands/audit.ts', '../hook/index.js', v);
    checkBuiltin('ledger/writes.ts', 'node:fs', 'fs', v);
    checkBuiltin('readers/claude-code/records.ts', 'node:os', 'os', v);
    checkBuiltin('readers/claude-code/reader.ts', 'node:fs', 'fs', v);
    checkBuiltin('readers/jsonl.ts', 'fs/promises', 'fs/promises', v);
    checkBuiltin('readers/claude-code/subagents.ts', 'node:fs', 'fs', v);
    checkBuiltin('cost/cost.ts', 'node:fs', 'fs', v);
    checkBuiltin('cost/resolve.ts', 'node:fs', 'fs', v);
    checkBuiltin('commands/report.ts', 'node:child_process', 'child_process', v);
    checkBuiltin('hook/runtime.ts', 'node:child_process', 'child_process', v);
    checkBuiltin('util/fs.ts', 'node:https', 'https', v);
    checkBuiltin('commands/report.ts', 'node:net', 'net', v);
    expect(v.map((x) => `${x.file} → ${x.spec}`)).toEqual([
      'ledger/writes.ts → ../claims/rules.js',
      'claims/rules.ts → ../cost/cost.js',
      'render/term.ts → ../commands/audit.js',
      'hook/runtime.ts → ../render/html.js',
      'discover/roots.ts → ../readers/jsonl.js',
      'demo/gen.ts → ../ledger/index.js',
      'cache/cache.ts → ../pipeline/index.js',
      'pipeline/index.ts → ../nowhere/x.js',
      'util/paths.ts → ../model/types.js',
      'ledger/writes.ts → node:fs',
      'readers/claude-code/records.ts → node:os',
      'cost/cost.ts → node:fs',
      'hook/runtime.ts → node:child_process',
      'util/fs.ts → node:https',
      'commands/report.ts → node:net',
    ]);
  });
});
