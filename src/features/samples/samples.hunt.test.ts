// Adversarial checks on the bundled sample scenes and the page helpers they feed: integrity (every reference
// resolves), validateScene/JSON stability, odd stress sizes, and page add/delete invariants on random scenes.
import { describe, expect, it } from 'vitest';
import { demoScene } from './demo';
import { stressScene } from './stress';
import { validateScene } from '../persistence/persist';
import { sceneOutline } from '../outline/outline';
import {
  addPage, crossPageEdges, deletePage, ensurePages, layerLevels, layerPages, layerShifts, nodesOnPage, pageLayers, pagePlacements, pagesOf, PAGE_GAP,
} from '../../shared/model/pages';
import { KINDS, makeEdge, makeNode, NodeKind, Scene, SIM_KINDS } from '../../shared/model/types';

function integrity(s: Scene) {
  const layerIds = new Set(s.layers.map((l) => l.id));
  expect(layerIds.size).toBe(s.layers.length);
  for (const [k, n] of Object.entries(s.nodes)) {
    expect(n.id).toBe(k);
    expect(layerIds.has(n.layer)).toBe(true);
    expect(Object.hasOwn(KINDS, n.kind)).toBe(true);
    for (const v of [n.x, n.y, n.w, n.h, n.height, n.capacity, n.latency]) expect(Number.isFinite(v)).toBe(true);
    expect(n.color).toMatch(/^#[0-9a-f]{6}$/i);
  }
  for (const [k, e] of Object.entries(s.edges)) {
    expect(e.id).toBe(k);
    expect(s.nodes[e.from]).toBeDefined();
    expect(s.nodes[e.to]).toBeDefined();
    expect(e.mult).toBeGreaterThanOrEqual(0);
  }
  const jids = new Set(s.journeys.map((j) => j.id));
  for (const j of s.journeys) for (const st of j.steps) expect(Object.hasOwn(s.edges, st.edge)).toBe(true);
  for (const st of s.stops) if (st.journey) expect(jids.has(st.journey)).toBe(true);
  expect(crossPageEdges(s)).toEqual([]);
}

describe('demo scene', () => {
  it('is internally consistent', () => integrity(demoScene()));

  it('passes validateScene unchanged, also after a JSON round trip', () => {
    const s = demoScene();
    expect(validateScene(structuredClone(s))).toEqual(s);
    expect(validateScene(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('journey steps form connected walks (each hop starts where the previous request/response ended, or restarts)', () => {
    const s = demoScene();
    for (const j of s.journeys) {
      expect(j.steps.length).toBeGreaterThan(0);
      for (const st of j.steps) {
        const e = s.edges[st.edge];
        expect(e.from).not.toBe(e.to);
      }
    }
  });

  it('ids are fresh per call (two demo scenes never share ids)', () => {
    const a = demoScene(), b = demoScene();
    const ids = (s: Scene) => [...Object.keys(s.nodes), ...Object.keys(s.edges), ...s.layers.map((l) => l.id), ...s.stops.map((x) => x.id), ...s.journeys.map((x) => x.id)];
    const A = new Set(ids(a));
    for (const id of ids(b)) expect(A.has(id)).toBe(false);
    expect(new Set(ids(a)).size).toBe(ids(a).length);
  });
});

describe('stress scene', () => {
  it.each([0, 1, 2, 3, 5, 7, 13, 64, 101, 999])('n = %i: exactly n nodes, consistent, validates', (n) => {
    const s = stressScene(n);
    expect(Object.keys(s.nodes)).toHaveLength(n);
    integrity(s);
    expect(validateScene(structuredClone(s))).toEqual(s);
    expect(() => sceneOutline(s)).not.toThrow();
  });

  it('edges only go from a floor to the floor directly below, and only between simulated kinds', () => {
    const s = stressScene(400);
    const idx = new Map(s.layers.map((l, i) => [l.id, i]));
    for (const e of Object.values(s.edges)) {
      expect(idx.get(s.nodes[e.from].layer)! - idx.get(s.nodes[e.to].layer)!).toBe(1);
      expect(SIM_KINDS.has(s.nodes[e.from].kind)).toBe(true);
      expect(SIM_KINDS.has(s.nodes[e.to].kind)).toBe(true);
    }
  });

  it('structure is deterministic across calls (same kinds, positions, edge shape)', () => {
    const shape = (s: Scene) => {
      const order = Object.values(s.nodes).map((n) => n.id);
      const at = new Map(order.map((id, i) => [id, i]));
      return {
        nodes: Object.values(s.nodes).map((n) => [n.kind, n.x, n.y, s.layers.findIndex((l) => l.id === n.layer), n.label]),
        edges: Object.values(s.edges).map((e) => [at.get(e.from), at.get(e.to), e.mult]),
      };
    };
    expect(shape(stressScene(300))).toEqual(shape(stressScene(300)));
  });

  it('boxes on the same floor do not overlap', () => {
    const s = stressScene(600);
    for (const l of s.layers) {
      const ns = Object.values(s.nodes).filter((n) => n.layer === l.id);
      const cells = new Set(ns.map((n) => `${n.x},${n.y}`));
      expect(cells.size).toBe(ns.length);
      for (const n of ns) { expect(n.w).toBeLessThanOrEqual(220); expect(n.h).toBeLessThanOrEqual(170); }
    }
  });
});

// ---- page helpers on random multi-page scenes ----
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const KIND_LIST = Object.keys(KINDS) as NodeKind[];

function genPaged(seed: number): Scene {
  const R = rng(seed);
  const int = (n: number) => Math.floor(R() * n);
  const s: Scene = { v: 1, nodes: {}, edges: {}, layers: [{ id: 'l_0', name: 'G', visible: true }], stops: [], journeys: [] };
  if (R() < 0.7) ensurePages(s);
  for (let i = 0, m = int(4); i < m; i++) {
    const { page } = addPage(s, R() < 0.5 ? undefined : `Name ${i}`);
    for (let k = 0, f = int(3); k < f; k++) s.layers.push({ id: `l_${i}_${k}`, name: 'F', visible: R() < 0.8, page: page.id });
  }
  for (let i = 0, m = int(25); i < m; i++) {
    const l = s.layers[int(s.layers.length)];
    const n = makeNode(KIND_LIST[int(KIND_LIST.length)], Math.round((R() - 0.5) * 4000), Math.round((R() - 0.5) * 4000), l.id);
    s.nodes[n.id] = n;
  }
  const ids = Object.keys(s.nodes);
  const lp = layerPages(s);
  for (let i = 0, m = int(30); i < m && ids.length; i++) {
    const a = s.nodes[ids[int(ids.length)]], b = s.nodes[ids[int(ids.length)]];
    if (lp.get(a.layer) !== lp.get(b.layer)) continue;
    const e = makeEdge(a.id, b.id);
    s.edges[e.id] = e;
  }
  return s;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('pages: invariants on random scenes', () => {
  it('every layer and node belongs to exactly one page; page floors partition the layers', () => {
    for (const seed of SEEDS) {
      const s = genPaged(seed);
      const all = pagesOf(s).flatMap((p) => pageLayers(s, p.id).map((l) => l.id));
      expect(all.sort()).toEqual(s.layers.map((l) => l.id).sort());
      const nodes = pagesOf(s).flatMap((p) => nodesOnPage(s, p.id).map((n) => n.id));
      expect(nodes.sort()).toEqual(Object.keys(s.nodes).sort());
    }
  });

  it('layerLevels restart at 0 per page and count up in layer order', () => {
    for (const seed of SEEDS) {
      const s = genPaged(seed);
      const lv = layerLevels(s);
      for (const p of pagesOf(s)) expect(pageLayers(s, p.id).map((l) => lv.get(l.id))).toEqual(pageLayers(s, p.id).map((_, i) => i));
    }
  });

  it('placements: first page unshifted, later pages exactly PAGE_GAP right of the previous one; layerShifts agree', () => {
    for (const seed of SEEDS) {
      const s = genPaged(seed);
      const pl = pagePlacements(s);
      const ps = pagesOf(s).map((p) => pl.get(p.id)!);
      expect(ps[0].dx).toBe(0);
      for (let i = 1; i < ps.length; i++) expect(ps[i].x0 + ps[i].dx - (ps[i - 1].x1 + ps[i - 1].dx)).toBe(PAGE_GAP);
      const sh = layerShifts(s), lp = layerPages(s);
      for (const l of s.layers) expect(sh.get(l.id)).toBe(pl.get(lp.get(l.id)!)!.dx);
    }
  });

  it('ensurePages is idempotent and does not change which page anything is on', () => {
    for (const seed of SEEDS) {
      const s = genPaged(seed);
      const before = layerPages(s);
      ensurePages(s);
      const once = structuredClone(s);
      ensurePages(s);
      expect(s).toEqual(once);
      expect(layerPages(s)).toEqual(before);
      for (const l of s.layers) expect(typeof l.page).toBe('string');
    }
  });

  it('deletePage removes exactly that page\'s floors, boxes and their connections, and keeps the rest valid', () => {
    for (const seed of SEEDS) {
      const s = genPaged(seed);
      const pages = pagesOf(s);
      if (pages.length < 2) { expect(() => deletePage(structuredClone(s), pages[0].id)).toThrow(); continue; }
      const victim = pages[seed % pages.length].id;
      const doomed = new Set(nodesOnPage(s, victim).map((n) => n.id));
      const keptEdges = Object.values(s.edges).filter((e) => !doomed.has(e.from) && !doomed.has(e.to)).map((e) => e.id);
      const t = structuredClone(s);
      expect(deletePage(t, victim)).toBe(doomed.size);
      expect(Object.keys(t.nodes).sort()).toEqual(Object.keys(s.nodes).filter((id) => !doomed.has(id)).sort());
      expect(Object.keys(t.edges).sort()).toEqual(keptEdges.sort());
      expect(t.pages!.map((p) => p.id)).toEqual(pages.filter((p) => p.id !== victim).map((p) => p.id));
      expect(t.layers.length).toBeGreaterThan(0);
      expect(() => validateScene(structuredClone(t))).not.toThrow();
      expect(() => sceneOutline(t)).not.toThrow();
    }
  });

  it('addPage names never collide with existing names (case-insensitive)', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const s = genPaged(seed);
      ensurePages(s);
      s.pages!.forEach((p, i) => { if (i % 2) p.name = `PAGE ${s.pages!.length + 1}`; });
      const { page } = addPage(s);
      const lower = s.pages!.filter((p) => p !== page).map((p) => p.name.toLowerCase());
      expect(lower).not.toContain(page.name.toLowerCase());
    }
  });
});
