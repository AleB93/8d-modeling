// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserFakes } from '../../test/browserFakes';
import { Store } from '../../shared/model/store';
import { emptyScene } from '../../shared/model/types';
import { DesignCanvas } from './DesignCanvas';

// Smoke test: the real 2D editor turns pointer input into scene changes. Drawing goes to a no-op canvas.

let store: Store;
let canvas: HTMLCanvasElement;
let design: DesignCanvas;
const hooks = { onTool: vi.fn(), onEditLabel: vi.fn(), onToast: vi.fn() };

/** Pointer event at a world position (the view maps world → screen). */
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
  store = new Store();
  store.load(emptyScene());
  design = new DesignCanvas(canvas, store, hooks);
  design.setView({ cx: 0, cy: 0, width: 1200 });
});

describe('DesignCanvas', () => {
  it('draws a service with the service tool', () => {
    design.setTool('service');
    drag(-100, -50, 100, 50);
    const nodes = Object.values(store.scene.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('service');
  });

  it('connects two boxes with the arrow tool', () => {
    design.setTool('service');
    drag(-400, -50, -200, 50);
    design.setTool('service');
    drag(200, -50, 400, 50);
    design.setTool('arrow');
    drag(-300, 0, 300, 0);
    const edges = Object.values(store.scene.edges);
    expect(edges).toHaveLength(1);
    const [a, b] = Object.values(store.scene.nodes).sort((p, q) => p.x - q.x);
    expect(edges[0]).toMatchObject({ from: a.id, to: b.id });
  });

  it('pans and fits without touching the scene', () => {
    design.setTool('hand');
    const before = design.getView();
    drag(0, 0, 100, 0);
    expect(design.getView().cx).not.toBe(before.cx);
    design.fit();
    expect(Object.keys(store.scene.nodes)).toHaveLength(0);
  });
});
