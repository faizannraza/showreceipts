import { afterEach, describe, expect, it } from 'vitest';
import {
  calendarDaysBetween,
  formatClock,
  formatDateRange,
  formatDuration,
  isoDay,
  monthOf,
  parseAsOf,
  parseIso,
  parseSince,
} from '../../../src/util/time.js';

const T = (iso: string): number => Date.parse(iso);
const NOW = T('2026-08-29T12:00:00Z');

describe('parseIso', () => {
  it('parses dates, timestamps, fractions and offsets to epoch ms', () => {
    expect(parseIso('2026-08-29')).toBe(T('2026-08-29T00:00:00Z'));
    expect(parseIso('2026-08-29T12:34:56Z')).toBe(T('2026-08-29T12:34:56Z'));
    expect(parseIso('2026-08-29T12:34:56.789Z')).toBe(T('2026-08-29T12:34:56.789Z'));
    expect(parseIso('2026-08-29T12:34:56.123456789Z')).toBe(T('2026-08-29T12:34:56.123Z'));
    expect(parseIso('2026-08-29 12:34')).toBe(T('2026-08-29T12:34:00Z'));
    expect(parseIso('2026-08-29T12:34:56+02:00')).toBe(T('2026-08-29T10:34:56Z'));
    expect(parseIso('2026-08-29T12:34:56-0530')).toBe(T('2026-08-29T18:04:56Z'));
    expect(parseIso('2026-08-29T12:34:56')).toBe(T('2026-08-29T12:34:56Z'));
    expect(parseIso(' 2026-08-29t01:02:03z ')).toBe(T('2026-08-29T01:02:03Z'));
  });

  it('rejects malformed text and impossible dates/times', () => {
    for (const bad of [
      '',
      'yesterday',
      '2026-1-1',
      '20260829',
      '2026-02-30',
      '2026-13-01',
      '2023-02-29',
      '2026-04-31',
      '2026-00-10',
      '2026-01-00',
      '2026-08-29T24:00:00Z',
      '2026-08-29T12:60:00Z',
      '2026-08-29T12:00:60Z',
      '2026-08-29T12:00:00+25:00',
      '2026-08-29T12:00:00+05:60',
      '2026-08-29T12',
      '1690000000',
    ]) {
      expect(parseIso(bad), bad).toBeNull();
    }
    expect(parseIso('2024-02-29')).toBe(T('2024-02-29T00:00:00Z'));
  });
});

describe('formatClock', () => {
  const ref = T('2026-08-29T09:00:00Z');

  it('prints HH:MM on the reference day and Mon D HH:MM outside it (utc)', () => {
    expect(formatClock(T('2026-08-29T14:05:00Z'), 'utc', ref)).toBe('14:05');
    expect(formatClock(T('2026-08-29T00:00:00Z'), 'utc', ref)).toBe('00:00');
    expect(formatClock(T('2026-08-30T00:01:00Z'), 'utc', ref)).toBe('Aug 30 00:01');
    expect(formatClock(T('2026-07-18T23:59:00Z'), 'utc', ref)).toBe('Jul 18 23:59');
  });

  describe('local time zone', () => {
    const original = process.env['TZ'];
    afterEach(() => {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    });

    it('uses the TZ offset via Date#getTimezoneOffset, no Intl', () => {
      process.env['TZ'] = 'America/New_York';
      expect(new Date(ref).getTimezoneOffset()).toBe(240);
      // 03:30Z on Aug 30 is 23:30 on Aug 29 in New York: same local day as the reference.
      expect(formatClock(T('2026-08-30T03:30:00Z'), 'local', ref)).toBe('23:30');
      expect(formatClock(T('2026-08-30T04:30:00Z'), 'local', ref)).toBe('Aug 30 00:30');
      expect(formatClock(T('2026-08-30T03:30:00Z'), 'utc', ref)).toBe('Aug 30 03:30');
      expect(formatDateRange(T('2026-08-30T03:30:00Z'), T('2026-08-30T03:31:00Z'), 'local')).toBe('Aug 29');
      expect(calendarDaysBetween(ref, T('2026-08-30T03:30:00Z'), 'local')).toBe(0);
      expect(calendarDaysBetween(ref, T('2026-08-30T03:30:00Z'), 'utc')).toBe(1);
    });
  });
});

describe('formatDateRange', () => {
  it('renders a single day, a same-year range and a cross-year range', () => {
    expect(formatDateRange(T('2026-07-18T10:00:00Z'), T('2026-07-18T23:00:00Z'), 'utc')).toBe('Jul 18');
    expect(formatDateRange(T('2026-07-18T10:00:00Z'), T('2026-08-23T01:00:00Z'), 'utc')).toBe('Jul 18 → Aug 23');
    expect(formatDateRange(T('2025-12-30T10:00:00Z'), T('2026-01-02T01:00:00Z'), 'utc')).toBe('Dec 30 2025 → Jan 2 2026');
  });
});

describe('formatDuration', () => {
  it('follows the §10.1 buckets', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_000)).toBe('<1m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59m');
    expect(formatDuration(3_600_000)).toBe('1h 00m');
    expect(formatDuration((2 * 3600 + 5 * 60) * 1000)).toBe('2h 05m');
    expect(formatDuration((23 * 3600 + 59 * 60) * 1000)).toBe('23h 59m');
    expect(formatDuration(86_400_000)).toBe('1d 0h');
    expect(formatDuration(36 * 86_400_000)).toBe('36d 0h');
    expect(formatDuration(36 * 86_400_000 + 5 * 3_600_000 + 59 * 60_000)).toBe('36d 5h');
  });

  it('treats negative and non-finite input as <1m', () => {
    expect(formatDuration(-5)).toBe('<1m');
    expect(formatDuration(Number.NaN)).toBe('<1m');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('<1m');
  });
});

describe('parseSince', () => {
  it('counts Nd back from now and takes YYYY-MM-DD as UTC midnight', () => {
    expect(parseSince('90d', NOW)).toBe(NOW - 90 * 86_400_000);
    expect(parseSince('0d', NOW)).toBe(NOW);
    expect(parseSince(' 30d ', NOW)).toBe(NOW - 30 * 86_400_000);
    expect(parseSince('2026-01-01', NOW)).toBe(T('2026-01-01T00:00:00Z'));
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'd', '90', '90days', '2026-1-1', '2026-02-30', '2026-01-01T00:00:00Z', '-5d', '1.5d']) {
      expect(parseSince(bad, NOW), bad).toBeNull();
    }
  });
});

describe('parseAsOf', () => {
  it('accepts real calendar dates only', () => {
    expect(parseAsOf('2026-02-28')).toBe(T('2026-02-28T00:00:00Z'));
    expect(parseAsOf('2024-02-29')).toBe(T('2024-02-29T00:00:00Z'));
    expect(parseAsOf('2026-02-30')).toBeNull();
    expect(parseAsOf('2023-02-29')).toBeNull();
    expect(parseAsOf('2026-13-01')).toBeNull();
    expect(parseAsOf('2026-04-31')).toBeNull();
    expect(parseAsOf('20260101')).toBeNull();
    expect(parseAsOf('2026-01-01T00:00:00Z')).toBeNull();
    expect(parseAsOf('30d')).toBeNull();
  });
});

describe('isoDay, calendarDaysBetween, monthOf', () => {
  it('isoDay is the UTC day', () => {
    expect(isoDay(T('2026-08-29T23:59:59Z'))).toBe('2026-08-29');
    expect(isoDay(T('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });

  it('calendarDaysBetween counts midnight crossings', () => {
    expect(calendarDaysBetween(T('2026-08-29T23:59:00Z'), T('2026-08-30T00:01:00Z'), 'utc')).toBe(1);
    expect(calendarDaysBetween(T('2026-08-29T00:00:00Z'), T('2026-08-29T23:59:00Z'), 'utc')).toBe(0);
    expect(calendarDaysBetween(T('2026-07-18T10:00:00Z'), T('2026-08-23T01:00:00Z'), 'utc')).toBe(36);
    expect(calendarDaysBetween(T('2026-08-30T00:00:00Z'), T('2026-08-29T00:00:00Z'), 'utc')).toBe(-1);
  });

  it('monthOf is the UTC month of a timestamp', () => {
    expect(monthOf('2026-07-31T23:30:00-05:00')).toBe('2026-08');
    expect(monthOf('2026-07-31T23:30:00Z')).toBe('2026-07');
    expect(monthOf('2026-07-01')).toBe('2026-07');
    expect(monthOf('nope')).toBeNull();
  });
});
