import { JOURNEY_COLORS, JStep, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode, Stop, uid } from '../../shared/model/types';
import { autoLayout } from '../../shared/model/layout';
import { FLOOR_GAP, layerLevels, layerShifts, WORLD_SCALE } from '../../shared/model/pages';

// The demo: "Dishdash", a food-delivery platform. Each page is one subsystem, its own diagram, and in 3D
// the four stand side by side like buildings on a campus:
//   Ordering   customers browse restaurants and place orders
//   Delivery   couriers stream locations; dispatch matches orders to couriers
//   Payments   checkout, fraud screening, card provider, ledger and payouts
//   Analytics  clickstream into a warehouse, dashboards and model training
// Pages are independent (no connections between them); in the real system they'd talk through events.

type Hop = [edge: SEdge, note?: string, back?: boolean];

export function demoScene(): Scene {
  const s: Scene = { v: 1, nodes: {}, edges: {}, layers: [], pages: [], stops: [], journeys: [] };
  let floors: Record<string, string> = {};

  const page = (name: string, floorNames: string[]) => {
    const p = { id: uid('p'), name };
    s.pages!.push(p);
    floors = {};
    for (const f of floorNames) { // bottom → top
      const l = { id: uid('l'), name: f, visible: true, page: p.id };
      s.layers.push(l);
      floors[f] = l.id;
    }
    return p;
  };
  const node = (floor: string, kind: NodeKind, label: string, over: Partial<SNode> = {}) => {
    const n = makeNode(kind, 0, 0, floors[floor], { label, ...over });
    s.nodes[n.id] = n;
    return n;
  };
  const link = (a: SNode, b: SNode, label = '', over: Partial<SEdge> = {}) => {
    const e = makeEdge(a.id, b.id, { label, ...over });
    s.edges[e.id] = e;
    return e;
  };
  const journey = (name: string, color: string, hops: Hop[]) => {
    const j = { id: uid('j'), name, color, steps: hops.map(([e, note, back]): JStep => ({ edge: e.id, ...(back ? { back } : {}), ...(note ? { note } : {}) })) };
    s.journeys.push(j);
    return j;
  };
  const async = { dashed: true };

  // ---------------------------------------------------------------- Ordering
  const ordering = page('Ordering', ['Data', 'Services', 'Edge']);
  const app = node('Edge', 'client', 'Customer app', { capacity: 450 });
  const web = node('Edge', 'client', 'Web', { capacity: 150 });
  const gw = node('Edge', 'service', 'API gateway', { capacity: 2500, latency: 3, color: '#22c55e' }); // routes, fanning out by path
  const auth = node('Services', 'service', 'Auth', { capacity: 900 });
  const catalog = node('Services', 'service', 'Restaurants', { capacity: 700 });
  const search = node('Services', 'service', 'Search', { capacity: 240, latency: 40 }); // the bottleneck at 2× load
  const cart = node('Services', 'service', 'Cart', { capacity: 600 });
  const orders = node('Services', 'service', 'Orders', { capacity: 400, latency: 25 });
  const users = node('Data', 'database', 'Users DB');
  const menus = node('Data', 'database', 'Menus DB');
  const redis = node('Data', 'cache', 'Redis');
  const index = node('Data', 'database', 'Search index', { capacity: 300 });
  const ordersDb = node('Data', 'database', 'Orders DB', { capacity: 350 });
  const events = node('Data', 'queue', 'Order events', { capacity: 300 });
  const o = {
    app: link(app, gw, 'HTTPS'),
    web: link(web, gw, 'HTTPS'),
    auth: link(gw, auth, 'verify token'),
    catalog: link(gw, catalog, 'GET /restaurants', { mult: 0.6 }),
    search: link(gw, search, 'GET /search', { mult: 0.3 }),
    cart: link(gw, cart, 'cart', { mult: 0.3 }),
    orders: link(gw, orders, 'POST /orders', { mult: 0.08 }),
    users: link(auth, users, 'sessions', { mult: 0.1 }),
    authCache: link(auth, redis, 'token cache'),
    menus: link(catalog, menus, 'SQL', { mult: 0.2 }),
    menuCache: link(catalog, redis, 'menu cache'),
    index: link(search, index, 'query'),
    cartCache: link(cart, redis, 'get/set'),
    ordersDb: link(orders, ordersDb, 'insert'),
    publish: link(orders, events, 'order.created', async),
  };
  const placeOrder = journey('Place an order', JOURNEY_COLORS[0], [
    [o.app, 'POST /orders'], [o.orders, 'route to Orders'], [o.ordersDb, 'insert order'], [o.ordersDb, 'saved', true],
    [o.publish, 'publish order.created'], [o.publish, 'ack', true], [o.orders, '201 Created', true], [o.app, 'show “order placed”', true],
  ]);
  journey('Find a restaurant', JOURNEY_COLORS[2], [
    [o.app, 'search “sushi”'], [o.search], [o.index, 'full-text query'], [o.index, 'matches', true], [o.search, 'top 20', true],
    [o.catalog, 'open restaurant'], [o.menuCache, 'menu (cache hit)'], [o.menuCache, undefined, true], [o.catalog, 'menu', true],
    [o.app, 'render', true],
  ]);

  // ---------------------------------------------------------------- Delivery
  const delivery = page('Delivery', ['Data', 'Services', 'Edge']);
  const courier = node('Edge', 'client', 'Courier app', { capacity: 300 });
  const tablet = node('Edge', 'client', 'Restaurant tablet', { capacity: 40 });
  const ingest = node('Services', 'service', 'Location ingest', { capacity: 800, latency: 5 });
  const geo = node('Services', 'service', 'Geo updater', { capacity: 600, latency: 5 });
  const dispatch = node('Services', 'service', 'Dispatch', { capacity: 120, latency: 60 });
  const eta = node('Services', 'service', 'ETA model', { capacity: 200, latency: 35, color: '#ec4899' });
  const notify = node('Services', 'service', 'Notifications', { capacity: 300 });
  const stream = node('Data', 'queue', 'Location stream', { capacity: 900 });
  const geoIndex = node('Data', 'cache', 'Geo index');
  const dispatchDb = node('Data', 'database', 'Dispatch DB');
  const push = node('Data', 'service', 'Push provider', { capacity: 500, latency: 90, color: '#64748b' });
  const d = {
    courier: link(courier, ingest, 'GPS every 4s'),
    stream: link(ingest, stream, 'append', async),
    geo: link(stream, geo, 'consume', async),
    geoIndex: link(geo, geoIndex, 'update position'),
    ready: link(tablet, dispatch, 'order ready'),
    nearby: link(dispatch, geoIndex, 'couriers nearby'),
    eta: link(dispatch, eta, 'estimate'),
    assign: link(dispatch, dispatchDb, 'assign'),
    notify: link(dispatch, notify, 'notify courier'),
    push: link(notify, push, 'push'),
  };
  const assignCourier = journey('Assign a courier', JOURNEY_COLORS[4], [
    [d.ready, 'order is ready'], [d.nearby, 'who is close?'], [d.nearby, '3 couriers', true], [d.eta, 'pick the fastest'],
    [d.eta, '6 min away', true], [d.assign, 'save assignment'], [d.assign, undefined, true], [d.notify], [d.push, '“new pickup”'],
  ]);

  // ---------------------------------------------------------------- Payments
  const payments = page('Payments', ['Data', 'Services', 'Edge']);
  const checkout = node('Edge', 'client', 'Checkout', { capacity: 60 });
  const payApi = node('Services', 'service', 'Payments API', { capacity: 250 });
  const fraud = node('Services', 'service', 'Fraud check', { capacity: 250, latency: 30, color: '#ef4444' });
  const payouts = node('Services', 'service', 'Payout worker', { capacity: 50 });
  const psp = node('Data', 'service', 'Card provider', { capacity: 200, latency: 180, color: '#64748b' });
  const ledger = node('Data', 'database', 'Ledger', { capacity: 400 });
  const payoutQ = node('Data', 'queue', 'Payouts', { capacity: 40 });
  const bank = node('Data', 'service', 'Bank API', { capacity: 40, latency: 400, color: '#64748b' });
  const p = {
    pay: link(checkout, payApi, 'POST /pay'),
    fraud: link(payApi, fraud, 'score'),
    charge: link(payApi, psp, 'charge card'),
    record: link(payApi, ledger, 'record'),
    queue: link(payApi, payoutQ, 'schedule payout', { ...async, mult: 0.5 }),
    work: link(payoutQ, payouts, 'consume', async),
    bank: link(payouts, bank, 'transfer'),
    settle: link(payouts, ledger, 'settle'),
  };
  const pay = journey('Pay', JOURNEY_COLORS[1], [
    [p.pay, 'POST /pay'], [p.fraud, 'risk score'], [p.fraud, 'low risk', true], [p.charge, 'charge the card'],
    [p.charge, 'approved', true], [p.record, 'ledger entry'], [p.record, undefined, true], [p.pay, 'receipt', true],
  ]);

  // ---------------------------------------------------------------- Analytics
  const analytics = page('Analytics', ['Storage', 'Processing', 'Sources']);
  const clicks = node('Sources', 'client', 'Clickstream', { capacity: 1200 });
  const bi = node('Sources', 'client', 'BI dashboards', { capacity: 15 });
  const collector = node('Processing', 'service', 'Collector', { capacity: 1500, latency: 4 });
  const etl = node('Processing', 'service', 'Stream ETL', { capacity: 1600, color: '#ec4899' });
  const queryApi = node('Processing', 'service', 'Query API', { capacity: 40, latency: 300 });
  const training = node('Processing', 'service', 'Model training', { capacity: 5, latency: 2000, color: '#a855f7' });
  const evStream = node('Storage', 'queue', 'Event stream', { capacity: 1500 });
  const lake = node('Storage', 'database', 'Data lake', { capacity: 2000 });
  const warehouse = node('Storage', 'database', 'Warehouse', { capacity: 120 });
  const a = {
    clicks: link(clicks, collector, 'events'),
    append: link(collector, evStream, 'append', async),
    consume: link(evStream, etl, 'consume', async),
    lake: link(etl, lake, 'raw files'),
    load: link(etl, warehouse, 'load tables', { mult: 0.05 }),
    bi: link(bi, queryApi, 'SQL'),
    scan: link(queryApi, warehouse, 'scan'),
    train: link(training, lake, 'read features'),
  };
  journey('Daily report', JOURNEY_COLORS[3], [
    [a.bi, 'open “orders per city”'], [a.scan, 'aggregate yesterday'], [a.scan, 'rows', true], [a.bi, 'chart', true],
  ]);

  // ---------------------------------------------------------------- layout, zones, tour
  autoLayout(s);
  // a VPC box around each page's services
  for (const pg of s.pages!) {
    const layer = s.layers.find((l) => l.page === pg.id && (l.name === 'Services' || l.name === 'Processing'))!;
    const ns = Object.values(s.nodes).filter((n) => n.layer === layer.id);
    const pad = 40;
    const x0 = Math.min(...ns.map((n) => n.x)) - pad, y0 = Math.min(...ns.map((n) => n.y)) - pad - 20;
    const x1 = Math.max(...ns.map((n) => n.x + n.w)) + pad, y1 = Math.max(...ns.map((n) => n.y + n.h)) + pad;
    const z = makeNode('zone', x0, y0, layer.id, { label: `VPC · ${pg.name.toLowerCase()}`, w: x1 - x0, h: y1 - y0 });
    s.nodes = { [z.id]: z, ...s.nodes }; // zones first, so they draw under the boxes
  }
  s.stops = [
    cameraOn(s, 'Campus overview', Object.values(s.nodes), undefined, 3.2),
    cameraOn(s, 'Ordering', pageNodes(s, ordering.id), placeOrder.id),
    cameraOn(s, 'Delivery', pageNodes(s, delivery.id), assignCourier.id),
    cameraOn(s, 'Payments', pageNodes(s, payments.id), pay.id),
    cameraOn(s, 'Analytics', pageNodes(s, analytics.id)),
  ];
  return s;
}

const pageNodes = (s: Scene, pageId: string) => Object.values(s.nodes).filter((n) => s.layers.find((l) => l.id === n.layer)?.page === pageId);

/** A tour stop framing `nodes` in 3D from the same 3/4 angle as the app's overview. */
function cameraOn(s: Scene, name: string, nodes: SNode[], journey?: string, zoomOut = 2.4): Stop {
  const dx = layerShifts(s), lv = layerLevels(s);
  const S = WORLD_SCALE;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const x = (n.x + dx.get(n.layer)!) * S, y = lv.get(n.layer)! * FLOOR_GAP * S, z = n.y * S;
    const pts = [[x, y, z], [x + n.w * S, y + n.height * S, z + n.h * S]];
    for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  }
  const target = lo.map((v, i) => (v + hi[i]) / 2) as [number, number, number];
  const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  const dist = radius * zoomOut; // in radii; wide shots need more room for the side panels
  const dir = [0.3, 0.62, 0.78], len = Math.hypot(...dir);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const pos = target.map((t, i) => r2(t + (dir[i] / len) * dist)) as [number, number, number];
  return { id: uid('s'), name, pos, target: target.map(r2) as [number, number, number], ...(journey ? { journey } : {}) };
}

/** Labels of the demo shipped before pages. A saved scene that is still exactly that demo gets the new one. */
const LEGACY_DEMO = ['API #1', 'API #2', 'Email worker', 'Load balancer', 'Mobile app', 'Order events', 'Postgres', 'Redis', 'VPC · services', 'Web app'];

export function isLegacyDemo(s: unknown): boolean {
  const sc = s as Partial<Scene> | null;
  if (!sc || typeof sc !== 'object' || sc.pages || !sc.nodes || typeof sc.nodes !== 'object') return false;
  const labels = Object.values(sc.nodes).map((n) => n?.label).sort();
  return JSON.stringify(labels) === JSON.stringify(LEGACY_DEMO);
}
