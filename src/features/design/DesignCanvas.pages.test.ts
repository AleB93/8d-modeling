// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserFakes } from '../../test/browserFakes';
import { Store } from '../../shared/model/store';
import { emptyScene, makeNode, Scene, SNode } from '../../shared/model/types';
import { addPage, pagePlacements } from '../../shared/model/pages';
import { DesignCanvas } from './DesignCanvas';

// The 2D editor draws every page side by side, at the shift each page gets in 3D (pagePlacements).
// Boxes keep page-local coordinates; these tests drive the real editor with pointer events.

let store: Store;
let canvas: HTMLCanvasElement;
let design: DesignCanvas;
let s: Scene;
let a: SNode, b: SNode;
let page2: string, floor1: string, floor2: string;
let dx2: number;
const hooks = { onTool: vi.fn(), onEditLabel: vi.fn(), onToast: vi.fn() };

/** Pointer event at a canvas position (the view maps canvas → screen). */
function pointer(type: string, wx: number, wy: number) {
  const v = design.getView();
  const scale = 1200 / v.width;
  const e = new MouseEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: (wx - v.cx) * scale + 600, clientY: (wy - v.cy) * scale + 400 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  canvas.dispatchEvent(e);
}
const drag = (x0: number, y0: number, x1: number, y1: number) => {
  pointer('pointerdown', x0, y0);
  pointer('pointermove', (x0 + x1) / 2, (y0 + y1) / 2);
  pointer('pointermove', x1, y1);
  pointer('pointerup', x1, y1);
};

beforeEach(() => {
  installBrowserFakes();
  canvas = document.createElement('canvas');
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  document.body.append(canvas);
  // two pages, one box each, both at the same page-local position
  s = emptyScene();
  floor1 = s.layers[0].id;
  const p2 = addPage(s, 'Ops');
  page2 = p2.page.id;
  floor2 = p2.layer.id;
  a = makeNode('service', 0, 0, floor1);
  b = makeNode('service', 0, 0, floor2);
  s.nodes[a.id] = a;
  s.nodes[b.id] = b;
  store = new Store();
  store.load(s);
  store.setActiveLayer(floor1);
  dx2 = pagePlacements(store.scene).get(page2)!.dx;
  design = new DesignCanvas(canvas, store, hooks);
  design.setView({ cx: dx2 / 2, cy: 0, width: dx2 * 2 + 1200 });
});

describe('DesignCanvas with several pages', () => {
  it('places the second page at its 3D shift and keeps scene coordinates page-local', () => {
    expect(dx2).toBeGreaterThan(a.w);
    expect(design.displayNode(a.id)!.x).toBe(0);
    expect(design.displayNode(b.id)!.x).toBe(dx2);
    expect(store.scene.nodes[b.id].x).toBe(0);
  });

  it('selects and moves a box on a page that is not open, in page-local coordinates', () => {
    drag(dx2 + 80, 45, dx2 + 180, 45);
    expect(store.selection.has(b.id)).toBe(true);
    expect(store.activePage).toBe(page2);
    expect(store.scene.nodes[b.id].x).toBe(100);
    expect(store.scene.nodes[a.id].x).toBe(0);
  });

  it('creates a box on the page under the pointer, on that page\'s floor', () => {
    design.setTool('database');
    pointer('pointerdown', dx2 + 80, 400);
    pointer('pointerup', dx2 + 80, 400);
    const n = Object.values(store.scene.nodes).find((x) => x.kind === 'database')!;
    expect(n.layer).toBe(floor2);
    // page-local (the page shift is not stored), within one grid step of the click
    expect(Math.abs(n.x + n.w / 2 - 80)).toBeLessThanOrEqual(10);
  });

  it('refuses a connection between boxes on different pages', () => {
    design.setTool('arrow');
    drag(80, 45, dx2 + 80, 45);
    expect(Object.keys(store.scene.edges)).toHaveLength(0);
  });

  it('fits one page or all of them', () => {
    design.fit(page2);
    expect(design.getView().cx).toBeGreaterThan(dx2);
    design.fit();
    expect(design.getView().cx).toBeGreaterThan(0);
    expect(design.getView().cx).toBeLessThan(dx2);
  });
});
