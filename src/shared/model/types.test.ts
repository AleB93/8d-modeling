import { describe, expect, it } from 'vitest';
import { emptyScene, isEdgeId, isNodeId, JOURNEY_COLORS, KINDS, makeEdge, makeNode, PALETTE, SIM_KINDS, uid } from './types';

describe('uid', () => {
  it('prefixes a random id and is unique', () => {
    const a = uid('n'), b = uid('n');
    expect(a).toMatch(/^n_[0-9a-z]{1,8}$/);
    expect(a).not.toBe(b);
  });
});

describe('makeNode', () => {
  it('takes size, color and sim defaults from the kind', () => {
    const n = makeNode('database', 10, 20, 'l1');
    const d = KINDS.database;
    expect(n).toMatchObject({ kind: 'database', x: 10, y: 20, layer: 'l1', w: d.w, h: d.h, height: d.height, color: d.color, capacity: d.capacity, latency: d.latency, label: 'Database' });
    expect(isNodeId(n.id)).toBe(true);
    expect(n.down).toBeUndefined();
  });

  it('labels text nodes "Text" and applies overrides', () => {
    expect(makeNode('text', 0, 0, 'l').label).toBe('Text');
    const n = makeNode('service', 0, 0, 'l', { label: 'API', w: 5, down: true });
    expect(n).toMatchObject({ label: 'API', w: 5, down: true, h: KINDS.service.h });
  });
});

describe('makeEdge', () => {
  it('has sensible defaults and accepts overrides', () => {
    const e = makeEdge('a', 'b');
    expect(e).toMatchObject({ from: 'a', to: 'b', label: '', dashed: false, mult: 1, flow: true });
    expect(isEdgeId(e.id)).toBe(true);
    expect(isNodeId(e.id)).toBe(false);
    expect(makeEdge('a', 'b', { dashed: true, mult: 0.5 })).toMatchObject({ dashed: true, mult: 0.5 });
  });
});

describe('emptyScene', () => {
  it('has one visible ground layer and nothing else', () => {
    const s = emptyScene();
    expect(s.v).toBe(1);
    expect(s.nodes).toEqual({});
    expect(s.edges).toEqual({});
    expect(s.stops).toEqual([]);
    expect(s.journeys).toEqual([]);
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0]).toMatchObject({ name: 'Ground', visible: true });
    expect(s.layers[0].id.startsWith('l_')).toBe(true);
  });
});

describe('constants', () => {
  it('simulates every kind except zones and text', () => {
    for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      expect(SIM_KINDS.has(k)).toBe(k !== 'zone' && k !== 'text');
    }
  });

  it('uses #rrggbb colors', () => {
    for (const c of [...PALETTE, ...JOURNEY_COLORS, ...Object.values(KINDS).map((k) => k.color)]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
