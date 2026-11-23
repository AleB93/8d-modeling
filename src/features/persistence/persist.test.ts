// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeScene, download, idbGet, idbSet, validateScene } from './persist';
import { emptyScene, makeEdge, makeNode, Scene } from '../../shared/model/types';

/** Encode a scene the way legacy `#s=` links did: deflate-raw JSON, base64url. */
async function legacyCode(scene: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sample(): Scene {
  const s = emptyScene();
  const a = makeNode('client', 0, 0, s.layers[0].id, { label: 'Web' });
  const b = makeNode('service', 200, 0, s.layers[0].id);
  const e = makeEdge(a.id, b.id, { label: 'HTTPS' });
  s.nodes = { [a.id]: a, [b.id]: b };
  s.edges = { [e.id]: e };
  s.journeys = [{ id: 'j1', name: 'Login', color: '#38bdf8', steps: [{ edge: e.id, note: 'POST' }, { edge: e.id, back: true }] }];
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('idbGet / idbSet', () => {
  it('stores and reads back values, undefined for missing keys', async () => {
    expect(await idbGet('missing')).toBeUndefined();
    const s = sample();
    await idbSet('scene', s);
    expect(await idbGet<Scene>('scene')).toEqual(s);
    await idbSet('scene', 42);
    expect(await idbGet('scene')).toBe(42);
  });

  describe('errors', () => {
    // The open request is cached per module, so each case loads a fresh copy against a failing indexedDB.
    const fresh = async () => {
      vi.resetModules();
      return import('./persist');
    };
    const later = (f: () => void) => setTimeout(f, 0);

    it('rejects when the database cannot be opened', async () => {
      const err = new Error('blocked');
      vi.stubGlobal('indexedDB', {
        open: () => {
          const r: any = { error: err };
          later(() => r.onerror());
          return r;
        },
      });
      const p = await fresh();
      await expect(p.idbGet('k')).rejects.toBe(err);
      await expect(p.idbSet('k', 1)).rejects.toBe(err); // cached failure
    });

    it('rejects failed reads and writes', async () => {
      const err = new Error('io');
      const db = {
        transaction: () => {
          const tx: any = {
            error: err,
            objectStore: () => ({
              get: () => {
                const r: any = { error: err };
                later(() => r.onerror());
                return r;
              },
              put: () => later(() => tx.onerror()),
            }),
          };
          return tx;
        },
      };
      vi.stubGlobal('indexedDB', {
        open: () => {
          const r: any = { result: db };
          later(() => r.onsuccess());
          return r;
        },
      });
      const p = await fresh();
      await expect(p.idbGet('k')).rejects.toBe(err);
      await expect(p.idbSet('k', 1)).rejects.toBe(err);
    });
  });
});

describe('validateScene', () => {
  it('rejects things that are not scenes', () => {
    const bad = [null, undefined, 'x', 42, {}, { nodes: {} }, { nodes: {}, edges: {} }, { nodes: {}, edges: {}, layers: {} }, { nodes: {}, edges: {}, layers: [] }];
    for (const b of bad) expect(() => validateScene(b)).toThrow('Not an 8D modeling scene');
  });

  it('fills in missing stops and journeys and forces v: 1', () => {
    const s = validateScene({ v: 7, nodes: {}, edges: {}, layers: [{ id: 'l', name: 'G', visible: true }] });
    expect(s.stops).toEqual([]);
    expect(s.journeys).toEqual([]);
    expect(s.v).toBe(1);
    expect(validateScene({ ...emptyScene(), journeys: 'nope' }).journeys).toEqual([]);
  });

  it('keeps existing stops', () => {
    const stops = [{ id: 's', name: 'S', pos: [1, 2, 3], target: [0, 0, 0] }];
    expect(validateScene({ ...emptyScene(), stops }).stops).toEqual(stops);
  });

  it('sanitizes journeys: drops malformed ones, defaults name and color, prunes dangling steps', () => {
    const s = sample();
    const eid = Object.keys(s.edges)[0];
    const out = validateScene({
      ...s,
      journeys: [
        null,
        { id: 5, steps: [] },
        { id: 'nosteps' },
        { id: 'j1', name: 'Login', color: '#000', steps: [{ edge: eid, note: 'a' }, null, { edge: 'e_gone' }, { edge: eid, back: true }], extra: 1 },
        { id: 'j2', name: 12, steps: [] },
      ],
    });
    expect(out.journeys).toEqual([
      { id: 'j1', name: 'Login', color: '#000', steps: [{ edge: eid, note: 'a' }, { edge: eid, back: true }] },
      { id: 'j2', name: '12', color: '#f472b6', steps: [] },
    ]);
    expect(validateScene({ ...s, journeys: [{ id: 'j', steps: [] }] }).journeys[0]).toEqual({ id: 'j', name: 'Journey', color: '#f472b6', steps: [] });
  });
});

describe('decodeScene (legacy #s= links)', () => {
  it('round-trips a deflated scene', async () => {
    const s = sample();
    expect(await decodeScene(await legacyCode(s))).toEqual(s);
  });

  it('decodes base64url with - and _ characters', async () => {
    // a payload big enough to produce both + and / in standard base64
    const s = sample();
    for (let i = 0; i < 40; i++) {
      const n = makeNode('service', i * 37, i * 11, s.layers[0].id, { label: `Node ${i} ~?>` });
      s.nodes[n.id] = n;
    }
    const code = await legacyCode(s);
    expect(code).toMatch(/[-_]/);
    expect(await decodeScene(code)).toEqual(s);
  });

  it('validates the decoded JSON', async () => {
    await expect(decodeScene(await legacyCode({ hello: 1 }))).rejects.toThrow('Not an 8D modeling scene');
  });
});

describe('download', () => {
  it('clicks a temporary link to the blob and revokes it later', () => {
    vi.useFakeTimers();
    const a = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => a) });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const blob = new Blob(['hi']);
    download('scene.json', blob);
    expect(document.createElement).toHaveBeenCalledWith('a');
    expect(create).toHaveBeenCalledWith(blob);
    expect(a).toMatchObject({ href: 'blob:x', download: 'scene.json' });
    expect(a.click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});

describe('validateScene pages', () => {
  it('keeps valid pages and drops broken ones', () => {
    const s: any = emptyScene();
    s.pages = [{ id: 'p1', name: 'One' }, { id: 'p2' }, null, { name: 'no id' }];
    expect(validateScene(s).pages).toEqual([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Page' }]);
  });
  it('removes pages that are empty or not a list', () => {
    const s: any = emptyScene();
    s.pages = [];
    expect(validateScene(s)).not.toHaveProperty('pages');
    s.pages = 'x';
    expect(validateScene(s)).not.toHaveProperty('pages');
  });
});

describe('validateScene repairs', () => {
  it('fills in or fixes every field the app relies on', () => {
    const s = validateScene({
      nodes: {
        a: { kind: 'service', layer: 'l1', x: 'x', y: Infinity, color: 5 },
        bad: { kind: 'bogus', layer: 'l1' },
        nul: null,
      },
      edges: {
        e: { from: 'a', to: 'a', mult: NaN, flow: false, label: 'L', dashed: 1 },
        dangling: { from: 'a', to: 'gone' },
        plain: { from: 'a', to: 'a' },
      },
      layers: [{ id: 'l1', page: 7 }, { id: 'l1', name: 'dup' }, null, { id: 'l2', name: 'Top', visible: false, page: 'p1' }],
      pages: [{ id: 'p1' }, { id: 'p1', name: 'dup' }],
      stops: [{ id: 's', name: 'S', pos: [0, 0, 0], target: [0, 0, 0] }, { id: 'broken' }],
    });
    expect(s.layers).toEqual([{ id: 'l1', name: 'Floor', visible: true }, { id: 'l2', name: 'Top', visible: false, page: 'p1' }]);
    expect(s.pages).toEqual([{ id: 'p1', name: 'Page' }]);
    expect(Object.keys(s.nodes)).toEqual(['a']);
    expect(s.nodes.a).toMatchObject({ id: 'a', x: 0, y: 0, w: 160, color: '#4f7cff', label: '', capacity: 800 });
    expect(s.edges.e).toMatchObject({ id: 'e', label: 'L', dashed: true, mult: 1, flow: false });
    expect(s.edges.plain).toMatchObject({ label: '', dashed: false, mult: 1, flow: true });
    expect(s.edges).not.toHaveProperty('dangling');
    expect(s.stops.map((x) => x.id)).toEqual(['s']);
  });
  it('rejects a scene with no usable floor', () => {
    expect(() => validateScene({ nodes: {}, edges: {}, layers: [null, { name: 'no id' }] })).toThrow('Not an 8D modeling scene');
  });
});
