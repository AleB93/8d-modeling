// Adversarial tests for the text outline (screen readers, page-reading agents): over seeded random scenes,
// every box is listed exactly once, floors follow pages in order and top to bottom, counts match the summary.
import { describe, expect, it } from 'vitest';
import { sceneOutline } from './outline';
import { validateScene } from '../persistence/persist';
import { demoScene } from '../samples/demo';
import { stressScene } from '../samples/stress';
import { pageLayers, pagesOf } from '../../shared/model/pages';
import { KINDS, Layer, NodeKind, Scene, SNode } from '../../shared/model/types';

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
const STRS = ['', 'API', 'DB', '</script>', '😀', ', down', ' (hidden)', '→', ' ', 'Floor', '__proto__'];

function genScene(seed: number): Scene {
  const R = rng(seed);
  const int = (n: number) => Math.floor(R() * n);
  const pick = <T,>(a: readonly T[]) => a[int(a.length)];
  const pages = R() < 0.6 ? Array.from({ length: 1 + int(3) }, (_, i) => ({ id: `p${i}`, name: pick(STRS) || `P${i}` })) : undefined;
  const layers: Layer[] = Array.from({ length: 1 + int(5) }, (_, i) => ({ id: `l${i}`, name: pick(STRS), visible: R() < 0.7, ...(pages && R() < 0.8 ? { page: pick(pages).id } : {}) }));
  const nodes: Record<string, SNode> = {};
  for (let i = 0; i < int(16); i++) {
    const kind = pick(KIND_LIST), d = KINDS[kind];
    // coarse grid so ties in y (and x) happen often
    nodes[`n_${i}`] = { id: `n_${i}`, kind, x: int(4) * 100, y: int(4) * 100, w: d.w, h: d.h, layer: pick(layers).id, height: d.height, color: d.color, label: pick(STRS), capacity: d.capacity, latency: d.latency, ...(R() < 0.25 ? { down: true } : {}) };
  }
  const ids = Object.keys(nodes);
  const edges: Scene['edges'] = {};
  if (ids.length) for (let i = 0; i < int(20); i++) edges[`e_${i}`] = { id: `e_${i}`, from: pick(ids), to: pick(ids), label: pick(STRS), dashed: R() < 0.3, mult: pick([0, 1, 2]), flow: R() < 0.5 };
  const eids = Object.keys(edges);
  const journeys = eids.length ? Array.from({ length: int(3) }, (_, i) => ({ id: `j${i}`, name: pick(STRS), color: '#fff', steps: Array.from({ length: int(5) }, () => ({ edge: pick(eids), ...(R() < 0.5 ? { back: true } : {}), ...(R() < 0.5 ? { note: pick(STRS) } : {}) })) })) : [];
  const s: Scene = { v: 1, nodes, edges, layers, stops: [], journeys };
  if (pages) s.pages = pages;
  return s;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('sceneOutline: properties over random scenes', () => {
  it('every box appears exactly once, under the floor it lives on', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const o = sceneOutline(s);
      const seen = o.floors.flatMap((f) => f.nodes.map((n) => [f.id, n.id] as const));
      expect(seen.map(([, id]) => id).sort(), `seed ${seed}`).toEqual(Object.keys(s.nodes).sort());
      for (const [floor, id] of seen) expect(s.nodes[id].layer).toBe(floor);
    }
  });

  it('one entry per floor, grouped by page in page order, each page top floor first', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const o = sceneOutline(s);
      const want = pagesOf(s).flatMap((p) => pageLayers(s, p.id).map((l) => l.id).reverse());
      expect(o.floors.map((f) => f.id), `seed ${seed}`).toEqual(want);
      expect(o.floors).toHaveLength(s.layers.length);
    }
  });

  it('floor text: page prefix only with several pages, (hidden) exactly for hidden floors', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const multi = pagesOf(s).length > 1;
      for (const f of sceneOutline(s).floors) {
        const l = s.layers.find((x) => x.id === f.id)!;
        const pg = pagesOf(s).find((p) => pageLayers(s, p.id).includes(l))!;
        expect(f.text).toBe(`${multi ? `${pg.name}: floor` : 'Floor'} ${l.name}${l.visible ? '' : ' (hidden)'}`);
      }
    }
  });

  it('boxes are in reading order (top-left first) within a floor', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      for (const f of sceneOutline(s).floors) {
        const ns = f.nodes.map((n) => s.nodes[n.id]);
        for (let i = 1; i < ns.length; i++) {
          const a = ns[i - 1], b = ns[i];
          expect(a.y < b.y || (a.y === b.y && a.x <= b.x), `seed ${seed}`).toBe(true);
        }
      }
    }
  });

  it('every connection is listed once, under its source box', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const o = sceneOutline(s);
      const links = o.floors.flatMap((f) => f.nodes.flatMap((n) => n.links.map((l) => [n.id, l.id] as const)));
      expect(links.map(([, id]) => id).sort(), `seed ${seed}`).toEqual(Object.keys(s.edges).sort());
      for (const [from, id] of links) expect(s.edges[id].from).toBe(from);
    }
  });

  it('link text names the target (or "(unnamed)"), the label in parentheses and async for dashed', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const s = genScene(seed);
      for (const l of sceneOutline(s).floors.flatMap((f) => f.nodes.flatMap((n) => n.links))) {
        const e = s.edges[l.id];
        expect(l.text).toBe(`→ ${s.nodes[e.to].label || '(unnamed)'}${e.label ? ` (${e.label})` : ''}${e.dashed ? ', async' : ''}`);
      }
    }
  });

  it('summary counts match the scene', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const o = sceneOutline(s);
      const n = Object.keys(s.nodes).length, e = Object.keys(s.edges).length;
      expect(o.summary).toContain(`${n} ${n === 1 ? 'box' : 'boxes'}`);
      expect(o.summary).toContain(`${e} connection${e === 1 ? '' : 's'}`);
      expect(o.summary).toContain(`${s.layers.length} floor${s.layers.length === 1 ? '' : 's'}`);
      expect(o.summary).toContain(`${s.journeys.length} journey${s.journeys.length === 1 ? '' : 's'}`);
      const p = pagesOf(s).length;
      if (p > 1) expect(o.summary).toContain(`${p} pages, `);
      else expect(o.summary).not.toContain('page');
    }
  });

  it('journeys list every step in order, (response) for back steps, note after a colon', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const o = sceneOutline(s);
      expect(o.journeys.map((j) => j.id)).toEqual(s.journeys.map((j) => j.id));
      o.journeys.forEach((oj, k) => {
        const j = s.journeys[k];
        expect(oj.steps).toHaveLength(j.steps.length);
        j.steps.forEach((st, i) => {
          const e = s.edges[st.edge];
          const [a, b] = st.back ? [e.to, e.from] : [e.from, e.to];
          expect(oj.steps[i]).toBe(`${s.nodes[a].label || '(unnamed)'} → ${s.nodes[b].label || '(unnamed)'}${st.back ? ' (response)' : ''}${st.note ? `: ${st.note}` : ''}`);
        });
      });
    }
  });

  it('is pure: does not mutate the scene, same output twice', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const s = genScene(seed);
      const before = JSON.stringify(s);
      expect(sceneOutline(s)).toEqual(sceneOutline(s));
      expect(JSON.stringify(s)).toBe(before);
    }
  });

  it('demo and stress scenes: all boxes listed once', () => {
    for (const s of [demoScene(), stressScene(500)]) {
      const o = sceneOutline(s);
      expect(o.floors.flatMap((f) => f.nodes).length).toBe(Object.keys(s.nodes).length);
      expect(o.floors.flatMap((f) => f.nodes.flatMap((n) => n.links)).length).toBe(Object.keys(s.edges).length);
    }
  });
});

describe('sceneOutline: scenes validateScene accepts but that are not well-formed', () => {
  const node = (id: string, layer: string, label = id): SNode => ({ id, kind: 'service', x: 0, y: 0, w: 1, h: 1, layer, height: 1, color: '#000', label, capacity: 1, latency: 1 });

  // BUG: outline.ts:28 lists boxes by `n.layer === l.id`, so a box on a layer that doesn't exist (validateScene,
  // persist.ts:46, accepts it) is counted in the summary ("2 boxes") but listed nowhere, and is invisible on every
  // page in the editor too. Expected: summary and listing agree; best fixed in validateScene by moving such boxes
  // to the first floor (or dropping them).
  it('a box on a missing floor is still listed (summary and listing agree)', () => {
    const s = validateScene({ nodes: { a: node('a', 'l1'), b: node('b', 'ghost') }, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true }] });
    const o = sceneOutline(s);
    expect(o.summary).toContain('2 boxes');
    expect(o.floors.flatMap((f) => f.nodes.map((n) => n.id)).sort()).toEqual(['a', 'b']);
  });

  // BUG: persist.ts:56 keeps duplicate page ids; outline.ts:27 then emits every floor of that page once per duplicate,
  // so each box is read out twice (and pagePlacements lays the page out twice). Expected: page ids deduplicated
  // in validateScene (keep the first).
  it('duplicate page ids do not list floors twice', () => {
    const s = validateScene({
      nodes: { a: node('a', 'l1') }, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true, page: 'p' }],
      pages: [{ id: 'p', name: 'One' }, { id: 'p', name: 'Again' }],
    });
    const o = sceneOutline(s);
    expect(o.floors).toHaveLength(1);
    expect(o.floors.flatMap((f) => f.nodes)).toHaveLength(1);
  });

  // BUG: journeys.ts:105 stepText uses `label ?? '?'`, so a journey step between unnamed boxes reads " → " (empty
  // names) while the outline's own links say "(unnamed)" (outline.ts:24 uses `||`). Expected: unnamed boxes are
  // named "(unnamed)" in journey steps too. Fix: use `||` in stepText or pass a namer.
  it('journey steps name unnamed boxes like links do', () => {
    const s: Scene = {
      v: 1, nodes: { a: node('a', 'l1', ''), b: node('b', 'l1', 'API') }, layers: [{ id: 'l1', name: 'G', visible: true }],
      edges: { e: { id: 'e', from: 'a', to: 'b', label: '', dashed: false, mult: 1, flow: true } }, stops: [],
      journeys: [{ id: 'j', name: 'J', color: '#fff', steps: [{ edge: 'e' }] }],
    };
    const o = sceneOutline(s);
    expect(o.floors[0].nodes.find((n) => n.id === 'b')).toBeDefined();
    expect(o.journeys[0].steps[0]).toBe('(unnamed) → API');
  });

  it('a dangling connection (target gone) is dropped on load, and the outline copes with one anyway', () => {
    const s = validateScene({ nodes: { a: node('a', 'l1') }, edges: { e: { id: 'e', from: 'a', to: 'gone', label: '', dashed: false, mult: 1, flow: true } }, layers: [{ id: 'l1', name: 'G', visible: true }] });
    expect(s.edges).toEqual({});
    s.edges.e = { id: 'e', from: 'a', to: 'gone', label: '', dashed: false, mult: 1, flow: true };
    expect(sceneOutline(s).floors[0].nodes[0].links[0].text).toBe('→ (unnamed)');
  });
});
