import { describe, expect, it } from 'vitest';
import {
  addPage, crossPageEdges, DEFAULT_PAGE_ID, deletePage, ensurePages, layerLevels, layerPages, layerShifts, nodesOnPage,
  PAGE_GAP, pageLayers, pageOfLayer, pagePlacements, pagesOf,
} from './pages';
import { emptyScene, makeEdge, makeNode, Scene } from './types';

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

function legacy(): Scene {
  const s = emptyScene();
  delete s.pages;
  delete s.layers[0].page;
  s.layers.push({ id: 'l_top', name: 'Top', visible: true });
  return s;
}

describe('hunt: pagesOf / layerPages', () => {
  it('an explicit empty pages array reads as the default page', () => {
    const s = emptyScene();
    s.pages = [];
    expect(pagesOf(s).map((p) => p.id)).toEqual([DEFAULT_PAGE_ID]);
    expect(layerPages(s).get(s.layers[0].id)).toBe(DEFAULT_PAGE_ID);
  });

  it('layers pointing at a deleted page fall back to the first page, not vanish', () => {
    const s = emptyScene();
    const { page, layer } = addPage(s, 'B');
    s.pages = s.pages!.filter((p) => p.id !== page.id); // page removed, layer kept
    expect(pageOfLayer(s, layer.id)).toBe(s.pages[0].id);
    expect(pageLayers(s, s.pages[0].id).map((l) => l.id)).toContain(layer.id);
  });

  it('every layer maps to exactly one existing page', () => {
    const s = emptyScene();
    addPage(s); addPage(s);
    s.layers.push({ id: 'l_bad', name: 'x', visible: true, page: 'ghost' });
    s.layers.push({ id: 'l_none', name: 'y', visible: false });
    const ids = new Set(pagesOf(s).map((p) => p.id));
    const lp = layerPages(s);
    expect(lp.size).toBe(s.layers.length);
    for (const p of lp.values()) expect(ids.has(p)).toBe(true);
    const total = pagesOf(s).reduce((k, p) => k + pageLayers(s, p.id).length, 0);
    expect(total).toBe(s.layers.length);
  });

  it('pageOfLayer for an unknown layer is the first page', () => {
    const s = emptyScene();
    addPage(s);
    expect(pageOfLayer(s, 'nope')).toBe(s.pages![0].id);
  });
});

describe('hunt: layerLevels', () => {
  it('numbers floors per page even when pages interleave in the layer array', () => {
    const s = emptyScene();
    const p1 = s.pages![0].id;
    const { page: p2, layer: b0 } = addPage(s);
    s.layers.push({ id: 'a1', name: 'a1', visible: true, page: p1 });
    s.layers.push({ id: 'b1', name: 'b1', visible: false, page: p2.id });
    s.layers.push({ id: 'a2', name: 'a2', visible: true, page: p1 });
    const lv = layerLevels(s);
    expect(lv.get(s.layers[0].id)).toBe(0);
    expect(lv.get(b0.id)).toBe(0);
    expect(lv.get('a1')).toBe(1);
    expect(lv.get('b1')).toBe(1); // hidden floors still count
    expect(lv.get('a2')).toBe(2);
  });

  it('levels on each page are 0..n-1 without gaps', () => {
    const r = rng(3);
    const s = emptyScene();
    for (let i = 0; i < 4; i++) addPage(s);
    const pages = pagesOf(s);
    for (let i = 0; i < 30; i++) s.layers.push({ id: 'l' + i, name: '', visible: r() < 0.5, page: pages[Math.floor(r() * pages.length)].id });
    const lv = layerLevels(s);
    for (const p of pages) {
      const levels = pageLayers(s, p.id).map((l) => lv.get(l.id));
      expect(levels).toEqual(levels.map((_, i) => i));
    }
  });
});

describe('hunt: ensurePages', () => {
  it('is idempotent', () => {
    const s = legacy();
    ensurePages(s);
    const once = JSON.stringify(s);
    ensurePages(s);
    expect(JSON.stringify(s)).toBe(once);
  });

  it('normalizes dangling page references onto the first page', () => {
    const s = emptyScene();
    s.layers.push({ id: 'l_x', name: 'x', visible: true, page: 'ghost' });
    ensurePages(s);
    expect(s.layers.find((l) => l.id === 'l_x')!.page).toBe(s.pages![0].id);
  });

  it('does not change any layer’s page membership', () => {
    const s = emptyScene();
    addPage(s);
    s.layers.push({ id: 'l_x', name: 'x', visible: true });
    const before = layerPages(s);
    ensurePages(s);
    expect(layerPages(s)).toEqual(before);
  });

  it('returns copies, so callers mutating the result change the scene, not a shared default', () => {
    const s1 = legacy(), s2 = legacy();
    ensurePages(s1)[0].name = 'Renamed';
    expect(pagesOf(s2)[0].name).toBe('Page 1');
  });
});

describe('hunt: addPage / deletePage', () => {
  it('addPage on a legacy scene keeps the old floors on p_main and puts the new floor on the new page', () => {
    const s = legacy();
    const { page, layer } = addPage(s);
    expect(pagesOf(s).map((p) => p.id)).toEqual([DEFAULT_PAGE_ID, page.id]);
    expect(pageLayers(s, DEFAULT_PAGE_ID).map((l) => l.id)).toEqual([s.layers[0].id, 'l_top']);
    expect(pageLayers(s, page.id)).toEqual([layer]);
    expect(page.name).toBe('Page 2');
  });

  it('addPage names never collide, even after deletions', () => {
    const s = emptyScene();
    const a = addPage(s).page; // Page 2
    addPage(s); // Page 3
    deletePage(s, a.id);
    const c = addPage(s).page;
    const names = pagesOf(s).map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(c.name).toBe('Page 4');
  });

  it('addPage with an empty name falls back to a generated one', () => {
    const s = emptyScene();
    expect(addPage(s, '').page.name).toBe('Page 2');
  });

  it('deleting an unknown page id removes nothing', () => {
    const s = emptyScene();
    addPage(s);
    const n = makeNode('service', 0, 0, s.layers[0].id);
    s.nodes[n.id] = n;
    expect(deletePage(s, 'p_ghost')).toBe(0);
    expect(pagesOf(s)).toHaveLength(2);
    expect(s.layers).toHaveLength(2);
    expect(s.nodes[n.id]).toBe(n);
  });

  it('deleting the first page removes floors whose page reference was dangling too', () => {
    const s = emptyScene();
    const p1 = s.pages![0].id;
    const { layer } = addPage(s);
    s.layers.push({ id: 'l_dang', name: 'd', visible: true, page: 'ghost' }); // shown on page 1
    deletePage(s, p1);
    expect(s.layers.map((l) => l.id)).toEqual([layer.id]);
  });

  it('removes edges that cross from the deleted page but keeps edges between surviving boxes', () => {
    const s = emptyScene();
    const g = s.layers[0].id;
    const { page, layer } = addPage(s);
    const a = makeNode('service', 0, 0, g), b = makeNode('service', 0, 0, g), c = makeNode('service', 0, 0, layer.id);
    for (const n of [a, b, c]) s.nodes[n.id] = n;
    const ab = makeEdge(a.id, b.id), bc = makeEdge(b.id, c.id), ca = makeEdge(c.id, a.id);
    for (const e of [ab, bc, ca]) s.edges[e.id] = e;
    expect(crossPageEdges(s).map((e) => e.id).sort()).toEqual([bc.id, ca.id].sort());
    expect(deletePage(s, page.id)).toBe(1);
    expect(Object.keys(s.edges)).toEqual([ab.id]);
    expect(crossPageEdges(s)).toEqual([]);
  });

  it('a legacy scene with one page refuses deletion of p_main', () => {
    const s = legacy();
    expect(() => deletePage(s, DEFAULT_PAGE_ID)).toThrow();
  });

  it('deletePage keeps page order of the survivors', () => {
    const s = emptyScene();
    const a = addPage(s, 'A').page, b = addPage(s, 'B').page, c = addPage(s, 'C').page;
    deletePage(s, b.id);
    expect(pagesOf(s).map((p) => p.id)).toEqual([s.pages![0].id, a.id, c.id]);
  });
});

describe('hunt: nodesOnPage', () => {
  it('partitions the nodes whose layers exist; orphans are on no page', () => {
    const s = emptyScene();
    const { layer } = addPage(s);
    const a = makeNode('service', 0, 0, s.layers[0].id), b = makeNode('service', 0, 0, layer.id), o = makeNode('service', 0, 0, 'l_gone');
    for (const n of [a, b, o]) s.nodes[n.id] = n;
    const all = pagesOf(s).flatMap((p) => nodesOnPage(s, p.id).map((n) => n.id));
    expect(all.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('hunt: pagePlacements', () => {
  function randomScene(seed: number) {
    const r = rng(seed);
    const s = emptyScene();
    const np = 1 + Math.floor(r() * 5);
    for (let i = 0; i < np; i++) addPage(s);
    for (let i = 0; i < 6; i++) s.layers.push({ id: 'lx' + i, name: '', visible: r() < 0.7, page: pagesOf(s)[Math.floor(r() * pagesOf(s).length)].id });
    const nn = Math.floor(r() * 25);
    for (let i = 0; i < nn; i++) {
      const l = s.layers[Math.floor(r() * s.layers.length)].id;
      const n = makeNode('service', Math.round((r() - 0.5) * 4000), Math.round((r() - 0.5) * 4000), l, { w: 10 + Math.round(r() * 300), h: 10 + Math.round(r() * 300) });
      s.nodes[n.id] = n;
    }
    return s;
  }

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`seed ${seed}: pages never overlap in 3D and are separated by exactly PAGE_GAP`, () => {
      const s = randomScene(seed);
      const pl = pagePlacements(s);
      const pages = pagesOf(s);
      expect(pl.size).toBe(pages.length);
      expect(pl.get(pages[0].id)!.dx).toBe(0);
      for (let i = 1; i < pages.length; i++) {
        const a = pl.get(pages[i - 1].id)!, b = pl.get(pages[i].id)!;
        expect(b.dx + b.x0 - (a.dx + a.x1)).toBe(PAGE_GAP);
      }
      // each page's extent covers all its boxes
      for (const p of pages) {
        const e = pl.get(p.id)!;
        for (const n of nodesOnPage(s, p.id)) {
          expect(n.x).toBeGreaterThanOrEqual(e.x0);
          expect(n.x + n.w).toBeLessThanOrEqual(e.x1);
          expect(n.y).toBeGreaterThanOrEqual(e.y0);
          expect(n.y + n.h).toBeLessThanOrEqual(e.y1);
        }
      }
      // layerShifts agrees with placements for every layer
      const sh = layerShifts(s), lp = layerPages(s);
      for (const l of s.layers) expect(sh.get(l.id)).toBe(pl.get(lp.get(l.id)!)!.dx);
    });
  }

  it('a legacy scene places its single page at dx 0 keyed by p_main', () => {
    const s = legacy();
    const n = makeNode('service', 500, 500, 'l_top');
    s.nodes[n.id] = n;
    expect(pagePlacements(s).get(DEFAULT_PAGE_ID)).toEqual({ dx: 0, x0: 500, x1: 500 + n.w, y0: 500, y1: 500 + n.h });
  });

  it('the first page keeps dx 0 even when its boxes are far to the right of the others', () => {
    const s = emptyScene();
    const { layer } = addPage(s);
    const a = makeNode('service', 10000, 0, s.layers[0].id, { w: 100 });
    const b = makeNode('service', -10000, 0, layer.id, { w: 100 });
    s.nodes[a.id] = a; s.nodes[b.id] = b;
    const pl = pagePlacements(s);
    expect(pl.get(s.pages![0].id)!.dx).toBe(0);
    expect(pl.get(s.pages![1].id)!.dx + -10000).toBe(10100 + PAGE_GAP);
  });

  it('boxes on hidden floors still count toward the page extent', () => {
    const s = emptyScene();
    s.layers[0].visible = false;
    const a = makeNode('service', -300, -300, s.layers[0].id, { w: 10, h: 10 });
    s.nodes[a.id] = a;
    expect(pagePlacements(s).get(s.pages![0].id)).toMatchObject({ x0: -300, y0: -300 });
  });
});
