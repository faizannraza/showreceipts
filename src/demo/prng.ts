/**
 * Seeded PRNG for the demo generator (PLAN S23a, ARCHITECTURE §14.1).
 * mulberry32 over an FNV-1a seed: fast, dependency-free and stable across
 * platforms — two runs with the same seed emit identical streams. Nothing in
 * `src/demo` may read the wall clock or `Math.random`; every random-looking
 * value in a generated transcript flows through this module.
 */

/** FNV-1a 32-bit hash of `text` — the string-to-seed bridge. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic stream of numbers in `[0, 1)` (mulberry32). */
export interface Prng {
  /** Next float in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[min, max]` (inclusive). */
  int(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** `n` lowercase hex characters. */
  hex(n: number): string;
}

/**
 * Creates a {@link Prng} seeded by a string (scenario ids make good seeds).
 */
export function prng(seed: string): Prng {
  let a = seedFrom(seed) || 1;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick() on an empty list');
      return item;
    },
    hex(n: number): string {
      let out = '';
      for (let i = 0; i < n; i++) out += Math.floor(next() * 16).toString(16);
      return out;
    },
  };
}

/**
 * Splits `total` into `n` non-negative integer shares that sum exactly to
 * `total` (the remainder rides on the first share) — used to spread a
 * scenario's usage totals over its assistant messages without drift.
 */
export function distribute(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const shares = new Array<number>(n).fill(base);
  shares[0] = total - base * (n - 1);
  return shares;
}
