// Single source of truth: the 2D editor and the 3D viewer both render this model.
// 2D (x, y) is the ground plane; `layer` stacks floors vertically and `height` extrudes.

export type NodeKind = 'service' | 'database' | 'queue' | 'cache' | 'lb' | 'client' | 'zone' | 'text';

export interface SNode {
  id: string;
  kind: NodeKind;
  x: number; // top-left, world px
  y: number;
  w: number;
  h: number;
  layer: string;
  height: number; // 3D extrusion, world px
  color: string; // #rrggbb
  label: string;
  capacity: number; // sim: max rps handled (for clients: rps generated)
  latency: number; // sim: base latency in ms
  down?: boolean; // sim: node killed
}

export interface SEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  mult: number; // sim: downstream calls per request handled
  flow: boolean; // animate particles when not simulating
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** Page this floor belongs to (absent: the first page). */
  page?: string;
}

/** An independent diagram in the scene, with its own floors. See pages.ts. */
export interface Page {
  id: string;
  name: string;
}

export interface Stop {
  id: string;
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
  /** Journey shown while this stop is active (presentations). */
  journey?: string;
}

/** One hop of a journey: an existing connection, walked along its arrow or (`back`) against it, e.g. a response. */
export interface JStep {
  edge: string;
  back?: boolean;
  /** Caption for this hop, e.g. "POST /login". */
  note?: string;
}

/** A user journey: a named, ordered path through the diagram ("Login", "Checkout"). */
export interface Journey {
  id: string;
  name: string;
  color: string;
  steps: JStep[];
}

export interface Scene {
  v: 1;
  nodes: Record<string, SNode>;
  edges: Record<string, SEdge>;
  layers: Layer[]; // index 0 = bottom floor (per page)
  /** Pages in order (absent in scenes saved before pages: one page holding every floor). */
  pages?: Page[];
  stops: Stop[];
  journeys: Journey[];
}

export interface KindDef {
  name: string;
  w: number;
  h: number;
  height: number;
  color: string;
  capacity: number;
  latency: number;
}

export const KINDS: Record<NodeKind, KindDef> = {
  service: { name: 'Service', w: 160, h: 90, height: 70, color: '#4f7cff', capacity: 800, latency: 15 },
  database: { name: 'Database', w: 130, h: 110, height: 90, color: '#f59e0b', capacity: 400, latency: 8 },
  queue: { name: 'Queue', w: 180, h: 70, height: 50, color: '#a855f7', capacity: 1000, latency: 2 },
  cache: { name: 'Cache', w: 120, h: 100, height: 50, color: '#14b8a6', capacity: 5000, latency: 1 },
  lb: { name: 'Load balancer', w: 120, h: 120, height: 40, color: '#22c55e', capacity: 10000, latency: 1 },
  client: { name: 'Client', w: 140, h: 80, height: 30, color: '#94a3b8', capacity: 200, latency: 0 },
  zone: { name: 'Zone', w: 400, h: 260, height: 4, color: '#64748b', capacity: 0, latency: 0 },
  text: { name: 'Text', w: 60, h: 24, height: 0, color: '#e2e8f0', capacity: 0, latency: 0 },
};

/** Kinds that take part in traffic simulation. */
export const SIM_KINDS = new Set<NodeKind>(['service', 'database', 'queue', 'cache', 'lb', 'client']);

export const PALETTE = [
  '#4f7cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7',
  '#14b8a6', '#ec4899', '#94a3b8', '#64748b', '#e2e8f0',
];

/** Journey colors: bright enough to read on top of the regular diagram colors. */
export const JOURNEY_COLORS = ['#f472b6', '#facc15', '#38bdf8', '#4ade80', '#fb923c', '#c084fc'];

export const uid = (p: string) => p + '_' + Math.random().toString(36).slice(2, 10);

export function makeNode(kind: NodeKind, x: number, y: number, layer: string, over: Partial<SNode> = {}): SNode {
  const d = KINDS[kind];
  return {
    id: uid('n'), kind, x, y, w: d.w, h: d.h, layer, height: d.height, color: d.color,
    label: kind === 'text' ? 'Text' : d.name, capacity: d.capacity, latency: d.latency, ...over,
  };
}

export function makeEdge(from: string, to: string, over: Partial<SEdge> = {}): SEdge {
  return { id: uid('e'), from, to, label: '', dashed: false, mult: 1, flow: true, ...over };
}

export function emptyScene(): Scene {
  const page = { id: uid('p'), name: 'Page 1' };
  return { v: 1, nodes: {}, edges: {}, layers: [{ id: uid('l'), name: 'Ground', visible: true, page: page.id }], pages: [page], stops: [], journeys: [] };
}

export const isNodeId = (id: string) => id.startsWith('n_');
export const isEdgeId = (id: string) => id.startsWith('e_');
