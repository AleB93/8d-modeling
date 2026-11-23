import { describe, expect, it } from 'vitest';
import { fmt } from './format';

describe('fmt', () => {
  it('rounds small numbers', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(949.6)).toBe('950');
  });
  it('abbreviates thousands with one decimal', () => {
    expect(fmt(1000)).toBe('1.0k');
    expect(fmt(1234)).toBe('1.2k');
    expect(fmt(25500)).toBe('25.5k');
  });
});
