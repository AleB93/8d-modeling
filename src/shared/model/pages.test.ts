import { describe, expect, it } from 'vitest';
import {
  addPage, crossPageEdges, DEFAULT_PAGE_ID, deletePage, ensurePages, layerLevels, layerPages, layerShifts, nodesOnPage,
  PAGE_GAP, pageLayers, pageOfLayer, pagePlacements, pagesOf,
} from './pages';
import { Store } from './store';
import { emptyScene, makeEdge, makeNode, Scene } from './types';

/** A pre-pages scene (no `pages`, layers without `page`). */
function legacy(): Scene {
  const s = emptyScene();
  delete s.pages;
  delete s.layers[0].page;
  s.layers.push({ id: 'l_top', name: 'Top', visible: true });
  return s;
}

/** Two pages: "Page 1" (Ground + Top) and "Ops" (one floor) with a box on each. */
function twoPages() {
  const s = emptyScene();
  const ground = s.layers[0];
  s.layers.push({ id: 'l_top', name: 'Top', visible: true, page: s.pages![0].id });
  const { page, layer } = addPage(s, 'Ops');
  const a = makeNode('service', 100, 50, ground.id, { label: 'A' });
  const b = makeNode('service', 0, 0, layer.id, { label: 'B', w: 200 });
  s.nodes[a.id] = a;
  s.nodes[b.id] = b;
  return { s, ground, page, layer, a, b };
}

describe('pages model', () => {
  it('reads a scene without pages as one page holding every floor', () => {
    const s = legacy();
    expect(pagesOf(s)).toEqual([{ id: DEFAULT_PAGE_ID, name: 'Page 1' }]);
    expect(pageOfLayer(s, 'l_top')).toBe(DEFAULT_PAGE_ID);
    expect(pageOfLayer(s, 'missing')).toBe(DEFAULT_PAGE_ID);
    expect(pageLayers(s, DEFAULT_PAGE_ID).map((l) => l.name)).toEqual(['Ground', 'Top']);
    expect([...layerLevels(s).values()]).toEqual([0, 1]);
  });

  it('puts floors with an unknown page on the first page', () => {
    const s = emptyScene();
    s.layers.push({ id: 'l_x', name: 'X', visible: true, page: 'nope' });
    expect(layerPages(s).get('l_x')).toBe(s.pages![0].id);
  });

  it('materializes pages, keeping floor membership', () => {
    const s = legacy();
    const ps = ensurePages(s);
    expect(ps).toEqual([{ id: DEFAULT_PAGE_ID, name: 'Page 1' }]);
    expect(s.layers.every((l) => l.page === DEFAULT_PAGE_ID)).toBe(true);
  });

  it('adds pages with a fresh floor and a free name', () => {
    const s = emptyScene();
    s.pages![0].name = 'Page 2';
    const { page, layer } = addPage(s);
    expect(page.name).toBe('Page 3');
    expect(layer).toMatchObject({ name: 'Ground', page: page.id });
    expect(pageLayers(s, page.id)).toEqual([layer]);
    expect(layerLevels(s).get(layer.id)).toBe(0); // its own bottom floor
    expect(addPage(s, 'Named').page.name).toBe('Named');
  });

  it('deletes a page with its floors, boxes and their connections', () => {
    const { s, page, a, b } = twoPages();
    s.edges.x = { ...makeEdge(a.id, b.id), id: 'x' };
    expect(nodesOnPage(s, page.id)).toEqual([b]);
    expect(crossPageEdges(s).map((e) => e.id)).toEqual(['x']);
    s.edges.dangling = { ...makeEdge(a.id, 'gone'), id: 'dangling' };
    expect(crossPageEdges(s).map((e) => e.id)).toEqual(['x']); // dangling ends are ignored
    expect(deletePage(s, page.id)).toBe(1);
    expect(pagesOf(s)).toHaveLength(1);
    expect(s.nodes[b.id]).toBeUndefined();
    expect(s.edges).toEqual({});
    expect(() => deletePage(s, s.pages![0].id)).toThrow("Can't delete the only page");
  });

  it('lays pages out side by side; the first stays put', () => {
    const { s, ground, page, layer, a, b } = twoPages();
    const empty = addPage(s, 'Empty').page;
    const p = pagePlacements(s);
    const first = p.get(s.pages![0].id)!;
    expect(first).toEqual({ dx: 0, x0: a.x, x1: a.x + a.w, y0: a.y, y1: a.y + a.h });
    const second = p.get(page.id)!;
    expect(second.dx + second.x0).toBe(a.x + a.w + PAGE_GAP);
    expect(second.x1).toBe(b.x + b.w);
    // grows to include every box of the page
    const c = makeNode('service', -50, -20, layer.id);
    s.nodes[c.id] = c;
    expect(pagePlacements(s).get(page.id)).toMatchObject({ x0: -50, y0: -20, x1: 200, y1: Math.max(b.h, c.h - 20) });
    expect(p.get(empty.id)).toMatchObject({ x0: 0, x1: 400 });
    expect(layerShifts(s).get(ground.id)).toBe(0);
    expect(layerShifts(s).get(layer.id)).toBe(pagePlacements(s).get(page.id)!.dx);
    // boxes on a floor that isn't in the scene don't count
    s.nodes.orphan = makeNode('service', 9999, 0, 'nowhere');
    expect(pagePlacements(s).get(s.pages![0].id)!.x1).toBe(a.x + a.w);
  });
});

describe('store pages', () => {
  it('opens a page: top floor active, selection on other pages dropped', () => {
    const { s, page, layer, a, b } = twoPages();
    const st = new Store();
    st.load(s);
    st.setActiveLayer(s.layers[0].id);
    expect(st.activePage).toBe(s.pages![0].id);
    st.select([a.id, b.id]);
    const e = makeEdge(b.id, b.id);
    st.update((sc) => { sc.edges[e.id] = e; }, false);
    st.selection.add(e.id).add('ghost');
    st.openPage(page.id);
    expect(st.activeLayer).toBe(layer.id);
    expect([...st.selection].sort()).toEqual([b.id, e.id].sort());
    st.openPage(page.id); // already open: no-op
    st.openPage('nope'); // unknown: no-op
    expect(st.activePage).toBe(page.id);
  });

  it('draws only visible floors of the open page in 2D', () => {
    const { s, ground, layer } = twoPages();
    const st = new Store();
    st.load(s);
    st.setActiveLayer(ground.id);
    expect(st.onCanvas(ground.id)).toBe(true);
    expect(st.onCanvas('l_top')).toBe(true);
    expect(st.onCanvas(layer.id)).toBe(false);
    st.update((sc) => { sc.layers.find((l) => l.id === 'l_top')!.visible = false; });
    expect(st.onCanvas('l_top')).toBe(false);
    st.setActiveLayer(layer.id);
    expect(st.onCanvas(layer.id)).toBe(true);
    expect(st.onCanvas(ground.id)).toBe(false);
  });

  it('showing a journey opens its page', () => {
    const { s, ground, page, layer, b } = twoPages();
    const c = makeNode('service', 300, 0, layer.id);
    s.nodes[c.id] = c;
    const e = makeEdge(b.id, c.id);
    s.edges[e.id] = e;
    s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [{ edge: e.id }] }, { id: 'empty', name: 'E', color: '#fff', steps: [] });
    const st = new Store();
    st.load(s);
    st.setActiveLayer(ground.id);
    st.setJourney('empty');
    expect(st.activePage).toBe(s.pages![0].id);
    st.setJourney('j');
    expect(st.activePage).toBe(page.id);
    st.setJourney(null);
    st.setJourney('j'); // already on that page
    expect(st.activePage).toBe(page.id);
  });
});

describe('opening a scene', () => {
  it('starts on the top floor of the first page', async () => {
    const { demoScene } = await import('../../features/samples/demo');
    const st = new Store();
    const s = demoScene();
    st.load(s);
    expect(st.activePage).toBe(s.pages![0].id);
    expect(st.activeLayer).toBe(pageLayers(s, s.pages![0].id).at(-1)!.id);
  });
});
