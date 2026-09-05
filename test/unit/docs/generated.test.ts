/**
 * S33 — the documentation set stays generated and private:
 * `gen-docs --check` is a fixed point, no published doc carries a forbidden
 * token / real home path / e-mail (the forbidden-hash scan reused from the
 * S03 redaction test), every sample the README references exists, the
 * receipt-schema blocks parse, every relative link resolves, and the README
 * opens with the demo SVG without ever calling it real.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSchemaDoc } from '../../helpers/schema.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every published doc this step must keep clean (repo-relative). */
function docFiles(): string[] {
  const top = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'INSTALL_FOR_AGENTS.md', 'demo.tape'];
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`)
    .sort();
  return [...top, ...docs];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * The forbidden-hash scan, reused from `test/unit/fixtures/redaction.test.ts`
 * (S03): every alphanumeric run of the text — and every chain of up to five
 * runs whose neighbours sit one separator apart — is canonicalised
 * (lower-case, separators removed) and hashed against
 * `fixtures/redaction/forbidden.sha256.json`. A real session id, user name,
 * home path or e-mail therefore hits in any separator spelling.
 */
const MAX_TOKEN_RUNS = 5;

function canonicalMatches(text: string, hashes: ReadonlySet<string>): string[] {
  const lower = text.toLowerCase();
  const runs: { s: string; start: number; end: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) runs.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  const hits = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    let joined = runs[i]?.s ?? '';
    let end = runs[i]?.end ?? 0;
    for (let k = i; ; k++) {
      if (joined.length >= 3 && hashes.has(sha256(joined))) hits.add(lower.slice(runs[i]?.start ?? 0, end));
      const next = runs[k + 1];
      if (k + 1 - i >= MAX_TOKEN_RUNS || next === undefined || next.start - end !== 1) break;
      joined += next.s;
      end = next.end;
    }
  }
  return [...hits];
}

/** `/Users/<anyone>` and `/home/<anyone but the fixture placeholder u>`. */
function realHomePaths(text: string): string[] {
  const hits: string[] = [];
  for (const hit of text.matchAll(/\/Users\/[^\s"'\\/]+/g)) hits.push(hit[0]);
  for (const hit of text.matchAll(/\/home\/(?!u(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g)) hits.push(hit[0]);
  return hits;
}

/** E-mail-shaped tokens, minus the documented placeholders. */
function emailTokens(text: string): string[] {
  const hits: string[] = [];
  for (const t of text.split(/[\s"'`<>()[\],;{}]+/)) {
    if (!t.includes('@')) continue;
    if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}$/.test(t) && t !== 'u@example.com' && !t.startsWith('git@github.com')) hits.push(t);
  }
  return hits;
}

let forbidden: Set<string>;

beforeAll(() => {
  const list = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'redaction', 'forbidden.sha256.json'), 'utf8')) as { hashes: string[] };
  forbidden = new Set(list.hashes);
  // The one deliberate exception: the public repo owner handle — the GitHub
  // account of `package.json.repository`/`homepage`, published with every
  // release, so the README and docs may name it. Derived from package.json
  // rather than written literally (the S03 scan covers test/ sources too).
  // The author's local username, full name and e-mail all stay forbidden.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository?: { url?: string } };
  const owner = /github\.com[/:]([^/]+)\//.exec(pkg.repository?.url ?? '')?.[1] ?? '';
  expect(owner).not.toBe('');
  forbidden.delete(sha256(owner.toLowerCase().replace(/[^a-z0-9]+/g, '')));
});

describe('generated regions', () => {
  it('node scripts/gen-docs.mjs --check passes (regions, catalogue and SVG are fresh)', () => {
    expect(existsSync(join(ROOT, 'dist', 'cli.js')), 'run `npm run build` first — gen-docs needs dist/').toBe(true);
    const result = execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-docs.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result).toContain('up to date');
  }, 180_000);
});

describe('privacy of the published docs', () => {
  it.each(docFiles())('%s carries no forbidden token, real home path or e-mail', (rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    // decisions.md is the lead's internal engineering log (S33 never edits
    // it) and legitimately uses common code words that collide with
    // forbidden-list entries; it still must pass the path and e-mail scans.
    if (rel !== 'docs/decisions.md') expect(canonicalMatches(text, forbidden), rel).toEqual([]);
    expect(realHomePaths(text), rel).toEqual([]);
    expect(emailTokens(text), rel).toEqual([]);
  });
});

describe('README', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('opens with the demo SVG and never calls the demo receipt real', () => {
    expect(readme).toContain('](docs/receipt.svg)');
    const svg = join(ROOT, 'docs', 'receipt.svg');
    expect(existsSync(svg)).toBe(true);
    expect(readFileSync(svg, 'utf8').startsWith('<svg')).toBe(true);
    // The image is labelled as the demo scenario, explicitly not a real session.
    expect(readme).toContain('demo scenario');
    expect(readme).toContain('not a real session');
  });

  it('references only samples that exist in docs/samples/', () => {
    const referenced = [...readme.matchAll(/docs\/samples\/([A-Za-z0-9._-]+\.txt)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(existsSync(join(ROOT, 'docs', 'samples', name ?? '')), String(name)).toBe(true);
    }
  });

  it('embeds the contradicted demo sample verbatim', () => {
    const sample = readFileSync(join(ROOT, 'docs', 'samples', 'contradicted.txt'), 'utf8');
    expect(readme).toContain(sample);
  });

  it('prose that quotes the demo cost line matches the frozen sample', () => {
    // W6 close (S33 review nit): "What the cost line means" quotes the demo
    // receipt's cost line in inline code outside any gen region. gen-docs
    // regenerates the sample if the demo scenario ever changes, and this
    // pins every such quote to the sample's bytes so the prose cannot
    // silently drift from the numbers the README shows above it.
    const quotes = [...readme.matchAll(/`(cost \$[^`\n]+)`/g)].map((m) => m[1] ?? '');
    expect(quotes.length).toBeGreaterThan(0);
    const sample = readFileSync(join(ROOT, 'docs', 'samples', 'contradicted.txt'), 'utf8');
    for (const quote of quotes) expect(sample, `README quote not in sample: ${quote}`).toContain(quote);
  });
});

describe('docs integrity', () => {
  it('docs/receipt-schema.md schema blocks parse', () => {
    expect(() => loadSchemaDoc()).not.toThrow();
  });

  it('every relative link in README and docs resolves', () => {
    for (const rel of docFiles()) {
      if (rel === 'demo.tape') continue;
      const path = join(ROOT, rel);
      // Strip fenced blocks, <code> cells and inline code before extracting
      // links: generated regex tables may contain `](` sequences.
      const text = readFileSync(path, 'utf8')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<code>[\s\S]*?<\/code>/g, '')
        .replace(/`[^`\n]*`/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] ?? '';
        if (/^(?:https?:|mailto:|#)/.test(target)) continue;
        const clean = target.replace(/#.*$/, '');
        if (clean === '') continue;
        const resolved = resolve(dirname(path), clean);
        // S34's page: the check skips it only while that step is unmerged.
        if (clean.endsWith('docs/release.md') && !existsSync(resolved)) continue;
        expect(existsSync(resolved), `${rel} → ${target}`).toBe(true);
      }
    }
  });
});
