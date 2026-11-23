// @vitest-environment jsdom
// Adversarial tests for the standalone HTML export: whatever the labels, the embedded scene must stay inside its
// <script type="application/json">, parse back to the "placed" scene, and the title must not inject markup.
import { describe, expect, it } from 'vitest';
import { sceneToHtml } from './html';
import { demoScene } from '../samples/demo';
import { stressScene } from '../samples/stress';
import { layerLevels, layerShifts, pagePlacements, pagesOf, PAGE_GAP } from '../../shared/model/pages';
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
const EVIL = [
  '</script>', '</SCRIPT>', '</script >', '</script\n>', '</ScRiPt/x>', '<!--', '<!-- <script>', '-->', '<script>alert(1)</script>',
  '<!--<script>', ']]>', '<\/script>', '\\</script>', '\\u003c/script>', '\u2028', '\u2029', '\0', '"', "'", '`', '&lt;', '&amp;',
  '<img src=x onerror=alert(1)>', '😀👩‍💻', '\ud800', '\\', '\\\\', '${1}', '</style>', '</title>', '<\u0000/script>', 'x'.repeat(3000),
];

function genScene(seed: number): Scene {
  const R = rng(seed);
  const int = (n: number) => Math.floor(R() * n);
  const pick = <T,>(a: readonly T[]) => a[int(a.length)];
  const str = () => (R() < 0.7 ? pick(EVIL) : pick(EVIL) + pick(EVIL));
  const pages = R() < 0.6 ? Array.from({ length: 1 + int(3) }, (_, i) => ({ id: `p${i}`, name: str() })) : undefined;
  const layers: Layer[] = Array.from({ length: 1 + int(4) }, (_, i) => ({ id: `l${i}`, name: str(), visible: R() < 0.7, ...(pages && R() < 0.8 ? { page: pick(pages).id } : {}) }));
  const nodes: Record<string, SNode> = {};
  for (let i = 0; i < int(10); i++) {
    const kind = pick(KIND_LIST), d = KINDS[kind];
    nodes[`n_${i}`] = { id: `n_${i}`, kind, x: Math.round((R() - 0.5) * 3000), y: Math.round((R() - 0.5) * 3000), w: d.w, h: d.h, layer: pick(layers).id, height: d.height, color: R() < 0.8 ? d.color : str(), label: str(), capacity: d.capacity, latency: d.latency, ...(R() < 0.2 ? { down: true } : {}) };
  }
  const ids = Object.keys(nodes);
  const edges: Scene['edges'] = {};
  if (ids.length) for (let i = 0; i < int(10); i++) edges[`e_${i}`] = { id: `e_${i}`, from: pick(ids), to: pick(ids), label: str(), dashed: R() < 0.3, mult: 1, flow: true };
  const eids = Object.keys(edges);
  const journeys = eids.length ? [{ id: str(), name: str(), color: str(), steps: Array.from({ length: int(4) }, () => ({ edge: pick(eids), note: str(), back: R() < 0.5 })) }] : [];
  const stops = Array.from({ length: int(3) }, (_, i) => ({ id: `s${i}`, name: str(), pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number] }));
  const s: Scene = { v: 1, nodes, edges, layers, stops, journeys };
  if (pages) s.pages = pages;
  return s;
}

/** Parse the export like a browser does and pull the embedded scene back out. */
function parse(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scripts = [...doc.querySelectorAll('script')];
  const data = doc.getElementById('scene');
  return { doc, scripts, scene: JSON.parse(data!.textContent!) as Omit<Scene, 'layers'> & { layers: (Layer & { lv?: number })[] } };
}

/** What the viewer is documented to receive: x shifted per page, layers with lv, names prefixed by page with several pages. */
function placedExpected(s: Scene) {
  const o = JSON.parse(JSON.stringify(s));
  const dx = layerShifts(s), lv = layerLevels(s);
  const pages = pagesOf(s);
  for (const n of Object.values(o.nodes) as SNode[]) n.x += dx.get(n.layer) ?? 0;
  o.layers = s.layers.map((l) => {
    const pg = pages.find((p) => p.id === (l.page && pages.some((q) => q.id === l.page) ? l.page : pages[0].id))!;
    return { ...l, lv: lv.get(l.id), ...(pages.length > 1 ? { name: `${pg.name} · ${l.name}` } : {}) };
  });
  return JSON.parse(JSON.stringify(o));
}

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

describe('sceneToHtml: embed safety under hostile labels', () => {
  it('always exactly 3 <script> elements, the scene JSON parses back to the placed scene (150 seeds)', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const { scripts, scene } = parse(sceneToHtml(s));
      expect(scripts.map((x) => x.type), `seed ${seed}`).toEqual(['importmap', 'application/json', 'module']);
      expect(scene, `seed ${seed}`).toEqual(placedExpected(s));
    }
  });

  it('raw text never contains "<" inside the embedded JSON, nor a stray </script or <!--', () => {
    for (const seed of SEEDS) {
      const html = sceneToHtml(genScene(seed));
      const start = html.indexOf('<script id="scene" type="application/json">') + '<script id="scene" type="application/json">'.length;
      const end = html.indexOf('</script>', start);
      const body = html.slice(start, end);
      expect(body).not.toContain('<');
      expect(() => JSON.parse(body)).not.toThrow();
      expect((html.match(/<\/script/gi) ?? []).length).toBe(3);
      expect((html.match(/<script/gi) ?? []).length).toBe(3);
      expect(html).not.toContain('<!--');
    }
  });

  it('hostile titles stay text: one <title>, no extra elements, text round-trips', () => {
    for (const title of EVIL) {
      const html = sceneToHtml(genScene(3), title);
      const { doc, scripts } = parse(html);
      expect(scripts).toHaveLength(3);
      expect(doc.querySelectorAll('title')).toHaveLength(1);
      expect(doc.querySelectorAll('img, style ~ style')).toHaveLength(0);
      // HTML parsing turns NUL into U+FFFD in <title> (RCDATA) and drops it in body text; that's the parser, not us
      expect(doc.title.replace(/\s+/g, ' ').trim()).toBe(title.replace(/\0/g, '\ufffd').replace(/\s+/g, ' ').trim());
      expect(doc.querySelector('#top b')!.textContent).toBe(title.replace(/\0/g, ''));
    }
  });

  it('body has the fixed set of panels regardless of content (no injected elements)', () => {
    const ref = parse(sceneToHtml(genScene(1))).doc.body.querySelectorAll('*').length;
    for (const seed of SEEDS.slice(0, 40)) {
      expect(parse(sceneToHtml(genScene(seed), EVIL[seed % EVIL.length])).doc.body.querySelectorAll('*').length).toBe(ref);
    }
  });

  it('U+2028/2029 and lone surrogates survive the embed', () => {
    const s = genScene(9);
    const n: SNode = { id: 'n_x', kind: 'service', x: 0, y: 0, w: 1, h: 1, layer: s.layers[0].id, height: 1, color: '#000000', label: '\u2028\u2029\ud800</script>', capacity: 1, latency: 1 };
    s.nodes.n_x = n;
    expect(parse(sceneToHtml(s)).scene.nodes.n_x.label).toBe('\u2028\u2029\ud800</script>');
  });

  it('does not mutate the input scene', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const s = genScene(seed);
      const before = JSON.stringify(s);
      sceneToHtml(s);
      expect(JSON.stringify(s)).toBe(before);
    }
  });
});

describe('sceneToHtml: placement', () => {
  it('single page: x unchanged, names unchanged, lv = index', () => {
    const s = demoScene();
    const { scene } = parse(sceneToHtml(s));
    for (const n of Object.values(s.nodes)) expect(scene.nodes[n.id].x).toBe(n.x);
    expect(scene.layers.map((l) => [l.name, l.lv])).toEqual(s.layers.map((l, i) => [l.name, i]));
  });

  it('multi page: pages placed left to right with exactly PAGE_GAP between their boxes', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const pl = pagePlacements(s);
      const order = pagesOf(s).map((p) => pl.get(p.id)!);
      expect(order[0].dx).toBe(0);
      for (let i = 1; i < order.length; i++) {
        const prev = order[i - 1], cur = order[i];
        expect(cur.x0 + cur.dx - (prev.x1 + prev.dx), `seed ${seed}`).toBe(PAGE_GAP);
      }
      // placed nodes of different pages never overlap horizontally
      const { scene } = parse(sceneToHtml(s));
      const spans = new Map<string, [number, number]>();
      const lp = new Map(s.layers.map((l) => [l.id, l.page && pagesOf(s).some((p) => p.id === l.page) ? l.page : pagesOf(s)[0].id]));
      for (const n of Object.values(scene.nodes)) {
        const p = lp.get(n.layer)!;
        const sp = spans.get(p) ?? [Infinity, -Infinity];
        spans.set(p, [Math.min(sp[0], n.x), Math.max(sp[1], n.x + n.w)]);
      }
      const sorted = [...spans.values()].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBeGreaterThanOrEqual(sorted[i - 1][1]);
    }
  });

  it('lv counts floors within each page from 0', () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const { scene } = parse(sceneToHtml(s));
      const byPage = new Map<string, number[]>();
      const pages = pagesOf(s);
      scene.layers.forEach((l, i) => {
        const p = s.layers[i].page && pages.some((q) => q.id === s.layers[i].page) ? s.layers[i].page! : pages[0].id;
        byPage.set(p, [...(byPage.get(p) ?? []), l.lv!]);
      });
      for (const lvs of byPage.values()) expect(lvs).toEqual(lvs.map((_, i) => i));
    }
  });

  it('stress scene exports and parses back', () => {
    const s = stressScene(1000);
    const { scene } = parse(sceneToHtml(s));
    expect(Object.keys(scene.nodes)).toHaveLength(1000);
  });
});
