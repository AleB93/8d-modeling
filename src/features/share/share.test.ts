// @vitest-environment node
import { encode } from '@ab19993/zip-string';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeShare, encodeShare, ShareView, shareUrl } from './share';
import { SHARE_DICT } from './shareDict';
import { emptyScene, KINDS, makeEdge, makeNode, Scene } from '../../shared/model/types';

/** Encode a scene the way legacy `#s=` links did: deflate-raw JSON, base64url. */
async function legacyCode(scene: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode an arbitrary payload as a `#z=` hash with the share dictionary. */
const zHash = (p: unknown) => '#z=' + encode(p, { dictionary: SHARE_DICT });

function sample(): Scene {
  const s = emptyScene();
  const ground = s.layers[0].id;
  s.layers.push({ id: 'l_hidden', name: 'Roof', visible: false });
  const nodes = [
    makeNode('client', 0, 0, ground, { label: 'Web' }), // custom label
    makeNode('service', 200, 10.5, ground), // all defaults
    makeNode('database', 400, 0, 'l_hidden', { w: 99, h: 98, height: 97, color: '#123456', capacity: 7, latency: 3, down: true }),
    makeNode('text', 0, 300, ground), // default "Text" label
    makeNode('zone', -10, -10, ground),
  ];
  for (const n of nodes) s.nodes[n.id] = n;
  const [web, api, db] = nodes;
  const e1 = makeEdge(web.id, api.id, { label: 'HTTPS' });
  const e2 = makeEdge(api.id, db.id, { dashed: true, mult: 0.3, flow: false });
  s.edges = { [e1.id]: e1, [e2.id]: e2 };
  s.stops = [{ id: 's_1', name: 'Overview', pos: [1, 2, 3], target: [4, 5, 6], journey: 'j_1' }];
  s.journeys = [{
    id: 'j_1', name: 'Login', color: '#38bdf8',
    steps: [{ edge: e1.id, note: 'POST /login' }, { edge: e2.id }, { edge: e2.id, back: true }, { edge: e1.id, back: true, note: '200' }],
  }];
  return s;
}

afterEach(() => vi.unstubAllGlobals());

describe('encodeShare / decodeShare', () => {
  it('round-trips a scene including journeys, hidden layers and every node field', async () => {
    const s = sample();
    const code = encodeShare(s);
    expect(code.startsWith('z=')).toBe(true);
    const out = await decodeShare('#' + code);
    expect(out!.scene).toEqual(s);
    expect(out!.view).toBeUndefined();
  });

  it('strips default fields from the payload so links stay short', () => {
    const s = sample();
    const bare = emptyScene();
    bare.layers = s.layers;
    const one = makeNode('service', 0, 0, s.layers[0].id);
    bare.nodes[one.id] = one;
    // a default node costs less than one with every field overridden
    const custom = structuredClone(bare);
    Object.assign(custom.nodes[one.id], { w: 1, h: 2, height: 3, color: '#abcdef', capacity: 4, latency: 5, label: 'Custom' });
    expect(encodeShare(bare).length).toBeLessThan(encodeShare(custom).length);
  });

  it('normalizes down: false away (a live node has no down flag)', async () => {
    const s = sample();
    const n = Object.values(s.nodes)[0];
    n.down = false;
    const out = (await decodeShare('#' + encodeShare(s)))!.scene;
    expect(out.nodes[n.id]).not.toHaveProperty('down');
    delete n.down;
    expect(out).toEqual(s);
  });

  it('round-trips a scene without journeys', async () => {
    const s = sample();
    s.journeys = [];
    s.stops = [];
    expect((await decodeShare('#' + encodeShare(s)))!.scene).toEqual(s);
  });

  it('carries the view state, dropping defaults and rounding floats', async () => {
    const view: ShareView = {
      mode: 'play',
      view2d: { cx: 1.234, cy: -5.678, width: 800.04 },
      cam: { pos: [1.23456, 2.00049, -3.9999], target: [0, 0.0004, 10] },
      stop: 0,
      sim: true,
      mult: 2.5,
      flows: false,
      sel: ['n_a', 'e_b'],
      journey: { id: 'j_1', step: -1 },
    };
    const out = await decodeShare('#' + encodeShare(sample(), view));
    expect(out!.view).toEqual({
      mode: 'play',
      view2d: { cx: 1.2, cy: -5.7, width: 800 },
      cam: { pos: [1.235, 2, -4], target: [0, 0, 10] },
      stop: 0,
      sim: true,
      mult: 2.5,
      flows: false,
      sel: ['n_a', 'e_b'],
      journey: { id: 'j_1', step: -1 },
    });
  });

  it('leaves out view fields that equal the app default', async () => {
    const out = await decodeShare('#' + encodeShare(sample(), { mode: 'design', sim: false, mult: 1, flows: true, sel: [] }));
    expect(out!.view).toEqual({ mode: 'design' });
  });

  it('accepts a percent-encoded fragment', async () => {
    const s = sample();
    const code = encodeShare(s).slice(2);
    const hash = '#z=' + code.replace(/[^A-Za-z0-9]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    expect((await decodeShare(hash))!.scene).toEqual(s);
  });

  it('defaults missing layer visibility, stops and journeys from hand-made payloads', async () => {
    const out = await decodeShare(zHash({
      v: 2,
      nodes: [{ id: 'n_1', kind: 'cache', x: 1, y: 2, layer: 'l_1' }],
      edges: [{ id: 'e_1', from: 'n_1', to: 'n_1' }],
      layers: [{ id: 'l_1', name: 'G' }],
    }));
    expect(out!.scene).toEqual({
      v: 1,
      nodes: { n_1: { id: 'n_1', kind: 'cache', x: 1, y: 2, layer: 'l_1', ...pick(KINDS.cache), label: 'Cache' } },
      edges: { e_1: { id: 'e_1', from: 'n_1', to: 'n_1', label: '', dashed: false, mult: 1, flow: true } },
      layers: [{ id: 'l_1', name: 'G', visible: true }],
      stops: [],
      journeys: [],
    });
  });

  it('prunes journey steps whose connection is missing', async () => {
    const out = await decodeShare(zHash({
      v: 2, nodes: [], edges: [], layers: [{ id: 'l', name: 'G' }], stops: [],
      journeys: [{ id: 'j', name: 'J', color: '#fff', steps: [{ edge: 'e_gone' }] }],
    }));
    expect(out!.scene.journeys).toEqual([{ id: 'j', name: 'J', color: '#fff', steps: [] }]);
  });

  it('rejects payloads that are not share links', async () => {
    const bad = [null, 7, { v: 1, nodes: [], edges: [] }, { v: 2, nodes: {}, edges: [] }, { v: 2, nodes: [], edges: {} }];
    for (const p of bad) await expect(decodeShare(zHash(p))).rejects.toThrow('Not an 8D modeling share link');
  });

  it('rejects unknown node kinds and scenes without layers', async () => {
    await expect(decodeShare(zHash({ v: 2, nodes: [{ id: 'n', kind: 'robot', x: 0, y: 0, layer: 'l' }], edges: [], layers: [{ id: 'l', name: 'G' }] })))
      .rejects.toThrow('Unknown node kind: robot');
    await expect(decodeShare(zHash({ v: 2, nodes: [], edges: [] }))).rejects.toThrow('Not an 8D modeling scene');
  });

  it('throws on corrupt data', async () => {
    await expect(decodeShare('#z=!!!not-a-link')).rejects.toThrow();
  });

  it('returns null for hashes that are not share links', async () => {
    for (const h of ['', '#', '#z=', '#x=abc', 'z=abc', '#design']) expect(await decodeShare(h)).toBeNull();
  });

  it('still decodes legacy #s= links', async () => {
    const s = sample();
    const out = await decodeShare('#s=' + await legacyCode(s));
    expect(out).toEqual({ scene: s });
  });
});

describe('shareUrl', () => {
  it('puts the encoded scene in the fragment of the current page', async () => {
    vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/app/' });
    const s = sample();
    const url = shareUrl(s, { mode: 'design' });
    expect(url).toBe('https://example.test/app/#' + encodeShare(s, { mode: 'design' }));
    const out = await decodeShare(new URL(url).hash);
    expect(out).toEqual({ scene: s, view: { mode: 'design' } });
  });
});

describe('share links with pages', () => {
  it('round-trips pages and which page each floor is on', async () => {
    const s = emptyScene();
    s.pages!.push({ id: 'p2', name: 'Ops' });
    s.layers.push({ id: 'l2', name: 'Ground', visible: true, page: 'p2' }, { id: 'l3', name: 'Hidden', visible: false, page: 'p2' });
    const back = (await decodeShare('#' + encodeShare(s)))!.scene;
    expect(back.pages).toEqual(s.pages);
    expect(back.layers).toEqual(s.layers);
  });
  it('leaves pages out for scenes saved before pages', async () => {
    const s = emptyScene();
    delete s.pages;
    delete s.layers[0].page;
    const back = (await decodeShare('#' + encodeShare(s)))!.scene;
    expect(back).not.toHaveProperty('pages');
    expect(back.layers[0]).not.toHaveProperty('page');
  });
});

function pick(d: (typeof KINDS)[keyof typeof KINDS]) {
  return { w: d.w, h: d.h, height: d.height, color: d.color, capacity: d.capacity, latency: d.latency };
}
