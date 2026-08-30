import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendLine, atomicWriteFile, ensureDir, readJsonFile, realpathOrSelf, statOrNull } from '../../../src/util/fs.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = makeTempDir('showreceipts-fs-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => fs.statSync(path).mode & 0o777;

describe('atomicWriteFile', () => {
  it('creates a 0600 file by default and writes the exact bytes', () => {
    const dir = tempDir();
    const target = join(dir, 'receipt.json');
    atomicWriteFile(target, '{"a":1}\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(mode(target)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['receipt.json']);
  });

  it('renames a temp file from the same directory over the target', () => {
    const dir = tempDir();
    const target = join(dir, 'x.txt');
    const rename = vi.spyOn(fs, 'renameSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    atomicWriteFile(target, Buffer.from('bytes'), { mode: 0o644 });
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(to).toBe(target);
    expect(dirname(from)).toBe(dir);
    expect(from).not.toBe(target);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(from);
    expect(mode(target)).toBe(0o644);
    expect(fs.readFileSync(target, 'utf8')).toBe('bytes');
  });

  it('preserves the mode of an existing file when none is given, and overrides it when one is', () => {
    const dir = tempDir();
    const target = join(dir, 'settings.json');
    fs.writeFileSync(target, 'old');
    fs.chmodSync(target, 0o644);
    atomicWriteFile(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(mode(target)).toBe(0o644);
    atomicWriteFile(target, 'newer', { mode: 0o600 });
    expect(mode(target)).toBe(0o600);
    expect(fs.readFileSync(target, 'utf8')).toBe('newer');
  });

  it('leaves no temp file behind when the write fails, and rethrows', () => {
    const dir = tempDir();
    const target = join(dir, 'x');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => atomicWriteFile(target, 'data')).toThrow('disk full');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes the temp file when the rename fails', () => {
    const dir = tempDir();
    const target = join(dir, 'x');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV');
    });
    expect(() => atomicWriteFile(target, 'data')).toThrow('EXDEV');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('fails when the directory does not exist (no implicit mkdir)', () => {
    const dir = tempDir();
    expect(() => atomicWriteFile(join(dir, 'missing', 'x'), 'data')).toThrow();
  });
});

describe('ensureDir', () => {
  it('creates nested private directories and is idempotent', () => {
    const dir = tempDir();
    const target = join(dir, 'a', 'b', 'c');
    ensureDir(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(mode(target)).toBe(0o700);
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    ensureDir(target);
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('applies a custom mode', () => {
    const dir = tempDir();
    const target = join(dir, 'pub');
    ensureDir(target, 0o755);
    expect(mode(target)).toBe(0o755);
  });

  it('throws when the path exists as a file', () => {
    const dir = tempDir();
    const file = join(dir, 'f');
    fs.writeFileSync(file, '');
    expect(() => ensureDir(file)).toThrow();
  });
});

describe('appendLine', () => {
  it('issues exactly one appendFileSync with flag a and mode 0600', () => {
    const dir = tempDir();
    const ledger = join(dir, 'ledger.jsonl');
    const append = vi.spyOn(fs, 'appendFileSync');
    const rename = vi.spyOn(fs, 'renameSync');
    const line = Buffer.from('{"v":1}\n');
    appendLine(ledger, line);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(ledger, line, { flag: 'a', mode: 0o600 });
    expect(rename).not.toHaveBeenCalled();
    appendLine(ledger, '{"v":2}\n');
    expect(append).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(ledger, 'utf8')).toBe('{"v":1}\n{"v":2}\n');
    expect(mode(ledger)).toBe(0o600);
  });
});

describe('readJsonFile', () => {
  it('parses JSON and returns undefined for missing or malformed files', () => {
    const dir = tempDir();
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    fs.writeFileSync(good, '{"counters":{"invocations":3}}');
    fs.writeFileSync(bad, '{"counters":');
    expect(readJsonFile(good)).toEqual({ counters: { invocations: 3 } });
    expect(readJsonFile(bad)).toBeUndefined();
    expect(readJsonFile(join(dir, 'missing.json'))).toBeUndefined();
    expect(readJsonFile(dir)).toBeUndefined();
  });
});

describe('statOrNull / realpathOrSelf', () => {
  it('returns stats or null, and the real path or the input', () => {
    const dir = tempDir();
    const file = join(dir, 'f');
    fs.writeFileSync(file, 'x');
    expect(statOrNull(file)?.isFile()).toBe(true);
    expect(statOrNull(join(dir, 'nope'))).toBeNull();
    const link = join(dir, 'link');
    fs.symlinkSync(file, link);
    expect(realpathOrSelf(link)).toBe(file);
    expect(realpathOrSelf(join(dir, 'nope'))).toBe(join(dir, 'nope'));
  });
});
