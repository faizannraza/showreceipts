import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/util/hash.js';
import { safeSid, shortId, uuidVersion } from '../../../src/util/ids.js';

// Synthetic vectors only: real session ids must never be committed (see test/unit/fixtures/redaction.test.ts).
const V4 = '12345678-1234-4abc-8def-123456789abc';
const V7 = '01900000-1111-7222-8333-444455556666';

describe('uuidVersion', () => {
  it('recognises v4 and v7, case-insensitively', () => {
    expect(uuidVersion(V4)).toBe(4);
    expect(uuidVersion(V7)).toBe(7);
    expect(uuidVersion(V4.toUpperCase())).toBe(4);
  });

  it('returns null for other versions, bad variants and non-UUIDs', () => {
    expect(uuidVersion('12345678-1234-1abc-8def-123456789abc')).toBeNull(); // v1
    expect(uuidVersion('12345678-1234-5abc-8def-123456789abc')).toBeNull(); // v5
    expect(uuidVersion('12345678-1234-4abc-cdef-123456789abc')).toBeNull(); // variant nibble c
    expect(uuidVersion('123456781234-4abc-8def-123456789abc')).toBeNull(); // missing dash
    expect(uuidVersion('1234567812344abc8def123456789abc')).toBeNull(); // no dashes
    expect(uuidVersion('')).toBeNull();
    expect(uuidVersion('rollout-2026-03-01')).toBeNull();
    expect(uuidVersion('zzzzzzzz-1234-4abc-8def-123456789abc')).toBeNull();
  });
});

describe('shortId', () => {
  it('uses the first 8 hex of a UUIDv4', () => {
    expect(shortId('claude-code', V4)).toBe('12345678');
    expect(shortId('claude-code', V4.toUpperCase())).toBe('12345678');
  });

  it('uses the last 8 hex of a UUIDv7 (the dash-stripped tail)', () => {
    expect(shortId('codex', V7)).toBe('55556666');
    expect(shortId('codex', V7)).toBe(V7.replace(/-/g, '').slice(-8));
  });

  it('distinguishes two UUIDv7 ids minted 30 s apart, whose first 8 hex collide', () => {
    // 0x019000001111 ms and 30 000 ms later (0x7530) — the 48-bit timestamp prefix differs only in the low hex digits.
    const a = '01900000-1111-7222-8333-444455556666';
    const b = '01900000-8641-7c31-8f0e-3a9b1c2d4e5f';
    expect(a.slice(0, 7)).toBe(b.slice(0, 7));
    expect(uuidVersion(a)).toBe(7);
    expect(uuidVersion(b)).toBe(7);
    expect(shortId('codex', a)).not.toBe(shortId('codex', b));
  });

  it('hashes non-UUID ids with the harness as salt', () => {
    const id = 'conv_12345';
    const short = shortId('cursor', id);
    expect(short).toMatch(/^[0-9a-f]{8}$/);
    expect(short).toBe(sha256(`cursor:${id}`).slice(0, 8));
    expect(shortId('gemini', id)).not.toBe(short);
    expect(shortId('cursor', id)).toBe(short);
  });

  it('hashes UUIDs of other versions rather than trusting their prefix', () => {
    const v1 = '12345678-1234-1abc-8def-123456789abc';
    expect(shortId('claude-code', v1)).toBe(sha256(`claude-code:${v1}`).slice(0, 8));
  });
});

describe('safeSid', () => {
  it('accepts uuids and Codex ids verbatim', () => {
    expect(safeSid(V4)).toBe(V4);
    expect(safeSid(V7)).toBe(V7);
    expect(safeSid('01900000111172228333444455556666')).toBe('01900000111172228333444455556666');
    expect(safeSid('a.b_c-d')).toBe('a.b_c-d');
    expect(safeSid('A')).toBe('A');
  });

  it('hashes path-unsafe, empty and over-long ids', () => {
    for (const bad of ['../../x', '/abs/path', 'a\\b', '', 'x'.repeat(4096), '.hidden', '-flag', 'a b', 'a\nb', 'é']) {
      const safe = safeSid(bad);
      expect(safe).toMatch(/^h[0-9a-f]{32}$/);
      expect(safe).toBe(`h${sha256(bad).slice(0, 32)}`);
    }
    expect(safeSid('x'.repeat(128))).toBe('x'.repeat(128));
    expect(safeSid('x'.repeat(129))).toMatch(/^h[0-9a-f]{32}$/);
  });
});
