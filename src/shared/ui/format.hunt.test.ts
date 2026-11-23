import { describe, expect, it } from 'vitest';
import { fmt } from './format';

describe('fmt (adversarial)', () => {
  it('never prints more than 3 digits before the k suffix boundary', () => {
    // Anything that rounds to 1000 should read as thousands, like 1000 itself ("1.0k").
    // BUG: format.ts:2 — the threshold is checked before rounding, so 999.5 → Math.round → "1000"
    // while 1000 → "1.0k". Expected "1.0k", actual "1000". Fix: compare Math.round(n) >= 1000.
    expect(fmt(999.5)).toBe('1.0k');
  });

  it('is monotone in displayed magnitude for non-negative input', () => {
    const val = (s: string) => (s.endsWith('k') ? parseFloat(s) * 1000 : parseFloat(s));
    let last = -1;
    for (let n = 0; n < 200000; n += 1.37) {
      const v = val(fmt(n));
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('rounds half up below 1000 and keeps one decimal above', () => {
    expect(fmt(0.4)).toBe('0');
    expect(fmt(0.5)).toBe('1');
    expect(fmt(1049)).toBe('1.0k');
    expect(fmt(1050)).toBe('1.1k'); // toFixed rounding of 1.05
    expect(fmt(9999.9)).toBe('10.0k');
  });

  it('never produces "-0" for tiny negative values', () => {
    expect(fmt(-0.4)).toBe('0');
    expect(fmt(-0)).toBe('0');
  });

  it('output is always a short numeric label for sim-sized values (0..1e6)', () => {
    for (const n of [0, 1, 12.3, 999, 1000, 54321, 999999]) expect(fmt(n)).toMatch(/^\d+(\.\d)?[kM]?$/);
  });
});

describe('fmt millions', () => {
  it('switches to M at a million, never printing 1000.0k', () => {
    expect(fmt(999_949)).toBe('999.9k');
    expect(fmt(999_950)).toBe('1.0M');
    expect(fmt(2_500_000)).toBe('2.5M');
    expect(fmt(-1500)).toBe('-1.5k');
  });
});
