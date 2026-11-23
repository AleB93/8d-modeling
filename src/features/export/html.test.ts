import { describe, expect, it } from 'vitest';
import { REVISION } from 'three';
import { sceneToHtml } from './html';
import { emptyScene, makeEdge, makeNode } from '../../shared/model/types';

function sample() {
  const sc = emptyScene();
  const L = sc.layers[0].id;
  const a = makeNode('client', 0, 0, L, { label: 'Web </script><b>' });
  const b = makeNode('service', 200, 0, L, { label: 'API' });
  const e = makeEdge(a.id, b.id, { label: 'POST /login' });
  sc.nodes[a.id] = a;
  sc.nodes[b.id] = b;
  sc.edges[e.id] = e;
  sc.journeys.push({ id: 'j1', name: 'Login', color: '#f472b6', steps: [{ edge: e.id, note: 'POST' }] });
  sc.stops.push({ id: 's1', name: 'Overview', pos: [1, 2, 3], target: [0, 0, 0], journey: 'j1' });
  return sc;
}

function embedded(html: string) {
  const m = html.match(/<script id="scene" type="application\/json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return m![1];
}

describe('sceneToHtml', () => {
  it('produces a standalone document with the default title and generator meta', () => {
    const html = sceneToHtml(emptyScene());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<meta name="generator" content="8D modeling">');
    expect(html).toContain('<title>8D modeling scene</title>');
    expect(html).toContain('<b>8D modeling scene</b>');
  });

  it('escapes the title in <title> and the top bar', () => {
    const html = sceneToHtml(emptyScene(), `Tom & "Jerry" <script>`);
    const esc = 'Tom &amp; &quot;Jerry&quot; &lt;script&gt;';
    expect(html).toContain(`<title>${esc}</title>`);
    expect(html).toContain(`<b>${esc}</b>`);
    expect(html).not.toContain('Tom & "Jerry"');
  });

  it('pins three.js on jsDelivr to the bundled revision', () => {
    const html = sceneToHtml(emptyScene());
    const ver = `0.${REVISION.replace(/\D/g, '')}.0`;
    expect(html).toContain(`https://cdn.jsdelivr.net/npm/three@${ver}/build/three.module.js`);
    expect(html).toContain(`https://cdn.jsdelivr.net/npm/three@${ver}/examples/jsm/`);
  });

  it('embeds the scene as JSON (journeys and stops included) without breaking out of the script tag', () => {
    const sc = sample();
    const html = sceneToHtml(sc, 'Demo');
    const raw = embedded(html);
    expect(raw).not.toContain('<');
    expect(raw).toContain('\\u003c/script>');
    const parsed = JSON.parse(raw);
    // single page: same scene, each floor tagged with its level
    expect(parsed).toEqual({ ...sc, layers: sc.layers.map((l, i) => ({ ...l, lv: i })) });
    expect(parsed.journeys[0]).toEqual({ id: 'j1', name: 'Login', color: '#f472b6', steps: [{ edge: Object.keys(sc.edges)[0], note: 'POST' }] });
    expect(parsed.stops[0].journey).toBe('j1');
    // exactly one closing tag per opened script (the label's </script> was neutralized)
    expect(html.match(/<script/g)!.length).toBe(html.match(/<\/script>/g)!.length);
  });
});

describe('sceneToHtml with pages', () => {
  it('places pages side by side and names floors by page', () => {
    const sc = emptyScene();
    const p2 = { id: 'p2', name: 'Ops' };
    sc.pages!.push(p2);
    sc.layers.push({ id: 'l2', name: 'Ground', visible: true, page: 'p2' });
    const a = makeNode('service', 0, 0, sc.layers[0].id);
    const b = makeNode('service', 0, 0, 'l2');
    sc.nodes[a.id] = a;
    sc.nodes[b.id] = b;
    const parsed = JSON.parse(embedded(sceneToHtml(sc)));
    expect(parsed.layers.map((l: any) => [l.name, l.lv])).toEqual([['Page 1 · Ground', 0], ['Ops · Ground', 0]]);
    expect(parsed.nodes[b.id].x).toBeGreaterThan(a.x + a.w);
    expect(parsed.nodes[a.id].x).toBe(0);
    expect(sc.nodes[b.id].x).toBe(0); // the live scene is untouched
    sc.nodes.orphan = makeNode('service', 5, 0, 'gone'); // a box on a missing floor stays where it is
    expect(JSON.parse(embedded(sceneToHtml(sc))).nodes.orphan.x).toBe(5);
  });
});
