import { expect, it } from 'vitest';
import { TOOLS } from './toolbar';
import { KINDS } from '../../shared/model/types';

it('lists every tool once with a unique single-letter shortcut', () => {
  const keys = TOOLS.map((t) => t.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const k of keys) expect(k).toMatch(/^[A-Z]$/);
  expect(TOOLS.slice(0, 3).map((t) => t.t)).toEqual(['select', 'hand', 'arrow']);
  for (const t of TOOLS.slice(3)) expect(Object.keys(KINDS)).toContain(t.t);
});
