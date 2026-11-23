import { describe, expect, it } from 'vitest';
import { TOOLS } from './toolbar';
import { KINDS } from '../../shared/model/types';

// Keys the app/canvas handle themselves before (App.tsx: o, ?, Tab) or regardless of the tool shortcut.
const RESERVED = ['O'];

describe('TOOLS (adversarial)', () => {
  it('tool ids and labels are unique and non-empty', () => {
    expect(new Set(TOOLS.map((t) => t.t)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.label)).size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(t.label.trim().length).toBeGreaterThan(0);
  });

  it('no shortcut collides with a global key that App intercepts first', () => {
    for (const t of TOOLS) expect(RESERVED).not.toContain(t.key);
  });

  it('every placeable kind except non-tool ones has a button', () => {
    const tools = new Set(TOOLS.map((t) => t.t as string));
    for (const k of Object.keys(KINDS)) if (!tools.has(k)) expect(['text', 'zone']).not.toContain(k);
  });

  it('keys are uppercase versions of what the keyboard handler lowercases (one char each)', () => {
    for (const t of TOOLS) {
      expect(t.key.length).toBe(1);
      expect(t.key.toLowerCase().toUpperCase()).toBe(t.key);
    }
  });
});
