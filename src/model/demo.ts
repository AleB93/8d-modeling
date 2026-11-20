import { makeEdge, makeNode, Scene, uid } from './types';

/** A small web stack across three floors: clients → services → data. */
export function demoScene(): Scene {
  const data = { id: uid('l'), name: 'Data', visible: true };
  const svc = { id: uid('l'), name: 'Services', visible: true };
  const edge = { id: uid('l'), name: 'Edge', visible: true };

  const web = makeNode('client', 40, 0, edge.id, { label: 'Web app', capacity: 300 });
  const mobile = makeNode('client', 320, 0, edge.id, { label: 'Mobile app', capacity: 200 });
  const lb = makeNode('lb', 200, 150, edge.id, { label: 'Load balancer' });

  const vpc = makeNode('zone', -60, 360, svc.id, { label: 'VPC · services', w: 860, h: 190 });
  const api1 = makeNode('service', -20, 410, svc.id, { label: 'API #1', capacity: 400 });
  const api2 = makeNode('service', 300, 410, svc.id, { label: 'API #2', capacity: 400 });
  const worker = makeNode('service', 600, 410, svc.id, { label: 'Email worker', capacity: 300, color: '#ec4899' });

  const redis = makeNode('cache', -40, 680, data.id, { label: 'Redis' });
  const pg = makeNode('database', 200, 670, data.id, { label: 'Postgres' });
  const q = makeNode('queue', 470, 690, data.id, { label: 'Order events', capacity: 150 });

  const nodes = [web, mobile, lb, vpc, api1, api2, worker, redis, pg, q];
  const edges = [
    makeEdge(web.id, lb.id, { label: 'HTTPS' }),
    makeEdge(mobile.id, lb.id, { label: 'HTTPS' }),
    makeEdge(lb.id, api1.id),
    makeEdge(lb.id, api2.id),
    makeEdge(api1.id, redis.id, { label: 'get/set' }),
    makeEdge(api2.id, redis.id, { label: 'get/set' }),
    makeEdge(api1.id, pg.id, { mult: 0.3, label: 'SQL' }),
    makeEdge(api2.id, pg.id, { mult: 0.3, label: 'SQL' }),
    makeEdge(api1.id, q.id, { mult: 0.2, dashed: true, label: 'publish' }),
    makeEdge(api2.id, q.id, { mult: 0.2, dashed: true, label: 'publish' }),
    makeEdge(q.id, worker.id, { dashed: true, label: 'consume' }),
    makeEdge(worker.id, pg.id, { label: 'SQL' }),
  ];

  return {
    v: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
    layers: [data, svc, edge],
    stops: [
      { id: uid('s'), name: 'Overview', pos: [21, 27, 40], target: [8, 5, 10] },
      { id: uid('s'), name: 'Data tier', pos: [14, 9, 29], target: [7, 0.5, 18] },
      { id: uid('s'), name: 'Entry point', pos: [3, 18, -8], target: [7, 12, 3] },
    ],
  };
}
