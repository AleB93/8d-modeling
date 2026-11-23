import { describe, expect, it } from 'vitest';
import { stressScene } from './stress';

describe('stressScene', () => {
  it('builds 2000 nodes over 4 floors by default', () => {
    const s = stressScene();
    const nodes = Object.values(s.nodes);
    expect(nodes).toHaveLength(2000);
    expect(s.layers.map((l) => l.name)).toEqual(['Floor 1', 'Floor 2', 'Floor 3', 'Floor 4']);
    for (const l of s.layers) expect(nodes.filter((n) => n.layer === l.id)).toHaveLength(500);
    const edges = Object.values(s.edges).length;
    expect(edges).toBeGreaterThanOrEqual(1500);
    expect(edges).toBeLessThanOrEqual(3000);
    expect(s.stops).toEqual([]);
    expect(s.journeys).toEqual([]);
  });

  it('uses floor-specific kinds; clients only on top with low traffic', () => {
    const s = stressScene(200);
    const floorOf = new Map(s.layers.map((l, i) => [l.id, i]));
    const allowed = [['database', 'cache', 'queue'], ['service', 'queue'], ['service', 'cache'], ['client', 'lb']];
    for (const n of Object.values(s.nodes)) {
      const f = floorOf.get(n.layer)!;
      expect(allowed[f]).toContain(n.kind);
      if (n.kind === 'client') expect(n.capacity).toBe(20);
      expect(n.label).toMatch(new RegExp(`^\\S.* ${f}\\.\\d+$`));
    }
  });

  it('only connects each floor to the floor below, with secondary calls at mult 0.3', () => {
    const s = stressScene(200);
    const floorOf = new Map(s.layers.map((l, i) => [l.id, i]));
    const mults = new Set<number>();
    for (const e of Object.values(s.edges)) {
      const a = floorOf.get(s.nodes[e.from].layer)!, b = floorOf.get(s.nodes[e.to].layer)!;
      expect(a - b).toBe(1);
      mults.add(e.mult);
    }
    expect(mults).toEqual(new Set([1, 0.3]));
  });

  it('is deterministic apart from ids', () => {
    const shape = (n: number) => Object.values(stressScene(n).nodes).map((x) => [x.kind, x.x, x.y, x.label]);
    expect(shape(100)).toEqual(shape(100));
  });

  it('stops at n when it does not split evenly over the floors', () => {
    const s = stressScene(5); // 2 per floor → 2, 2, 1, 0
    expect(Object.keys(s.nodes)).toHaveLength(5);
    const count = s.layers.map((l) => Object.values(s.nodes).filter((n) => n.layer === l.id).length);
    expect(count).toEqual([2, 2, 1, 0]);
    // the empty top floor makes no calls
    for (const e of Object.values(s.edges)) expect([s.layers[1].id, s.layers[2].id]).toContain(s.nodes[e.from].layer);
  });
});
