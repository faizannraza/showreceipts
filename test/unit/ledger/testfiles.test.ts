import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDoc, isFixtureFile, isTestFile } from '../../../src/ledger/testfiles.js';

describe('module boundary', () => {
  it('imports nothing (no node:fs, node:os, process.env)', () => {
    const source = readFileSync(new URL('../../../src/ledger/testfiles.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]/);
    expect(source).not.toContain('process.env');
  });
});

describe('isTestFile (§4.6.3)', () => {
  it.each([
    'tests/test_api.py',
    'src/specs/render.js',
    'pkg/__tests__/util.ts',
    'src/__snapshots__/render.snap',
    'e2e/login.ts',
    'app/integration/db.rb',
    'src/render.test.ts',
    'src/render.spec.tsx',
    'test_models.py',
    'store_test.go',
    'ParserTests.swift',
    'AccountTest.java',
    'billing_spec.rb',
    'conftest.py',
    'render.golden.json',
    'deep/nested/widget-spec.js',
  ])('positive: %s', (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it.each([
    'latest/x.ts', // `latest/` is not `tests/` — the anchor removes it
    'contest.py', // not `^test_`
    'src/testing-utils.ts', // `testing-` is not a test dir or basename
    'src/protester.go',
    'attest.rs',
    'manifest.json',
  ])('negative: %s', (p) => {
    expect(isTestFile(p)).toBe(false);
  });
});

describe('isDoc (§4.6.1)', () => {
  it.each(['README.md', 'guide.mdx', 'notes.rst', 'todo.txt', 'book.adoc', 'LICENSE', 'LICENSE-MIT', 'CHANGELOG.md', 'NOTICE', 'docs/api/ref.html', 'config.example', 'settings.sample'])(
    'positive: %s',
    (p) => {
      expect(isDoc(p)).toBe(true);
    },
  );

  it.each(['src/main.ts', 'docs.ts', 'mydocs/x.md.ts', 'license_checker.py'])('negative: %s', (p) => {
    expect(isDoc(p)).toBe(false);
  });
});

describe('isFixtureFile (§4.6.7)', () => {
  it.each(['fixtures/claims/corpus.jsonl', 'test/fixtures/a.json', '__snapshots__/render.snap', 'goldens/receipt.golden', 'a/b/out.golden.txt', 'x.snap'])(
    'positive: %s',
    (p) => {
      expect(isFixtureFile(p)).toBe(true);
    },
  );

  it.each(['src/fixture.ts', 'fixture/one.json', 'snapshots/a.txt', 'golden.py'])('negative: %s', (p) => {
    expect(isFixtureFile(p)).toBe(false);
  });
});
