import { decode, encode } from '@ab19993/zip-string';
import type { View2D } from '../design/DesignCanvas';
import { decodeScene, validateScene } from '../persistence/persist';
import { Journey, KINDS, Layer, Page, Scene, SEdge, SNode, Stop } from '../../shared/model/types';
import { SHARE_DICT } from './shareDict';

// Share links, no server: everything lives in the URL fragment.
//   #z=<zip-string>  v2: compact scene (arrays, defaults stripped) + optional view state, frozen dictionary
//   #s=<base64url>   v1: deflate-raw JSON scene (still decoded so old links keep working)

/** How the sender was looking at the scene. Every field is optional; absent means the app default. */
export interface ShareView {
  mode: 'design' | 'play';
  /** design mode: 2D viewport */
  view2d?: View2D;
  /** play mode: 3D camera */
  cam?: { pos: [number, number, number]; target: [number, number, number] };
  /** presenting this tour stop (play mode) */
  stop?: number;
  sim?: boolean;
  mult?: number;
  flows?: boolean;
  sel?: string[];
  /** journey on screen (step -1 = whole path) */
  journey?: { id: string; step: number };
}

export interface Shared {
  scene: Scene;
  view?: ShareView;
}

// ---- compact scene: nodes/edges as arrays, fields equal to their defaults left out ----
type CNode = Pick<SNode, 'id' | 'kind' | 'x' | 'y' | 'layer'> & Partial<SNode>;
type CEdge = Pick<SEdge, 'id' | 'from' | 'to'> & Partial<SEdge>;
type CLayer = Pick<Layer, 'id' | 'name'> & Partial<Layer>;
interface Payload { v: 2; nodes: CNode[]; edges: CEdge[]; layers: CLayer[]; pages?: Page[]; stops: Stop[]; journeys?: Journey[]; view?: ShareView }

const NODE_DEFAULT_KEYS = ['w', 'h', 'height', 'color', 'capacity', 'latency'] as const;
const EDGE_DEFAULTS = { label: '', dashed: false, mult: 1, flow: true } as const;
const defaultLabel = (n: Pick<SNode, 'kind'>) => (n.kind === 'text' ? 'Text' : KINDS[n.kind].name);

function packNode(n: SNode): CNode {
  const d = KINDS[n.kind];
  const c: Record<string, unknown> = { ...n };
  for (const k of NODE_DEFAULT_KEYS) if (n[k] === d[k]) delete c[k];
  if (n.label === defaultLabel(n)) delete c.label;
  if (!n.down) delete c.down;
  return c as CNode;
}

function unpackNode(c: CNode): SNode {
  if (!Object.hasOwn(KINDS, c.kind)) throw new Error(`Unknown node kind: ${c.kind}`);
  const d = KINDS[c.kind];
  const n: SNode = {
    id: c.id, kind: c.kind, x: c.x, y: c.y, w: c.w ?? d.w, h: c.h ?? d.h, layer: c.layer,
    height: c.height ?? d.height, color: c.color ?? d.color, label: c.label ?? defaultLabel(c),
    capacity: c.capacity ?? d.capacity, latency: c.latency ?? d.latency,
  };
  if (c.down) n.down = true;
  return n;
}

function packEdge(e: SEdge): CEdge {
  const c: Record<string, unknown> = { ...e };
  for (const k of Object.keys(EDGE_DEFAULTS) as (keyof typeof EDGE_DEFAULTS)[]) if (e[k] === EDGE_DEFAULTS[k]) delete c[k];
  return c as CEdge;
}

const unpackEdge = (c: CEdge): SEdge => ({ ...EDGE_DEFAULTS, ...c });

const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const r3 = (v: [number, number, number]) => v.map((x) => r(x, 3)) as [number, number, number];

/** Drop default values and round camera floats, so the link only carries what differs. */
function packView(v: ShareView): ShareView {
  const o: ShareView = { mode: v.mode };
  if (v.view2d) o.view2d = { cx: r(v.view2d.cx, 1), cy: r(v.view2d.cy, 1), width: r(v.view2d.width, 1) };
  if (v.cam) o.cam = { pos: r3(v.cam.pos), target: r3(v.cam.target) };
  if (v.stop != null) o.stop = v.stop;
  if (v.sim) o.sim = true;
  if (v.mult != null && v.mult !== 1) o.mult = v.mult;
  if (v.flows === false) o.flows = false;
  if (v.sel?.length) o.sel = v.sel;
  if (v.journey) o.journey = v.journey;
  return o;
}

export function encodeShare(scene: Scene, view?: ShareView): string {
  const p: Payload = {
    v: 2,
    nodes: Object.values(scene.nodes).map(packNode),
    edges: Object.values(scene.edges).map(packEdge),
    layers: scene.layers.map((l) => (l.visible ? { id: l.id, name: l.name, ...(l.page ? { page: l.page } : {}) } : { ...l })),
    stops: scene.stops,
  };
  if (scene.pages?.length) p.pages = scene.pages.map((pg) => ({ id: pg.id, name: pg.name }));
  // steps keep only fields that are set, so a short journey costs a few dozen bytes
  if (scene.journeys.length) {
    p.journeys = scene.journeys.map((j) => ({
      ...j, steps: j.steps.map((st) => ({ edge: st.edge, ...(st.back ? { back: true } : {}), ...(st.note ? { note: st.note } : {}) })),
    }));
  }
  if (view) p.view = packView(view);
  return 'z=' + encode(p, { dictionary: SHARE_DICT });
}

/** Full link for the current page. */
export const shareUrl = (scene: Scene, view?: ShareView) => `${location.origin}${location.pathname}#${encodeShare(scene, view)}`;

/** Decode a location.hash (`#z=…` or legacy `#s=…`). Returns null when the hash is not a share link. */
export async function decodeShare(hash: string): Promise<Shared | null> {
  const m = hash.match(/^#([sz])=(.+)$/s);
  if (!m) return null;
  if (m[1] === 's') return { scene: await decodeScene(m[2]) };
  const p = decode<Payload>(decodeURIComponent(m[2]), { dictionary: SHARE_DICT });
  if (!p || p.v !== 2 || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) throw new Error('Not an 8D modeling share link');
  const scene = validateScene({
    v: 1,
    nodes: Object.fromEntries(p.nodes.map((c) => [c.id, unpackNode(c)])),
    edges: Object.fromEntries(p.edges.map((c) => [c.id, unpackEdge(c)])),
    layers: (p.layers ?? []).map((l) => ({ id: l.id, name: l.name, visible: l.visible ?? true, ...(l.page ? { page: l.page } : {}) })),
    ...(p.pages ? { pages: p.pages } : {}),
    stops: p.stops ?? [],
    journeys: p.journeys ?? [],
  });
  return { scene, view: p.view };
}
