import { describe, expect, it } from 'vitest';
import { sha1, sha256, shortHash } from '../../../src/util/hash.js';

describe('sha256', () => {
  it('hashes strings as UTF-8 and Buffers byte-for-byte', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(Buffer.from('abc'))).toBe(sha256('abc'));
    expect(sha256('é')).toBe(sha256(Buffer.from([0xc3, 0xa9])));
  });

  it('is 64 lowercase hex characters', () => {
    expect(sha256('showreceipts')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha1', () => {
  it('matches the reference digest', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1(Buffer.from('abc'))).toBe(sha1('abc'));
    expect(sha1('x')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('shortHash', () => {
  it('returns the first n hex characters of sha256', () => {
    expect(shortHash('abc', 8)).toBe('ba7816bf');
    expect(shortHash(Buffer.from('abc'), 12)).toBe('ba7816bf8f01');
  });

  it('clamps n to 1…64 and floors fractions', () => {
    expect(shortHash('abc', 0)).toBe('b');
    expect(shortHash('abc', -5)).toBe('b');
    expect(shortHash('abc', 200)).toBe(sha256('abc'));
    expect(shortHash('abc', 3.9)).toBe('ba7');
  });
});
