// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserFakes } from '../../test/browserFakes';
import { Store } from '../../shared/model/store';
import { demoScene } from '../samples/demo';

// Smoke test: the real Viewer3D builds its scene graph from a store and reacts to changes.
// Only the WebGL renderer is faked (jsdom has no GPU); everything else is real three.js.
vi.mock('three', async (orig) => {
  const THREE = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    toneMapping = 0;
    toneMappingExposure = 1;
    renders = 0;
    setPixelRatio() {}
    setSize() {}
    render() { this.renders++; }
    dispose() {}
    getPixelRatio() { return 1; }
  }
  return { ...THREE, WebGLRenderer: FakeRenderer };
});

let store: Store;
let viewer: import('./Viewer3D').Viewer3D;
const hooks = { onHover: vi.fn(), onSim: vi.fn(), onToast: vi.fn() };

beforeAll(async () => {
  installBrowserFakes();
  const { Viewer3D } = await import('./Viewer3D');
  store = new Store();
  store.load(demoScene());
  const host = document.createElement('div');
  document.body.append(host);
  viewer = new Viewer3D(host, store, hooks);
});
afterAll(() => viewer?.stop());

describe('Viewer3D', () => {
  it('mounts a canvas and enters from the 2D view', async () => {
    expect(document.querySelector('canvas')).toBeTruthy();
    await viewer.enter({ cx: 300, cy: 300, width: 1200 });
    expect((viewer as any).renderer.renders).toBeGreaterThan(0);
  });

  it('builds one instance per visible node', () => {
    const meshes = [...((viewer as any).kindMeshes as Map<string, { mesh: { count: number }; ids: string[] }>).values()];
    const ids = meshes.flatMap((k) => k.ids).sort();
    expect(ids).toEqual(Object.keys(store.scene.nodes).sort());
    expect(meshes.reduce((n, k) => n + k.mesh.count, 0)).toBe(ids.length);
  });

  it('follows store changes, journeys, simulation and camera stops without throwing', async () => {
    const id = Object.keys(store.scene.nodes)[0];
    store.update((s) => { s.nodes[id].label = 'Renamed'; });
    store.setJourney(store.scene.journeys[0].id, 2);
    viewer.setFlows(true);
    viewer.setSim(true);
    viewer.focusNode(id);
    viewer.overview(0);
    const stop = viewer.captureStop('Here');
    expect(stop.name).toBe('Here');
    viewer.goTo(stop);
    expect(viewer.snapshot()).toMatch(/^data:image\/png/);
    expect(viewer.kindName(id)).toBeTruthy();
    store.setJourney(null);
    viewer.setSim(false);
  });

  it('leaves back to a 2D view', async () => {
    const v = await viewer.leave();
    expect(v.width).toBeGreaterThan(0);
  });
});
