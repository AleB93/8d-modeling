import { Layer, Page, Scene, SNode, uid } from './types';

// Pages: independent diagrams in one scene. Each page owns a stack of floors (layers), and through them
// its boxes. The 2D editor shows one page at a time; 3D lays every page out side by side on the ground.
// Scenes saved before pages existed have no `pages`: they read as a single page holding every floor.

export const DEFAULT_PAGE_ID = 'p_main';
/** World px between neighbouring pages in 3D. */
export const PAGE_GAP = 600;

export function pagesOf(s: Scene): Page[] {
  return s.pages?.length ? s.pages : [{ id: DEFAULT_PAGE_ID, name: 'Page 1' }];
}

/** Layer id → page id, for every layer. Layers without a (valid) page belong to the first page. */
export function layerPages(s: Scene): Map<string, string> {
  const ps = pagesOf(s);
  const ids = new Set(ps.map((p) => p.id));
  return new Map(s.layers.map((l) => [l.id, l.page && ids.has(l.page) ? l.page : ps[0].id]));
}

export function pageOfLayer(s: Scene, layerId: string): string {
  return layerPages(s).get(layerId) ?? pagesOf(s)[0].id;
}

/** A page's floors, bottom first. */
export function pageLayers(s: Scene, pageId: string): Layer[] {
  const lp = layerPages(s);
  return s.layers.filter((l) => lp.get(l.id) === pageId);
}

/** Floor number of a layer within its page (0 = bottom). */
export function layerLevels(s: Scene): Map<string, number> {
  const lp = layerPages(s);
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const l of s.layers) {
    const p = lp.get(l.id)!;
    const k = seen.get(p) ?? 0;
    out.set(l.id, k);
    seen.set(p, k + 1);
  }
  return out;
}

export function nodesOnPage(s: Scene, pageId: string): SNode[] {
  const lp = layerPages(s);
  return Object.values(s.nodes).filter((n) => lp.get(n.layer) === pageId);
}

/** Give the scene explicit pages (and every layer a page), so new pages can be added next to the first. */
export function ensurePages(s: Scene): Page[] {
  const lp = layerPages(s);
  s.pages = pagesOf(s).map((p) => ({ ...p }));
  for (const l of s.layers) l.page = lp.get(l.id);
  return s.pages;
}

/** Add a page with one empty floor. */
export function addPage(s: Scene, name?: string): { page: Page; layer: Layer } {
  const pages = ensurePages(s);
  const page = { id: uid('p'), name: name || nextPageName(pages) };
  const layer: Layer = { id: uid('l'), name: 'Ground', visible: true, page: page.id };
  pages.push(page);
  s.layers.push(layer);
  return { page, layer };
}

function nextPageName(pages: Page[]) {
  const names = new Set(pages.map((p) => p.name.toLowerCase()));
  let i = pages.length + 1;
  while (names.has(`page ${i}`)) i++;
  return `Page ${i}`;
}

/** Remove a page with its floors, boxes and their connections. Returns the number of boxes removed. */
export function deletePage(s: Scene, pageId: string): number {
  const pages = ensurePages(s);
  if (pages.length < 2) throw new Error("Can't delete the only page");
  const layers = new Set(pageLayers(s, pageId).map((l) => l.id));
  let n = 0;
  for (const node of Object.values(s.nodes)) if (layers.has(node.layer)) { delete s.nodes[node.id]; n++; }
  for (const e of Object.values(s.edges)) if (!s.nodes[e.from] || !s.nodes[e.to]) delete s.edges[e.id];
  s.layers = s.layers.filter((l) => !layers.has(l.id));
  s.pages = pages.filter((p) => p.id !== pageId);
  return n;
}

/** Connections whose ends sit on different pages (pages are independent, so these aren't allowed). */
export function crossPageEdges(s: Scene) {
  const lp = layerPages(s);
  return Object.values(s.edges).filter((e) => {
    const a = s.nodes[e.from], b = s.nodes[e.to];
    return a && b && lp.get(a.layer) !== lp.get(b.layer);
  });
}

export interface PagePlacement {
  /** Shift added to the page's 2D x to place it in the shared 3D ground. */
  dx: number;
  /** The page's area in 2D coordinates (its boxes, or a default square when empty). */
  x0: number; x1: number; y0: number; y1: number;
}

/** Lay pages out left to right on the 3D ground. The first page stays where it is. */
export function pagePlacements(s: Scene): Map<string, PagePlacement> {
  const lp = layerPages(s);
  const box = new Map<string, [number, number, number, number]>();
  for (const n of Object.values(s.nodes)) {
    const p = lp.get(n.layer);
    if (!p) continue;
    const b = box.get(p);
    if (!b) box.set(p, [n.x, n.x + n.w, n.y, n.y + n.h]);
    else { b[0] = Math.min(b[0], n.x); b[1] = Math.max(b[1], n.x + n.w); b[2] = Math.min(b[2], n.y); b[3] = Math.max(b[3], n.y + n.h); }
  }
  const out = new Map<string, PagePlacement>();
  let cursor = 0;
  pagesOf(s).forEach((p, i) => {
    const [x0, x1, y0, y1] = box.get(p.id) ?? [0, 400, 0, 300];
    const dx = i === 0 ? 0 : cursor - x0;
    out.set(p.id, { dx, x0, x1, y0, y1 });
    cursor = dx + x1 + PAGE_GAP;
  });
  return out;
}

/** Layer id → horizontal shift of its page in 3D. */
export function layerShifts(s: Scene): Map<string, number> {
  const pl = pagePlacements(s);
  const lp = layerPages(s);
  return new Map(s.layers.map((l) => [l.id, pl.get(lp.get(l.id)!)!.dx]));
}
