import { describe, expect, it } from 'vitest';
import { demoScene, isLegacyDemo } from './demo';
import { journeyEnd, stepEnds } from '../journeys/journeys';
import { validateScene } from '../persistence/persist';
import { crossPageEdges, pageLayers, pagePlacements, pagesOf } from '../../shared/model/pages';
import { Simulation } from '../simulation/sim';

describe('demoScene: a food-delivery platform on four pages', () => {
  const s = demoScene();
  const byLabel = (l: string) => Object.values(s.nodes).find((n) => n.label === l)!;
  const pageOf = (label: string) => s.layers.find((l) => l.id === byLabel(label).layer)!.page;

  it('is a valid scene that survives load unchanged', () => {
    expect(validateScene(structuredClone(s))).toEqual(s);
  });

  it('has four independent pages, each with three floors', () => {
    expect(pagesOf(s).map((p) => p.name)).toEqual(['Ordering', 'Delivery', 'Payments', 'Analytics']);
    for (const p of pagesOf(s)) expect(pageLayers(s, p.id)).toHaveLength(3);
    expect(pageLayers(s, s.pages![3].id).map((l) => l.name)).toEqual(['Storage', 'Processing', 'Sources']);
    expect(crossPageEdges(s)).toEqual([]);
    expect(pageOf('Customer app')).toBe(s.pages![0].id);
    expect(pageOf('Dispatch')).toBe(s.pages![1].id);
    expect(pageOf('Ledger')).toBe(s.pages![2].id);
    expect(pageOf('Warehouse')).toBe(s.pages![3].id);
  });

  it('is big enough to explore: dozens of boxes and connections, a VPC per page', () => {
    expect(Object.keys(s.nodes).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(s.edges).length).toBeGreaterThanOrEqual(40);
    const zones = Object.values(s.nodes).filter((n) => n.kind === 'zone');
    expect(zones.map((z) => z.label)).toEqual(['VPC · analytics', 'VPC · payments', 'VPC · delivery', 'VPC · ordering']);
    // zones come first so they draw under the boxes, and each wraps every service of its floor
    expect(Object.values(s.nodes).slice(0, 4).every((n) => n.kind === 'zone')).toBe(true);
    for (const z of zones) {
      for (const n of Object.values(s.nodes).filter((x) => x.layer === z.layer && x !== z)) {
        expect(n.x >= z.x && n.y >= z.y && n.x + n.w <= z.x + z.w && n.y + n.h <= z.y + z.h).toBe(true);
      }
    }
  });

  it('every connection joins existing boxes; boxes on a floor never overlap', () => {
    for (const e of Object.values(s.edges)) {
      expect(s.nodes[e.from]).toBeDefined();
      expect(s.nodes[e.to]).toBeDefined();
    }
    const boxes = Object.values(s.nodes).filter((n) => n.kind !== 'zone');
    for (const a of boxes) for (const b of boxes) {
      if (a === b || a.layer !== b.layer) continue;
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });

  it('journeys are continuous paths over existing connections', () => {
    expect(s.journeys.map((j) => j.name)).toEqual(['Place an order', 'Find a restaurant', 'Assign a courier', 'Pay', 'Daily report']);
    for (const j of s.journeys) {
      let at: string | null = null;
      for (const st of j.steps) {
        const ends = stepEnds(s, st)!;
        expect(ends).not.toBeNull();
        if (at) expect(ends.from, `${j.name}: step starts where the last ended`).toBe(at);
        at = ends.to;
      }
    }
    expect(journeyEnd(s, s.journeys[0])).toBe(byLabel('Customer app').id);
    expect(journeyEnd(s, s.journeys[2])).toBe(byLabel('Push provider').id);
    expect(journeyEnd(s, s.journeys[3])).toBe(byLabel('Checkout').id);
  });

  it('has a tour: a campus overview, then one stop per page looking at that page', () => {
    expect(s.stops.map((st) => st.name)).toEqual(['Campus overview', 'Ordering', 'Delivery', 'Payments', 'Analytics']);
    expect(s.stops[1].journey).toBe(s.journeys[0].id);
    const pl = pagePlacements(s);
    pagesOf(s).forEach((p, i) => {
      const { dx, x0, x1 } = pl.get(p.id)!;
      const tx = s.stops[i + 1].target[0] / (1 / 40);
      expect(tx).toBeGreaterThan(x0 + dx);
      expect(tx).toBeLessThan(x1 + dx);
    });
    for (const st of s.stops) expect(st.pos[1]).toBeGreaterThan(st.target[1]); // looking down at it
  });

  it('simulates cleanly at 1×, and Search is the bottleneck at 2×', () => {
    const vis = new Set(s.layers.map((l) => l.id));
    const sim = new Simulation();
    const one = sim.step(s, 0.1, vis);
    expect(one.total.err).toBeLessThan(0.02);
    sim.multiplier = 2;
    const two = sim.step(s, 0.1, vis);
    expect(two.nodes.get(byLabel('Search').id)!.drop).toBeGreaterThan(0.2);
  });

  it('creates fresh ids on every call', () => {
    expect(Object.keys(demoScene().nodes)).not.toEqual(Object.keys(s.nodes));
  });
});

describe('isLegacyDemo', () => {
  const legacy = () => ({
    nodes: Object.fromEntries(['Web app', 'Mobile app', 'Load balancer', 'VPC · services', 'API #1', 'API #2', 'Email worker', 'Redis', 'Postgres', 'Order events']
      .map((label, i) => [`n${i}`, { label }])),
    edges: {}, layers: [{ id: 'l', name: 'G', visible: true }],
  });

  it('spots a saved scene that is still the old demo', () => {
    expect(isLegacyDemo(legacy())).toBe(true);
  });
  it('leaves anything else alone', () => {
    const edited = legacy();
    (edited.nodes as any).n0.label = 'My app';
    expect(isLegacyDemo(edited)).toBe(false);
    expect(isLegacyDemo({ ...legacy(), pages: [] })).toBe(false);
    expect(isLegacyDemo(demoScene())).toBe(false);
    expect(isLegacyDemo(null)).toBe(false);
    expect(isLegacyDemo('x')).toBe(false);
    expect(isLegacyDemo({ nodes: null })).toBe(false);
    expect(isLegacyDemo({ nodes: { a: null } })).toBe(false);
  });
});
