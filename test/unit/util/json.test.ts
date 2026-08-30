import { describe, expect, it } from 'vitest';
import { isRecord, parseJsonSafe, stableStringify } from '../../../src/util/json.js';

describe('stableStringify', () => {
  it('sorts keys recursively and emits compact JSON', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it('drops undefined, functions and symbols from objects and nulls them in arrays', () => {
    expect(stableStringify({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 })).toBe('{"d":1}');
    expect(stableStringify([undefined, () => 1, 1])).toBe('[null,null,1]');
  });

  it('normalises -0 to 0 and non-finite numbers to null', () => {
    expect(stableStringify({ z: -0 })).toBe('{"z":0}');
    expect(stableStringify([-0, 0, 1.5, -2])).toBe('[0,0,1.5,-2]');
    expect(stableStringify([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null]');
  });

  it('serialises primitives, nulls, nested arrays and escapes strings like JSON.stringify', () => {
    expect(stableStringify('a"b\n')).toBe(JSON.stringify('a"b\n'));
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(3)).toBe('3');
    expect(stableStringify([[1, [2]], { k: [] }])).toBe('[[1,[2]],{"k":[]}]');
    expect(stableStringify({})).toBe('{}');
  });

  it('honours toJSON (dates serialise as ISO strings)', () => {
    expect(stableStringify({ at: new Date(Date.UTC(2026, 7, 29, 12)) })).toBe('{"at":"2026-08-29T12:00:00.000Z"}');
    expect(stableStringify({ toJSON: () => ({ b: 2, a: 1 }) })).toBe('{"a":1,"b":2}');
  });

  it('agrees with JSON.parse round-trips on sorted input', () => {
    const value = { z: [1, { y: 'x', a: null }], m: { n: { o: -0 } } };
    expect(JSON.parse(stableStringify(value))).toEqual({ z: [1, { y: 'x', a: null }], m: { n: { o: 0 } } });
  });

  it('throws on BigInt, circular structures and non-serialisable top-level values', () => {
    expect(() => stableStringify({ n: 1n })).toThrow(TypeError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/circular/);
    expect(() => stableStringify(undefined)).toThrow(TypeError);
    expect(() => stableStringify(() => 1)).toThrow(TypeError);
  });

  it('allows the same object to appear twice when it is not a cycle', () => {
    const shared = { k: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('parseJsonSafe', () => {
  it('parses valid JSON including null and returns undefined for garbage', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonSafe('null')).toBeNull();
    expect(parseJsonSafe('[1,')).toBeUndefined();
    expect(parseJsonSafe('')).toBeUndefined();
    expect(parseJsonSafe('undefined')).toBeUndefined();
  });
});

describe('isRecord', () => {
  it('is true only for non-null, non-array objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('s')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
