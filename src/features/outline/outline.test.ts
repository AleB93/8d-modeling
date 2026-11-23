import { describe, expect, it } from 'vitest';
import { emptyScene, makeEdge, makeNode, Scene } from '../../shared/model/types';
import { sceneOutline } from './outline';

function scene(): Scene {
  const s = emptyScene();
  const bottom = s.layers[0];
  const top = { id: 'top', name: 'Edge', visible: false };
  s.layers.push(top);
  const web = makeNode('client', 0, 0, top.id, { label: 'Web' });
  const api = makeNode('service', 300, 200, bottom.id, { label: 'API', down: true });
  const db = makeNode('database', 0, 200, bottom.id, { label: 'DB' });
  const note = makeNode('text', 0, 500, bottom.id, { label: '' });
  for (const n of [web, api, db, note]) s.nodes[n.id] = n;
  const e1 = makeEdge(web.id, api.id, { label: 'HTTPS' });
  const e2 = makeEdge(api.id, db.id, { dashed: true });
  const e3 = makeEdge(api.id, 'gone');
  for (const e of [e1, e2, e3]) s.edges[e.id] = e;
  s.journeys.push({ id: 'j1', name: 'Login', color: '#fff', steps: [{ edge: e1.id, note: 'POST' }, { edge: e1.id, back: true }] });
  return s;
}

describe('sceneOutline', () => {
  const o = sceneOutline(scene());

  it('summarises the diagram', () => {
    expect(o.summary).toBe('Diagram with 4 boxes, 3 connections, 2 floors and 1 journey.');
    expect(sceneOutline(emptyScene()).summary).toBe('Diagram with 0 boxes, 0 connections, 1 floor and 0 journeys.');
  });

  it('lists floors top first and marks hidden ones', () => {
    expect(o.floors.map((f) => f.text)).toEqual(['Floor Edge (hidden)', `Floor ${scene().layers[0].name}`]);
  });

  it('orders boxes top-left first, with kind, down state and unnamed notes', () => {
    expect(o.floors[1].nodes.map((n) => n.text)).toEqual(['DB, database', 'API, service, down', '(unnamed), note']);
  });

  it('lists outgoing connections with label, async and missing targets', () => {
    expect(o.floors[0].nodes[0].links.map((l) => l.text)).toEqual(['→ API (HTTPS)']);
    expect(o.floors[1].nodes[1].links.map((l) => l.text)).toEqual(['→ DB, async', '→ (unnamed)']);
  });

  it('describes journeys step by step', () => {
    expect(o.journeys).toEqual([{ id: 'j1', text: 'Login (2 steps)', steps: ['Web → API: POST', 'API → Web (response)'] }]);
  });
});
