/**
 * Cost display formatting (§8.3 wording/format). No `Intl` anywhere —
 * thousands separators are inserted by hand so output is deterministic.
 */

/** `1204` → `1,204`. */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * §8.3: `null` → `n/a`; `0` → `$0.00`; `< 0.01` → 4 decimals (`$0.0042`);
 * `< 1000` → 2 decimals (`$18.42`); `≥ 1000` → whole dollars with a comma
 * (`$1,204`); `≈` prefixed when any unverified/estimated rate, unknown-TTL
 * bucket or unpriced speed/tier contributed.
 */
export function formatUsd(usd: number | null, unverified = false): string {
  if (usd === null || !Number.isFinite(usd)) return 'n/a';
  const prefix = unverified ? '≈' : '';
  if (usd === 0) return `${prefix}$0.00`;
  if (usd < 0.01) return `${prefix}$${usd.toFixed(4)}`;
  if (usd < 1000) return `${prefix}$${usd.toFixed(2)}`;
  return `${prefix}$${withThousands(Math.round(usd))}`;
}

/** Whole-percent display (`87%`); `null`/non-finite → `n/a`. */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return 'n/a';
  return `${Math.round(pct)}%`;
}
