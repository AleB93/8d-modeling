// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../shared/model/store';
import { emptyScene } from '../../shared/model/types';
import { AgentUI, autoLayout, createTools, ToolDef } from './tools';

// Pages: independent diagrams; floors and new boxes go to the open page, connections can't cross pages.

let store: Store;
let ui: Record<keyof AgentUI, ReturnType<typeof vi.fn>>;
let tools: Record<string, ToolDef>;

const call = async (name: string, input?: unknown) => JSON.parse(await tools[`modeling8d_${name}`].execute(input));

beforeEach(() => {
  store = new Store();
  ui = {
    setMode: vi.fn(), focus: vi.fn(), setSimulation: vi.fn(), setFlows: vi.fn(), fit: vi.fn(), captureView: vi.fn(),
    captureStop: vi.fn(), goStop: vi.fn(), present: vi.fn(), overview: vi.fn(), setMultiplier: vi.fn(), playJourney: vi.fn(), exportFile: vi.fn(),
  };
  tools = Object.fromEntries(createTools(store, ui as unknown as AgentUI).map((t) => [t.name, t]));
});

async function twoPages() {
  await call('add_nodes', { nodes: [{ kind: 'client', label: 'Web' }, { kind: 'service', label: 'API' }] });
  await call('connect', { edges: [{ from: 'Web', to: 'API' }] });
  await call('pages', { action: 'add', name: 'Analytics' });
  await call('add_nodes', { nodes: [{ kind: 'queue', label: 'Events' }, { kind: 'database', label: 'Warehouse' }] });
}

describe('modeling8d_pages', () => {
  it('lists, adds and opens pages', async () => {
    expect((await call('pages', { action: 'list' })).pages).toEqual([{ n: 1, id: expect.any(String), name: 'Page 1', open: true, floors: ['Ground'], boxes: 0 }]);
    await twoPages();
    const r = await call('pages', { action: 'list' });
    expect(r.pages.map((p: any) => [p.name, p.open ?? false, p.boxes])).toEqual([['Page 1', false, 2], ['Analytics', true, 2]]);
    expect(ui.fit).toHaveBeenCalled();
    await call('pages', { action: 'open', target: 1 });
    expect(store.activePage).toBe(r.pages[0].id);
    await call('pages', { action: 'open', target: 'analytics' });
    expect(store.activePage).toBe(r.pages[1].id);
    await call('pages', { action: 'open', target: r.pages[0].id });
    expect(store.activePage).toBe(r.pages[0].id);
    await expect(call('pages', { action: 'open', target: 'Nope' })).rejects.toThrow('No page "Nope" (have: Page 1, Analytics)');
    expect((await call('pages', { action: 'add' })).pages[2].name).toBe('Page 3');
  });

  it('renames, reorders and deletes pages', async () => {
    await twoPages();
    let r = await call('pages', { action: 'rename', target: 2, name: 'Data' });
    expect(r.pages[1].name).toBe('Data');
    await expect(call('pages', { action: 'rename', target: 2 })).rejects.toThrow('rename needs `name`');
    r = await call('pages', { action: 'reorder', names: ['Data', 'Page 1'] });
    expect(r.pages.map((p: any) => p.name)).toEqual(['Data', 'Page 1']);
    await expect(call('pages', { action: 'reorder', names: ['Data'] })).rejects.toThrow('reorder needs every page exactly once');
    await expect(call('pages', { action: 'reorder', names: ['Data', 'Data'] })).rejects.toThrow('reorder needs every page exactly once');
    await expect(call('pages', { action: 'reorder' })).rejects.toThrow('reorder needs every page exactly once');
    r = await call('pages', { action: 'delete', target: 'Data' }); // the open one: another page opens
    expect(r.pages).toEqual([expect.objectContaining({ name: 'Page 1', open: true, boxes: 2 })]);
    await call('pages', { action: 'add', name: 'Spare' });
    await call('pages', { action: 'open', target: 1 });
    r = await call('pages', { action: 'delete', target: 'Spare' });
    expect(r.pages).toHaveLength(1);
    await expect(call('pages', { action: 'delete', target: 1 })).rejects.toThrow("Can't delete the only page");
    await expect(call('pages', { action: 'fly' })).rejects.toThrow('Unknown action "fly"');
  });

  it('works on scenes saved before pages', async () => {
    const s = emptyScene();
    delete s.pages;
    delete s.layers[0].page;
    store.load(s);
    await call('layers', { action: 'add', names: ['Top'] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'New', layer: 'Fresh' }] });
    expect(store.scene.layers.every((l) => l.page === undefined)).toBe(true);
    await call('pages', { action: 'rename', target: 1, name: 'Main' });
    expect(store.scene.pages).toEqual([{ id: 'p_main', name: 'Main' }]);
  });
});

describe('page-aware tools', () => {
  it('reports pages and per-page floors in get_scene', async () => {
    await twoPages();
    const r = await call('get_scene');
    expect(r.pages.map((p: any) => [p.name, p.open ?? false, p.floors])).toEqual([['Page 1', false, 1], ['Analytics', true, 1]]);
    expect(r.layers.map((l: any) => [l.name, l.page, l.floor])).toEqual([['Ground', 'Page 1', 0], ['Ground', 'Analytics', 0]]);
  });

  it('puts floors and boxes on the open page, resolving names there', async () => {
    await twoPages();
    const analytics = store.activePage;
    let r = await call('layers', { action: 'add', names: ['Batch'] });
    expect(r).toEqual({ page: 'Analytics', layers: [{ name: 'Ground', floor: 0, visible: true }, { name: 'Batch', floor: 1, visible: true }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'ETL', layer: 'Ground' }, { kind: 'service', label: 'Spark', layer: 'Streaming' }] });
    const pageOf = (label: string) => store.scene.layers.find((l) => l.id === Object.values(store.scene.nodes).find((n) => n.label === label)!.layer)!.page;
    expect(pageOf('ETL')).toBe(analytics);
    expect(pageOf('Spark')).toBe(analytics);
    r = await call('layers', { action: 'reorder', names: ['Streaming', 'Batch', 'Ground'] });
    expect(r.layers.map((l: any) => l.name)).toEqual(['Streaming', 'Batch', 'Ground']);
    expect(store.scene.layers[0].name).toBe('Ground'); // Page 1's floor keeps its slot
    await expect(call('layers', { action: 'reorder', names: ['Streaming', 'Batch', 'Batch'] })).rejects.toThrow('every floor of the open page');
    const page1Ground = store.scene.layers[0].id;
    await expect(call('layers', { action: 'reorder', names: ['Streaming', 'Batch', page1Ground] })).rejects.toThrow('every floor of the open page');
    await call('layers', { action: 'focus', target: 'Batch' });
    expect(store.activePage).toBe(analytics);
    await call('auto_layout', { layers: ['Batch'] });
    await expect(call('layers', { action: 'delete', target: page1Ground })).rejects.toThrow("Can't delete the only floor of a page");
  });

  it('refuses connections across pages', async () => {
    await twoPages();
    await expect(call('connect', { edges: [{ from: 'Events', to: 'API' }] })).rejects.toThrow('"Events" and "API" are on different pages');
    const e = Object.values(store.scene.edges)[0];
    await expect(call('update', { updates: [{ target: e.id, to: 'Events' }] })).rejects.toThrow('"Web" and "Events" are on different pages');
    // moving a connected box to another page's floor would break its connection
    const otherGround = store.scene.layers[0].id;
    await call('pages', { action: 'open', target: 2 });
    await expect(call('update', { updates: [{ target: 'Web', layer: store.scene.layers[1].id }] })).rejects.toThrow('different pages');
    expect(Object.values(store.scene.nodes).find((n) => n.label === 'Web')!.layer).toBe(otherGround);
  });

  it('lays out each page on its own', async () => {
    await twoPages();
    autoLayout(store.scene);
    const mid = (label: string) => { const n = Object.values(store.scene.nodes).find((x) => x.label === label)!; return n.y + n.h / 2; };
    expect(mid('Web')).toBe(mid('Events')); // both pages start at the top
  });
});

describe('labels on several pages', () => {
  it('resolve on the open page first, then anywhere', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'API' }, { kind: 'database', label: 'DB' }] });
    await call('pages', { action: 'add', name: 'Two' });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'API' }] });
    await call('connect', { edges: [{ from: 'API', to: 'DB' }] }).catch((e: Error) => expect(e.message).toContain('different pages'));
    await call('add_nodes', { nodes: [{ kind: 'database', label: 'DB' }] });
    const r = await call('connect', { edges: [{ from: 'API', to: 'DB' }] });
    const two = store.activePage;
    const pageOf = (id: string) => store.scene.layers.find((l) => l.id === store.scene.nodes[id].layer)!.page;
    expect(pageOf(r.created[0].from)).toBe(two);
    await call('journeys', { action: 'create', name: 'J', start: 'API', steps: [{ to: 'DB' }] });
    await call('pages', { action: 'open', target: 1 });
    await expect(call('view', { focus: 'API' })).resolves.toEqual({ ok: true });
    expect(pageOf(ui.focus.mock.calls[0][0])).toBe(store.activePage);
  });
});
