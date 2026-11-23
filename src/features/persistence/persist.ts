import { KINDS, NodeKind, Scene, SEdge, SNode } from '../../shared/model/types';

// ---- IndexedDB key/value (autosave) ----
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  return (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('stratos', 1); // legacy name (pre-rename); kept so saved diagrams survive
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch((e) => {
    dbp = null; // a failed open is retried by the next save instead of failing every save until reload
    throw e;
  }));
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
}

export async function idbSet(key: string, val: unknown) {
  const d = await db();
  return new Promise<void>((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---- Legacy #s= share links (deflate-raw + base64url). New links: see share.ts; only decoding is kept. ----
async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeScene(code: string): Promise<Scene> {
  const b = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  const raw = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return validateScene(JSON.parse(new TextDecoder().decode(raw)));
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Set an own key, even "__proto__" (plain assignment would change the prototype instead). */
const put = <T>(o: Record<string, T>, k: string, v: T) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/**
 * Accept anything that was ever a valid scene (autosave, files, share links, agents) and return a scene the
 * app can always render: broken entries are dropped or repaired, never left to crash the editor later.
 * Throws only when there's no scene at all.
 */
export function validateScene(s: any): Scene {
  if (!isObj(s) || !isObj(s.nodes) || !isObj(s.edges) || !Array.isArray(s.layers)) throw new Error('Not an 8D modeling scene');
  const layerIds = new Set<string>();
  const layers = s.layers.filter((l: any) => isObj(l) && typeof l.id === 'string' && !layerIds.has(l.id) && layerIds.add(l.id))
    .map((l: any) => ({ ...l, name: String(l.name ?? 'Floor'), visible: l.visible !== false, ...(typeof l.page === 'string' ? { page: l.page } : {}) }));
  if (!layers.length) throw new Error('Not an 8D modeling scene');
  for (const l of layers) if (typeof l.page !== 'string') delete l.page;

  const nodes: Record<string, SNode> = {};
  for (const [key, n] of Object.entries(s.nodes)) {
    if (!isObj(n) || !Object.hasOwn(KINDS, n.kind)) continue;
    const d = KINDS[n.kind as NodeKind];
    put(nodes, key, {
      ...n, id: key, x: finite(n.x, 0), y: finite(n.y, 0), w: finite(n.w, d.w), h: finite(n.h, d.h), height: finite(n.height, d.height),
      capacity: finite(n.capacity, d.capacity), latency: finite(n.latency, d.latency),
      color: typeof n.color === 'string' ? n.color : d.color, label: String(n.label ?? ''),
      layer: layerIds.has(n.layer) ? n.layer : layers[0].id, // a box on a missing floor goes to the first floor
    } as SNode);
  }
  const edges: Record<string, SEdge> = {};
  for (const [key, e] of Object.entries(s.edges)) {
    if (!isObj(e) || !Object.hasOwn(nodes, e.from) || !Object.hasOwn(nodes, e.to)) continue;
    put(edges, key, { ...e, id: key, label: String(e.label ?? ''), dashed: !!e.dashed, mult: finite(e.mult, 1), flow: e.flow !== false } as SEdge);
  }
  const pageIds = new Set<string>();
  const pages = Array.isArray(s.pages)
    ? s.pages.filter((p: any) => isObj(p) && typeof p.id === 'string' && !pageIds.has(p.id) && pageIds.add(p.id)).map((p: any) => ({ id: p.id, name: String(p.name ?? 'Page') }))
    : [];
  const out: Scene = {
    v: 1, nodes, edges, layers,
    ...(pages.length ? { pages } : {}),
    stops: Array.isArray(s.stops) ? s.stops.filter((st: any) => isObj(st) && Array.isArray(st.pos) && Array.isArray(st.target)) : [],
    journeys: Array.isArray(s.journeys)
      ? s.journeys.filter((j: any) => isObj(j) && typeof j.id === 'string' && Array.isArray(j.steps))
        .map((j: any) => ({ id: j.id, name: String(j.name ?? 'Journey'), color: String(j.color ?? '#f472b6'), steps: j.steps.filter((st: any) => isObj(st) && Object.hasOwn(edges, st.edge)) }))
      : [],
  };
  return out;
}

export function download(name: string, data: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
