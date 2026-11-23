import { JOURNEY_COLORS, makeEdge, makeNode, Scene, uid } from '../../shared/model/types';

/**
 * The demo: three pages, each its own diagram, side by side in 3D.
 * - Shop: a small web stack across three floors (clients → services → data), with journeys and a tour.
 * - Analytics: clickstream ingestion into a warehouse, plus BI queries.
 * - Payments: checkout calling a payment provider and a ledger.
 */
export function demoScene(): Scene {
  const shop = { id: uid('p'), name: 'Shop' };
  const analytics = { id: uid('p'), name: 'Analytics' };
  const payments = { id: uid('p'), name: 'Payments' };
  const data = { id: uid('l'), name: 'Data', visible: true, page: shop.id };
  const svc = { id: uid('l'), name: 'Services', visible: true, page: shop.id };
  const edge = { id: uid('l'), name: 'Edge', visible: true, page: shop.id };

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
  const e = {
    webLb: makeEdge(web.id, lb.id, { label: 'HTTPS' }),
    mobLb: makeEdge(mobile.id, lb.id, { label: 'HTTPS' }),
    lbApi1: makeEdge(lb.id, api1.id),
    lbApi2: makeEdge(lb.id, api2.id),
    api1Redis: makeEdge(api1.id, redis.id, { label: 'get/set' }),
    api2Redis: makeEdge(api2.id, redis.id, { label: 'get/set' }),
    api1Pg: makeEdge(api1.id, pg.id, { mult: 0.3, label: 'SQL' }),
    api2Pg: makeEdge(api2.id, pg.id, { mult: 0.3, label: 'SQL' }),
    api1Q: makeEdge(api1.id, q.id, { mult: 0.2, dashed: true, label: 'publish' }),
    api2Q: makeEdge(api2.id, q.id, { mult: 0.2, dashed: true, label: 'publish' }),
    qWorker: makeEdge(q.id, worker.id, { dashed: true, label: 'consume' }),
    workerPg: makeEdge(worker.id, pg.id, { label: 'SQL' }),
  };
  // ---- Analytics page
  const store = { id: uid('l'), name: 'Storage', visible: true, page: analytics.id };
  const ingest = { id: uid('l'), name: 'Ingest', visible: true, page: analytics.id };
  const clicks = makeNode('client', 0, 0, ingest.id, { label: 'Clickstream', capacity: 800 });
  const bi = makeNode('client', 460, 0, ingest.id, { label: 'BI dashboard', capacity: 20 });
  const collector = makeNode('service', -10, 170, ingest.id, { label: 'Collector', capacity: 1200 });
  const query = makeNode('service', 450, 170, ingest.id, { label: 'Query API', capacity: 100 });
  const stream = makeNode('queue', -20, 420, store.id, { label: 'Event stream', capacity: 1000 });
  const etl = makeNode('service', 210, 410, store.id, { label: 'Stream ETL', capacity: 600, color: '#ec4899' });
  const wh = makeNode('database', 460, 400, store.id, { label: 'Warehouse', capacity: 300 });
  const an = {
    clicks: makeEdge(clicks.id, collector.id, { label: 'events' }),
    collect: makeEdge(collector.id, stream.id, { dashed: true, label: 'append' }),
    consume: makeEdge(stream.id, etl.id, { dashed: true, label: 'consume' }),
    load: makeEdge(etl.id, wh.id, { mult: 0.1, label: 'batch load' }),
    bi: makeEdge(bi.id, query.id, { label: 'SQL' }),
    query: makeEdge(query.id, wh.id, { label: 'scan' }),
  };

  // ---- Payments page
  const pay = { id: uid('l'), name: 'Ground', visible: true, page: payments.id };
  const checkout = makeNode('client', 160, 0, pay.id, { label: 'Checkout', capacity: 60 });
  const payApi = makeNode('service', 150, 170, pay.id, { label: 'Payments API', capacity: 200 });
  const psp = makeNode('service', -40, 360, pay.id, { label: 'Card provider', capacity: 150, latency: 120, color: '#64748b' });
  const ledger = makeNode('database', 360, 350, pay.id, { label: 'Ledger', capacity: 400 });
  const pe = {
    checkout: makeEdge(checkout.id, payApi.id, { label: 'POST /pay' }),
    charge: makeEdge(payApi.id, psp.id, { label: 'charge' }),
    record: makeEdge(payApi.id, ledger.id, { label: 'record' }),
  };

  nodes.push(clicks, bi, collector, query, stream, etl, wh, checkout, payApi, psp, ledger);
  const edges = [...Object.values(e), ...Object.values(an), ...Object.values(pe)];

  return {
    v: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
    layers: [data, svc, edge, store, ingest, pay],
    pages: [shop, analytics, payments],
    stops: [
      { id: uid('s'), name: 'Overview', pos: [21, 27, 40], target: [8, 5, 10] },
      { id: uid('s'), name: 'Data tier', pos: [14, 9, 29], target: [7, 0.5, 18] },
      { id: uid('s'), name: 'Entry point', pos: [3, 18, -8], target: [7, 12, 3] },
    ],
    journeys: [
      {
        id: uid('j'), name: 'Place order', color: JOURNEY_COLORS[0], steps: [
          { edge: e.webLb.id, note: 'POST /orders' },
          { edge: e.lbApi1.id, note: 'route to a healthy API' },
          { edge: e.api1Redis.id, note: 'check session' },
          { edge: e.api1Pg.id, note: 'insert order' },
          { edge: e.api1Q.id, note: 'publish order.created' },
          { edge: e.lbApi1.id, back: true, note: '201 Created' },
          { edge: e.webLb.id, back: true, note: 'show confirmation' },
          { edge: e.qWorker.id, note: 'async: pick up event' },
          { edge: e.workerPg.id, note: 'mark email sent' },
        ],
      },
      {
        id: uid('j'), name: 'Browse (mobile)', color: JOURNEY_COLORS[2], steps: [
          { edge: e.mobLb.id, note: 'GET /products' },
          { edge: e.lbApi2.id },
          { edge: e.api2Redis.id, note: 'cache hit' },
          { edge: e.lbApi2.id, back: true, note: '200 OK' },
          { edge: e.mobLb.id, back: true, note: 'render list' },
        ],
      },
      {
        id: uid('j'), name: 'Pay', color: JOURNEY_COLORS[1], steps: [
          { edge: pe.checkout.id, note: 'POST /pay' },
          { edge: pe.charge.id, note: 'charge the card' },
          { edge: pe.charge.id, back: true, note: 'approved' },
          { edge: pe.record.id, note: 'write ledger entry' },
          { edge: pe.checkout.id, back: true, note: 'receipt' },
        ],
      },
    ],
  };
}
