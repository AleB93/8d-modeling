// Agent-facing tools for 8D modeling. Transport-agnostic: WebMCP registers them today, and a stdio bridge
// or anything else can reuse the same definitions later. Every mutation goes through the store, so an
// agent's edits show up live in 2D/3D and can be undone with Ctrl+Z like any user edit.

import type { Store } from '../../shared/model/store';
import { emptyScene, JOURNEY_COLORS, Journey, JStep, KINDS, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode, Stop, uid } from '../../shared/model/types';
import { validateScene } from '../persistence/persist';
import { demoScene } from '../samples/demo';
import { findPath, stepEnds } from '../journeys/journeys';
import { Simulation } from '../simulation/sim';
import { shareUrl, ShareView } from '../share/share';
import { autoLayout } from '../../shared/model/layout';
import { addPage, crossPageEdges, deletePage, ensurePages, layerLevels, layerPages, pageLayers, pagesOf } from '../../shared/model/pages';

export interface AgentUI {
  setMode(m: 'design' | 'play'): Promise<void>;
  focus(nodeId: string): void;
  setSimulation(on: boolean): void;
  setFlows(on: boolean): void;
  fit(): void;
  /** Current mode, camera, tour stop, simulation and selection, for share links. */
  captureView(): ShareView;
  /** 3D camera position of the current view (switching to 3D first), carrying the shown journey. */
  captureStop(name: string): Promise<Stop>;
  /** Fly to tour stop `index` (0-based) in 3D. */
  goStop(index: number): Promise<void>;
  /** Start (from the first stop) or end the full-screen tour presentation. */
  present(on: boolean): Promise<void>;
  /** 3D camera reset that frames everything (switches to 3D). */
  overview(): Promise<void>;
  /** Live simulation load multiplier (1 = clients' own rate). */
  setMultiplier(m: number): void;
  /** Animate a journey step by step, as the Play button does. */
  playJourney(id: string): void;
  /** Download the scene for the user. Resolves to the file name. */
  exportFile(format: 'json' | 'html' | 'png'): Promise<string>;
}

export interface ToolDef {
  name: string;
  /** Short human-readable name shown by agent UIs. */
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  /**
   * Resolves to a JSON string (Chrome parses it for the agent). Failures throw, so the agent sees
   * status "Error" instead of a "Completed" call with an error inside.
   */
  execute(input: any): Promise<string>;
}

const NODE_KINDS = ['service', 'database', 'queue', 'cache', 'lb', 'client', 'zone', 'text'] as const;
const SIM_ONLY = ['service', 'database', 'queue', 'cache', 'lb', 'client'];

class ToolError extends Error {}

const ok = (data: unknown) => JSON.stringify(data);

/** A finite number from a number or numeric string, else a clear error. */
function num(v: unknown, what: string, min = -Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${what} must be a number (got ${JSON.stringify(v)})`);
  if (n < min) throw new ToolError(`${what} must be ≥ ${min} (got ${n})`);
  return n;
}

/** A non-empty array of objects, else a clear error. */
function list<T = any>(v: unknown, what: string): T[] {
  if (!Array.isArray(v) || !v.length) throw new ToolError(`${what} must be a non-empty array`);
  v.forEach((x, i) => { if (!x || typeof x !== 'object') throw new ToolError(`${what}[${i}] must be an object`); });
  return v;
}

/** Own-property lookup, so labels like "constructor" never hit Object.prototype. */
const own = <T>(rec: Record<string, T>, k: string): T | undefined => (Object.hasOwn(rec, k) ? rec[k] : undefined);

// ---------------------------------------------------------------- helpers

/** A floor of the open page by name, or any floor by id. */
function findLayer(store: Store, s: Scene, ref: unknown) {
  const r = String(ref);
  return s.layers.find((l) => l.id === r) ?? pageLayers(s, store.activePage).find((l) => String(l.name).toLowerCase() === r.toLowerCase());
}

function resolveLayer(store: Store, s: Scene, ref: unknown, created: string[]): string {
  if (ref == null || ref === '') return store.activeLayer;
  const hit = findLayer(store, s, ref);
  if (hit) return hit.id;
  const l = { id: uid('l'), name: String(ref), visible: true, ...(s.pages?.length ? { page: store.activePage } : {}) };
  s.layers.push(l); // new layers go on top of the open page
  created.push(l.name);
  return l.id;
}

function resolvePage(s: Scene, ref: unknown) {
  const ps = pagesOf(s);
  const k = typeof ref === 'number' || /^\d+$/.test(String(ref)) ? Number(ref) - 1 : -1;
  const p = ps[k] ?? ps.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase());
  if (!p) throw new ToolError(`No page "${ref}" (have: ${ps.map((x) => x.name).join(', ')})`);
  return p;
}

/** Pages are independent diagrams: refuse connections between them. */
function assertSamePage(s: Scene) {
  const bad = crossPageEdges(s)[0];
  if (bad) throw new ToolError(`"${s.nodes[bad.from].label}" and "${s.nodes[bad.to].label}" are on different pages; pages are separate diagrams and can't be connected`);
}

function floorsOut(store: Store) {
  const s = store.scene;
  return pageLayers(s, store.activePage).map((l, i) => ({ name: l.name, floor: i, visible: l.visible }));
}

/** Accepts a node id, a `ref` from the same call, or an exact (case-insensitive) label, preferring boxes on `page`. */
function resolveNodeOn(s: Scene, input: unknown, refs: Map<string, string> | undefined, page: string): SNode {
  if (input == null || input === '') throw new ToolError('Missing node (give an id, ref or label)');
  const ref = String(input);
  const byId = own(s.nodes, ref);
  if (byId) return byId;
  const fromRef = refs?.get(ref);
  if (fromRef && own(s.nodes, fromRef)) return s.nodes[fromRef];
  const all = Object.values(s.nodes).filter((n) => String(n.label).toLowerCase() === ref.toLowerCase());
  const lp = layerPages(s);
  const here = all.filter((n) => lp.get(n.layer) === page);
  const matches = here.length ? here : all;
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ToolError(`"${ref}" matches ${matches.length} nodes (${matches.map((m) => m.id).join(', ')}); use an id`);
  throw new ToolError(`No node "${ref}"`);
}

const layerName = (s: Scene, id: string) => s.layers.find((l) => l.id === id)?.name ?? id;

function resolveJourney(s: Scene, ref: string): Journey {
  const j = s.journeys.find((x) => x.id === ref) ?? s.journeys.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
  if (!j) throw new ToolError(`No journey "${ref}" (have: ${s.journeys.map((x) => x.name).join(', ') || 'none'})`);
  return j;
}

/** start + hops ("go to X, then Y") → steps, following existing connections (backwards for responses). */
function journeySteps(s: Scene, start: unknown, hops: { to: string; note?: string }[], page: string): JStep[] {
  const resolveNode = (sc: Scene, ref: unknown) => resolveNodeOn(sc, ref, undefined, page);
  if (!Array.isArray(hops) || !hops.length) throw new ToolError('steps must list at least one hop');
  list(hops, 'steps');
  let cur = resolveNode(s, start).id;
  const out: JStep[] = [];
  for (const h of hops) {
    const to = resolveNode(s, h.to).id;
    const path = findPath(s, cur, to, new Set(out.map((st) => st.edge)));
    if (!path) throw new ToolError(`"${s.nodes[cur].label}" and "${s.nodes[to].label}" aren't connected; add a connection with modeling8d_connect first`);
    if (!path.length) throw new ToolError(`Hop to "${s.nodes[to].label}" starts and ends on the same node`);
    if (h.note) path[path.length - 1].note = String(h.note);
    out.push(...path);
    cur = to;
  }
  return out;
}

function journeyOut(s: Scene, j: Journey) {
  return {
    id: j.id, name: j.name, color: j.color,
    steps: j.steps.map((st, k) => {
      const ends = stepEnds(s, st);
      return {
        n: k + 1, from: ends ? s.nodes[ends.from]?.label : null, to: ends ? s.nodes[ends.to]?.label : null,
        connection: st.edge, ...(st.back ? { response: true } : {}), ...(st.note ? { note: st.note } : {}),
      };
    }),
  };
}

function nodeOut(s: Scene, n: SNode) {
  return {
    id: n.id, kind: n.kind, label: n.label, layer: layerName(s, n.layer),
    x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h), height: n.height, color: n.color,
    ...(SIM_ONLY.includes(n.kind) ? { capacity: n.capacity, latency: n.latency } : {}),
    ...(n.down ? { down: true } : {}),
  };
}

function edgeOut(s: Scene, e: SEdge) {
  return {
    id: e.id, from: e.from, to: e.to, fromLabel: s.nodes[e.from]?.label, toLabel: s.nodes[e.to]?.label,
    mult: e.mult, ...(e.dashed ? { async: true } : {}), ...(e.label ? { label: e.label } : {}),
  };
}

/** Default spot for a node added without coordinates: next free slot in a row under its floor's content. */
function freeSlot(s: Scene, layer: string, w: number, h: number, placed: SNode[]) {
  const on = Object.values(s.nodes).filter((n) => n.layer === layer && !placed.includes(n));
  const maxY = on.length ? Math.max(...on.map((n) => n.y + n.h)) + 60 : 0;
  const minX = on.length ? Math.min(...on.map((n) => n.x)) : 0;
  const i = placed.filter((n) => n.layer === layer).length;
  return { x: minX + i * 220, y: maxY + (140 - h) / 2 };
}

// ---------------------------------------------------------------- tools

export { autoLayout };

export function createTools(store: Store, ui: AgentUI): ToolDef[] {
  const resolveNode = (s: Scene, ref: unknown, refs?: Map<string, string>) => resolveNodeOn(s, ref, refs, store.activePage);
  const guard = (fn: (input: any) => Promise<unknown> | unknown) => async (input: any) => {
    // agents may send arguments as a JSON string
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { throw new Error('Input must be a JSON object'); }
    }
    return ok(await fn(input ?? {}));
  };

  const nodeFields = {
    label: { type: 'string' },
    layer: { type: 'string', description: 'Layer (floor) name or id. Unknown names create a new top floor.' },
    x: { type: 'number', description: '2D position (world px, top-left). Omit to auto-place.' },
    y: { type: 'number' },
    w: { type: 'number', description: 'Width in world px (defaults per kind, ~120-180)' },
    h: { type: 'number', description: 'Depth in world px' },
    height: { type: 'number', description: '3D extrusion height (default per kind, 30-90)' },
    color: { type: 'string', description: '#rrggbb' },
    capacity: { type: 'number', description: 'Simulation: max requests/s handled. For clients: requests/s generated. For queues: drain rate.' },
    latency: { type: 'number', description: 'Simulation: base latency in ms' },
  };

  const tools: ToolDef[] = [
    {
      name: 'modeling8d_get_scene',
      title: 'Read diagram',
      description:
        'Read the current 8D modeling system diagram: pages (independent diagrams; the open one is where edits go), floors (layers; floor 0 = bottom of its page), nodes (services, databases, queues, caches, load balancers, clients, zones, text) and directed connections. Call this before editing.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: guard(() => {
        const s = store.scene;
        const lp = layerPages(s), lv = layerLevels(s);
        const pageName = new Map(pagesOf(s).map((p) => [p.id, p.name]));
        return {
          pages: pagesOf(s).map((p) => ({ id: p.id, name: p.name, ...(p.id === store.activePage ? { open: true } : {}), floors: pageLayers(s, p.id).length })),
          layers: s.layers.map((l) => ({ id: l.id, name: l.name, page: pageName.get(lp.get(l.id)!), floor: lv.get(l.id), visible: l.visible })),
          nodes: Object.values(s.nodes).map((n) => nodeOut(s, n)),
          edges: Object.values(s.edges).map((e) => edgeOut(s, e)),
          tourStops: s.stops.map((t) => t.name),
          journeys: s.journeys.map((j) => ({ id: j.id, name: j.name, steps: j.steps.length })),
          selection: [...store.selection],
        };
      }),
    },
    {
      name: 'modeling8d_add_nodes',
      title: 'Add components',
      description:
        'Add one or more components to the diagram in a single call. Kinds: service, database, queue, cache, lb (load balancer), client (traffic source), zone (grouping box, e.g. a VPC), text. ' +
        'Give each node a `ref` to connect it in a later modeling8d_connect call. Positions are optional; call modeling8d_auto_layout afterwards for a clean arrangement.',
      inputSchema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['kind', 'label'],
              properties: { ref: { type: 'string', description: 'Your handle for this node, usable in modeling8d_connect' }, kind: { type: 'string', enum: NODE_KINDS }, ...nodeFields },
            },
          },
        },
        required: ['nodes'],
      },
      execute: guard(({ nodes }: { nodes: any[] }) => {
        list(nodes, 'nodes');
        const created: SNode[] = [];
        const newLayers: string[] = [];
        const refs: Record<string, string> = {};
        store.transact((s) => {
          for (const spec of nodes) {
            if (!NODE_KINDS.includes(spec.kind)) throw new ToolError(`Unknown kind "${spec.kind}"`);
            const kind = spec.kind as NodeKind;
            const layer = resolveLayer(store, s, spec.layer, newLayers);
            const d = KINDS[kind];
            const w = spec.w != null ? num(spec.w, 'w', 1) : d.w, h = spec.h != null ? num(spec.h, 'h', 1) : d.h;
            const pos = spec.x != null && spec.y != null ? { x: num(spec.x, 'x'), y: num(spec.y, 'y') } : freeSlot(s, layer, w, h, created);
            const n = makeNode(kind, pos.x, pos.y, layer, {
              w, h,
              ...(spec.label != null && { label: String(spec.label) }),
              ...(spec.height != null && { height: num(spec.height, 'height', 0) }),
              ...(spec.color && { color: String(spec.color) }),
              ...(spec.capacity != null && { capacity: num(spec.capacity, 'capacity', 0) }),
              ...(spec.latency != null && { latency: num(spec.latency, 'latency', 0) }),
            });
            if (kind === 'zone') s.nodes = { [n.id]: n, ...s.nodes };
            else s.nodes[n.id] = n;
            created.push(n);
            if (spec.ref) refs[spec.ref] = n.id;
          }
        });
        store.select(created.map((n) => n.id));
        return { created: created.map((n) => ({ id: n.id, label: n.label, kind: n.kind })), refs, newLayers };
      }),
    },
    {
      name: 'modeling8d_connect',
      title: 'Connect components',
      description:
        'Add directed connections (caller → callee) in one call. `from`/`to` accept a node id, a ref returned by modeling8d_add_nodes, or an exact node label. ' +
        '`mult` = calls to the target per request handled (e.g. 0.3 = 30% of requests hit the DB). Set async=true for fire-and-forget links such as publishing to a queue.',
      inputSchema: {
        type: 'object',
        properties: {
          edges: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['from', 'to'],
              properties: {
                from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' },
                mult: { type: 'number', minimum: 0 }, async: { type: 'boolean' },
              },
            },
          },
          refs: { type: 'object', description: 'Optional ref→id map from modeling8d_add_nodes', additionalProperties: { type: 'string' } },
        },
        required: ['edges'],
      },
      execute: guard(({ edges, refs }: { edges: any[]; refs?: Record<string, string> }) => {
        list(edges, 'edges');
        const refMap = new Map(Object.entries(refs ?? {}));
        const made: SEdge[] = [];
        const skipped: string[] = [];
        store.transact((s) => {
          for (const spec of edges) {
            const a = resolveNode(s, String(spec.from), refMap), b = resolveNode(s, String(spec.to), refMap);
            if (a.id === b.id) { skipped.push(`${a.label} → itself`); continue; }
            const lp = layerPages(s);
            if (lp.get(a.layer) !== lp.get(b.layer)) throw new ToolError(`"${a.label}" and "${b.label}" are on different pages; pages are separate diagrams and can't be connected`);
            if (Object.values(s.edges).some((e) => e.from === a.id && e.to === b.id)) { skipped.push(`${a.label} → ${b.label} (exists)`); continue; }
            const e = makeEdge(a.id, b.id, { label: spec.label != null ? String(spec.label) : '', mult: spec.mult != null ? num(spec.mult, 'mult', 0) : 1, dashed: !!spec.async });
            s.edges[e.id] = e;
            made.push(e);
          }
        });
        return { created: made.map((e) => edgeOut(store.scene, e)), skipped };
      }),
    },
    {
      name: 'modeling8d_update',
      title: 'Update components',
      description:
        'Change existing nodes or connections. Each update targets `target` (id or exact label) and sets any given fields. ' +
        'Nodes: label, layer, x, y, w, h, height, color, capacity, latency, kind, down (true = node failed, for what-if simulations). Connections (target an edge id): label, mult, async, from, to.',
      inputSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['target'],
              properties: {
                target: { type: 'string' }, ...nodeFields,
                kind: { type: 'string', enum: NODE_KINDS }, down: { type: 'boolean' },
                mult: { type: 'number' }, async: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' },
              },
            },
          },
        },
        required: ['updates'],
      },
      execute: guard(({ updates }: { updates: any[] }) => {
        list(updates, 'updates');
        const changed: string[] = [];
        const newLayers: string[] = [];
        store.transact((s) => {
          for (const u of updates) {
            const e = own(s.edges, String(u.target));
            if (e) {
              if (u.label != null) e.label = String(u.label);
              if (u.mult != null) e.mult = num(u.mult, 'mult', 0);
              if (u.async != null) e.dashed = !!u.async;
              if (u.from != null) e.from = resolveNode(s, u.from).id;
              if (u.to != null) e.to = resolveNode(s, u.to).id;
              if (e.from === e.to) throw new ToolError(`A connection can't go from "${s.nodes[e.from].label}" to itself`);
              if (Object.values(s.edges).some((x) => x !== e && x.from === e.from && x.to === e.to))
                throw new ToolError(`"${s.nodes[e.from].label}" → "${s.nodes[e.to].label}" already exists`);
              changed.push(e.id);
              continue;
            }
            const n = resolveNode(s, u.target);
            const mins: Record<string, number> = { w: 1, h: 1, height: 0, capacity: 0, latency: 0 };
            for (const k of ['label', 'x', 'y', 'w', 'h', 'height', 'color', 'capacity', 'latency'] as const) {
              if (u[k] != null) (n as any)[k] = k === 'label' || k === 'color' ? String(u[k]) : num(u[k], k, mins[k]);
            }
            if (u.kind != null) {
              if (!NODE_KINDS.includes(u.kind)) throw new ToolError(`Unknown kind "${u.kind}"`);
              n.kind = u.kind;
            }
            if (u.down != null) n.down = !!u.down;
            if (u.layer != null) n.layer = resolveLayer(store, s, u.layer, newLayers);
            changed.push(n.id);
          }
          assertSamePage(s);
        });
        return { changed, newLayers };
      }),
    },
    {
      name: 'modeling8d_delete',
      title: 'Delete components',
      description: 'Delete nodes (by id or exact label, their connections go too) and/or connections (by edge id). Undoable.',
      inputSchema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['targets'] },
      execute: guard(({ targets }: { targets: string[] }) => {
        if (!Array.isArray(targets) || !targets.length) throw new ToolError('targets must be a non-empty array');
        const s = store.scene;
        const ids = [...new Set(targets.map((t) => (own(s.edges, String(t)) ? String(t) : resolveNode(s, t).id)))];
        store.select(ids);
        store.deleteSelection();
        return { deleted: ids.length };
      }),
    },
    {
      name: 'modeling8d_layers',
      title: 'Manage floors',
      description:
        'Manage the floors of the open page (see modeling8d_pages). Actions: add (names, appended on top), rename (target, name), reorder (names bottom→top, every floor of the page), show/hide (target), ' +
        'delete (target; it must be empty unless deleteNodes is true; a page\'s last floor can\'t be deleted), focus (target, or "all" to stop dimming other floors).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'rename', 'reorder', 'show', 'hide', 'delete', 'focus'] },
          names: { type: 'array', items: { type: 'string' } },
          target: { type: 'string', description: 'Layer name or id ("all" for focus)' },
          name: { type: 'string' },
          deleteNodes: { type: 'boolean', description: 'delete: also delete the boxes on that floor (and their connections)' },
        },
        required: ['action'],
      },
      execute: guard(({ action, names, target, name, deleteNodes }: any) => {
        if (action === 'focus') {
          if (String(target).toLowerCase() === 'all') store.setAllLayers(true);
          else {
            const l = findLayer(store, store.scene, target);
            if (!l) throw new ToolError(`No layer "${target}"`);
            store.focusLayer(l.id);
          }
          return { focus: store.allLayers ? 'all' : store.scene.layers.find((l) => l.id === store.activeLayer)!.name };
        }
        store.transact((s) => {
          const find = (r: string) => {
            const l = findLayer(store, s, r);
            if (!l) throw new ToolError(`No layer "${r}"`);
            return l;
          };
          const page = store.activePage;
          const onPage = pageLayers(s, page);
          if (action === 'add') {
            if (names != null && !Array.isArray(names)) throw new ToolError('names must be an array of floor names');
            for (const nm of names ?? []) s.layers.push({ id: uid('l'), name: String(nm), visible: true, ...(s.pages?.length ? { page } : {}) });
          } else if (action === 'rename') {
            if (name == null || String(name).trim() === '') throw new ToolError('rename needs `name`');
            find(target).name = String(name);
          }
          else if (action === 'show' || action === 'hide') find(target).visible = action === 'show';
          else if (action === 'delete') {
            const l = find(target);
            const own = pageLayers(s, layerPages(s).get(l.id)!);
            if (own.length === 1) throw new ToolError('Can\'t delete the only floor of a page');
            const on = Object.values(s.nodes).filter((n) => n.layer === l.id);
            if (on.length && !deleteNodes) throw new ToolError(`Floor "${l.name}" has ${on.length} ${on.length === 1 ? 'box' : 'boxes'}; pass deleteNodes: true to delete them too, or move them first`);
            for (const n of on) delete s.nodes[n.id];
            for (const e of Object.values(s.edges)) if (!s.nodes[e.from] || !s.nodes[e.to]) delete s.edges[e.id];
            s.layers = s.layers.filter((x) => x.id !== l.id);
          }
          else if (action === 'reorder') {
            const order = (Array.isArray(names) ? names : []).map(find);
            if (order.length !== onPage.length || new Set(order).size !== order.length || order.some((l: any) => !onPage.includes(l)))
              throw new ToolError('reorder needs every floor of the open page exactly once, bottom → top');
            const slots = onPage.map((l) => s.layers.indexOf(l));
            slots.forEach((k, i) => { s.layers[k] = order[i]; });
          } else throw new ToolError(`Unknown action "${action}"`);
        });
        return { page: pagesOf(store.scene).find((p) => p.id === store.activePage)!.name, layers: floorsOut(store) };
      }),
    },
    {
      name: 'modeling8d_auto_layout',
      title: 'Auto-layout',
      description: 'Arrange nodes neatly: request flow goes top→bottom by dependency depth, each floor forms its own block. Optionally only some floors.',
      inputSchema: { type: 'object', properties: { layers: { type: 'array', items: { type: 'string' } } } },
      execute: guard(({ layers }: { layers?: string[] }) => {
        const find = (r: string) => {
          const l = findLayer(store, store.scene, r);
          if (!l) throw new ToolError(`No layer "${r}"`);
          return l.id;
        };
        const only = layers?.length ? new Set(layers.map(find)) : undefined;
        store.transact((s) => autoLayout(s, only));
        ui.fit();
        return { ok: true };
      }),
    },
    {
      name: 'modeling8d_simulate',
      title: 'Simulate traffic',
      description:
        'Run the traffic simulation headlessly and report throughput, error rate, latency and bottlenecks. Does not change the diagram. ' +
        'Use `multiplier` to scale all client traffic (e.g. 2 = double load), and `down` to test failures of specific nodes for this run only.',
      inputSchema: {
        type: 'object',
        properties: {
          multiplier: { type: 'number', minimum: 0, default: 1 },
          seconds: { type: 'number', minimum: 0.1, maximum: 600, default: 10, description: 'Simulated time (queues fill over time)' },
          down: { type: 'array', items: { type: 'string' }, description: 'Node ids/labels to treat as failed for this run' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: guard(({ multiplier = 1, seconds = 10, down = [] }: { multiplier?: number; seconds?: number; down?: string[] }) => {
        const s: Scene = structuredClone(store.scene);
        if (!Array.isArray(down)) throw new ToolError('down must be an array of node ids or labels');
        for (const r of down) resolveNode(s, r).down = true;
        const sim = new Simulation();
        sim.multiplier = num(multiplier, 'multiplier', 0);
        seconds = num(seconds, 'seconds'); // clamped to 0.1…600 below
        const vis = new Set(s.layers.filter((l) => l.visible).map((l) => l.id));
        const steps = Math.min(6000, Math.max(1, Math.round(seconds / 0.1)));
        let r = sim.step(s, 0.1, vis);
        for (let i = 1; i < steps; i++) r = sim.step(s, 0.1, vis);
        const rows = [...r.nodes].map(([id, st]) => ({ id, label: s.nodes[id].label, kind: s.nodes[id].kind, ...st }));
        const pct = (v: number) => Math.round(v * 1000) / 10;
        const bottlenecks = rows
          .filter((x) => x.kind !== 'client' && (x.util > 0.8 || x.drop > 0 || s.nodes[x.id].down || x.backlog > 1))
          .sort((a, b) => b.util - a.util)
          .slice(0, 15)
          .map((x) => ({
            id: x.id, label: x.label, kind: x.kind, rpsIn: Math.round(x.inRps), utilizationPct: pct(x.util),
            droppedPct: pct(x.drop), ...(x.backlog > 1 ? { queued: Math.round(x.backlog) } : {}), ...(s.nodes[x.id].down ? { down: true } : {}),
          }));
        return {
          simulatedSeconds: steps / 10,
          totals: { requestsPerSec: Math.round(r.total.rps), errorPct: pct(r.total.err), avgLatencyMs: Math.round(r.total.lat), clients: r.total.clients },
          clients: rows.filter((x) => x.kind === 'client').map((x) => ({ label: x.label, rps: Math.round(x.inRps), errorPct: pct(x.err), latencyMs: Math.round(x.lat) })),
          bottlenecks,
          note: bottlenecks.length ? undefined : 'No node above 80% utilization.',
        };
      }),
    },
    {
      name: 'modeling8d_view',
      title: 'Change view',
      description:
        'Control what the user sees: switch between the 2D editor ("design") and the 3D view ("play"), start/stop the live simulation and animated flows in 3D, set the live load multiplier, ' +
        'focus a node, zoom 2D to fit, or reset the 3D camera to an overview of everything.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['design', 'play'] },
          simulate: { type: 'boolean' },
          flows: { type: 'boolean' },
          focus: { type: 'string', description: 'Node id or label to center on' },
          fit: { type: 'boolean', description: 'Zoom 2D to fit everything' },
          overview: { type: 'boolean', description: '3D camera reset showing everything (switches to 3D)' },
          multiplier: { type: 'number', minimum: 0, description: 'Live simulation load: 2 = double every client\'s traffic' },
        },
      },
      execute: guard(async ({ mode, simulate, flows, focus, fit, overview, multiplier }: any) => {
        // validate everything before changing anything
        if (mode != null && mode !== 'design' && mode !== 'play') throw new ToolError('mode must be "design" or "play"');
        const mult = multiplier != null ? num(multiplier, 'multiplier', 0) : null;
        const target = focus != null && focus !== '' ? resolveNode(store.scene, focus).id : null;
        if (mode) await ui.setMode(mode);
        if (simulate != null) ui.setSimulation(!!simulate);
        if (flows != null) ui.setFlows(!!flows);
        if (mult != null) ui.setMultiplier(mult);
        if (overview) await ui.overview();
        if (target) ui.focus(target);
        if (fit) ui.fit();
        return { ok: true };
      }),
    },
    {
      name: 'modeling8d_journeys',
      title: 'User journeys',
      description:
        'Manage user journeys: named, ordered paths a request takes through the diagram (e.g. "Login", "Checkout"), shown as a numbered, animated path in 2D and 3D. ' +
        'Actions: list (read), create, update (rename/recolor/replace steps), delete, show (put one on screen, optionally focused on a step; omit id to hide), play (animate it step by step). ' +
        'Define a path with `start` (node id or label) and `steps`, each a hop `{to, note}` to the next node. A hop follows the direct connection, or the shortest chain of connections if there is none; ' +
        'hops back toward the caller (responses) walk connections backwards automatically. Connections must already exist (modeling8d_connect).',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'show', 'play'] },
          id: { type: 'string', description: 'Journey id or name (update/delete/show/play)' },
          name: { type: 'string' },
          color: { type: 'string', description: '#rrggbb (default: next unused journey color)' },
          start: { type: 'string', description: 'Node where the journey starts (create, or update with steps)' },
          steps: {
            type: 'array',
            description: 'Hops in order, each to the next node. Example for a login: start "Web app", steps [{to:"API gateway",note:"POST /login"},{to:"Auth"},{to:"Users DB",note:"check password"},{to:"Web app",note:"200 + session cookie"}]',
            items: { type: 'object', required: ['to'], properties: { to: { type: 'string', description: 'Node id or label' }, note: { type: 'string', description: 'Caption shown for this hop' } } },
          },
          step: { type: 'number', description: 'show: 1-based step to focus (omit for the whole path)' },
        },
      },
      execute: guard(({ action, id, name, color, start, steps, step }: any) => {
        const s = store.scene;
        switch (action) {
          case 'list':
            return { journeys: s.journeys.map((j) => journeyOut(s, j)) };
          case 'create': {
            if (!start) throw new ToolError('create needs `start` and `steps`');
            const built = journeySteps(s, start, steps, store.activePage);
            const used = new Set(s.journeys.map((j) => j.color));
            const j: Journey = {
              id: uid('j'), name: name || `Journey ${s.journeys.length + 1}`,
              color: color || JOURNEY_COLORS.find((c) => !used.has(c)) || JOURNEY_COLORS[s.journeys.length % JOURNEY_COLORS.length],
              steps: built,
            };
            store.update((sc) => { sc.journeys.push(j); });
            store.setJourney(j.id);
            return journeyOut(store.scene, j);
          }
          case 'update': {
            const j = resolveJourney(s, id);
            const built = steps ? journeySteps(s, start ?? (() => { throw new ToolError('Replacing steps needs `start`'); })(), steps, store.activePage) : null;
            store.update((sc) => {
              const x = sc.journeys.find((y) => y.id === j.id)!;
              if (name) x.name = name;
              if (color) x.color = color;
              if (built) x.steps = built;
            });
            return journeyOut(store.scene, store.journeyById(j.id)!);
          }
          case 'delete': {
            const j = resolveJourney(s, id);
            store.update((sc) => { sc.journeys = sc.journeys.filter((y) => y.id !== j.id); });
            return { deleted: j.name };
          }
          case 'show': {
            if (!id) { store.setJourney(null); return { shown: null }; }
            const j = resolveJourney(s, id);
            store.setJourney(j.id, step ? step - 1 : -1);
            return { shown: j.name, step: store.journey!.step + 1 || 'all' };
          }
          case 'play': {
            const j = resolveJourney(s, id);
            if (!j.steps.length) throw new ToolError(`Journey "${j.name}" has no steps`);
            ui.playJourney(j.id);
            return { playing: j.name, steps: j.steps.length };
          }
          default:
            throw new ToolError(`Unknown action "${action}"`);
        }
      }),
    },
    {
      name: 'modeling8d_undo',
      title: 'Undo',
      description: 'Undo the last change (yours or the user\'s). Pass steps to undo several.',
      inputSchema: { type: 'object', properties: { steps: { type: 'number', minimum: 1, maximum: 50, default: 1 } } },
      execute: guard(({ steps = 1 }: { steps?: number }) => {
        let n = 0;
        for (; n < steps && store.canUndo; n++) store.undo();
        return { undone: n };
      }),
    },
    {
      name: 'modeling8d_share_link',
      title: 'Get share link',
      description: 'Get a URL that opens this exact diagram (the whole scene is compressed into the link; nothing is uploaded). By default the link also restores the current view: 2D/3D mode, camera, tour stop, simulation and selection.',
      inputSchema: {
        type: 'object',
        properties: { includeView: { type: 'boolean', default: true, description: 'false = scene only; the recipient opens it in the default view' } },
      },
      annotations: { readOnlyHint: true },
      execute: guard(({ includeView = true }: { includeView?: boolean } = {}) => ({ url: shareUrl(store.scene, includeView ? ui.captureView() : undefined) })),
    },
    {
      name: 'modeling8d_redo',
      title: 'Redo',
      description: 'Redo what undo just took back. Pass steps to redo several.',
      inputSchema: { type: 'object', properties: { steps: { type: 'number', minimum: 1, maximum: 50, default: 1 } } },
      execute: guard(({ steps = 1 }: { steps?: number }) => {
        let n = 0;
        for (; n < steps && store.canRedo; n++) store.redo();
        return { redone: n };
      }),
    },
    {
      name: 'modeling8d_tour',
      title: 'Camera tour',
      description:
        'Manage the 3D camera tour: saved views ("stops") the user can step through or present full screen. ' +
        'Actions: list (read), add (save the current 3D view as a stop; it remembers the journey on screen), update (re-save stop `target` with the current view), ' +
        'rename (target, name), delete (target), reorder (names, every stop once), go (fly to stop `target`), present (start the presentation from stop 1), stop (end it). ' +
        'A `target` is a stop name, its id, or its 1-based number. Use modeling8d_view (focus, overview) and modeling8d_journeys (show) to set up a view before adding it.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'rename', 'delete', 'reorder', 'go', 'present', 'stop'] },
          target: { type: ['string', 'number'], description: 'Stop name, id or 1-based number' },
          name: { type: 'string' },
          names: { type: 'array', items: { type: 'string' }, description: 'reorder: every stop name, in the new order' },
        },
      },
      execute: guard(async ({ action, target, name, names }: any) => {
        const list = () => ({
          stops: store.scene.stops.map((st, i) => ({ n: i + 1, id: st.id, name: st.name, journey: store.journeyById(st.journey)?.name ?? null })),
        });
        const find = (t: unknown): Stop => {
          const stops = store.scene.stops;
          const k = typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) - 1 : -1;
          const st = stops[k] ?? stops.find((x) => x.id === t || x.name.toLowerCase() === String(t).toLowerCase());
          if (!st) throw new ToolError(`No tour stop "${t}"`);
          return st;
        };
        switch (action) {
          case 'list':
            return list();
          case 'add': {
            const st = await ui.captureStop(name || `View ${store.scene.stops.length + 1}`);
            store.update((s) => { s.stops.push(st); });
            return list();
          }
          case 'update': {
            const st = find(target);
            const c = await ui.captureStop(st.name);
            store.update((s) => { const x = s.stops.find((y) => y.id === st.id)!; x.pos = c.pos; x.target = c.target; x.journey = c.journey; });
            return list();
          }
          case 'rename': {
            const st = find(target);
            if (!name) throw new ToolError('rename needs `name`');
            store.update((s) => { s.stops.find((y) => y.id === st.id)!.name = String(name); });
            return list();
          }
          case 'delete': {
            const st = find(target);
            store.update((s) => { s.stops = s.stops.filter((y) => y.id !== st.id); });
            return list();
          }
          case 'reorder': {
            const order = (names ?? []).map(find);
            if (order.length !== store.scene.stops.length || new Set(order).size !== order.length)
              throw new ToolError('reorder needs every stop exactly once');
            store.update((s) => { s.stops = order.map((st: Stop) => s.stops.find((y) => y.id === st.id)!); });
            return list();
          }
          case 'go': {
            const st = find(target);
            await ui.goStop(store.scene.stops.indexOf(st));
            return { at: st.name };
          }
          case 'present':
            if (!store.scene.stops.length) throw new ToolError('Add a tour stop first');
            await ui.present(true);
            return { presenting: true, stops: store.scene.stops.length };
          case 'stop':
            await ui.present(false);
            return { presenting: false };
          default:
            throw new ToolError(`Unknown action "${action}"`);
        }
      }),
    },
    {
      name: 'modeling8d_scene',
      title: 'Whole scene',
      description:
        'Work with the whole diagram. Actions: new (start an empty diagram), demo (load the demo system), load (replace the diagram with `scene`, a JSON object as returned by export), ' +
        'export (format "json" returns the scene; "html" and "png" download a file for the user: a standalone 3D viewer or an image of the current view). ' +
        'new, demo and load can be undone with modeling8d_undo.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['new', 'demo', 'load', 'export'] },
          scene: { type: 'object', description: 'load: a full scene (as returned by export with format "json")' },
          format: { type: 'string', enum: ['json', 'html', 'png'], default: 'json' },
        },
      },
      execute: guard(async ({ action, scene, format = 'json' }: any) => {
        const replace = (next: Scene) => {
          const mark = store.historyMark();
          try {
            store.checkpoint();
            store.load(next, false);
          } catch (e) {
            store.rollback(mark);
            throw new ToolError(`Invalid scene: ${(e as Error).message}`);
          }
          store.select([]);
          ui.fit();
          return { pages: pagesOf(next).length, nodes: Object.keys(next.nodes).length, edges: Object.keys(next.edges).length, floors: next.layers.length };
        };
        switch (action) {
          case 'new':
            return replace(emptyScene());
          case 'demo':
            return replace(demoScene());
          case 'load': {
            let next: Scene;
            try { next = validateScene(scene); } catch (e) { throw new ToolError(`Invalid scene: ${(e as Error).message}`); }
            return replace(next);
          }
          case 'export':
            if (format === 'json') return { scene: store.scene };
            if (format !== 'html' && format !== 'png') throw new ToolError(`Unknown format "${format}"`);
            return { downloaded: await ui.exportFile(format) };
          default:
            throw new ToolError(`Unknown action "${action}"`);
        }
      }),
    },
    {
      name: 'modeling8d_pages',
      title: 'Pages',
      description:
        'Manage pages: independent diagrams in one scene, each with its own floors and boxes (e.g. "Production", "Staging", "Data pipeline"). The 2D editor shows the open page; 3D shows every page side by side on the ground. ' +
        'Adding boxes, floors and journeys acts on the open page, and connections can\'t cross pages. ' +
        'Actions: list (read), add (name; creates it with one floor "Ground" and opens it), open (target), rename (target, name), delete (target; also deletes its boxes), reorder (names, every page once; order left → right in 3D). ' +
        'A `target` is a page name, id or 1-based number.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'open', 'rename', 'delete', 'reorder'] },
          target: { type: ['string', 'number'], description: 'Page name, id or 1-based number' },
          name: { type: 'string' },
          names: { type: 'array', items: { type: 'string' }, description: 'reorder: every page name, in the new order' },
        },
      },
      execute: guard(({ action, target, name, names }: any) => {
        const list = () => {
          const s = store.scene;
          const lp = layerPages(s);
          return {
            pages: pagesOf(s).map((p, i) => ({
              n: i + 1, id: p.id, name: p.name, ...(p.id === store.activePage ? { open: true } : {}),
              floors: pageLayers(s, p.id).map((l) => l.name),
              boxes: Object.values(s.nodes).filter((nd) => lp.get(nd.layer) === p.id).length,
            })),
          };
        };
        switch (action) {
          case 'list':
            return list();
          case 'add': {
            let layer = '';
            store.update((s) => { layer = addPage(s, name ? String(name) : undefined).layer.id; });
            store.focusLayer(layer);
            ui.fit();
            return list();
          }
          case 'open': {
            store.openPage(resolvePage(store.scene, target).id);
            ui.fit();
            return list();
          }
          case 'rename': {
            const p = resolvePage(store.scene, target);
            if (!name) throw new ToolError('rename needs `name`');
            store.update((s) => { ensurePages(s).find((x) => x.id === p.id)!.name = String(name); });
            return list();
          }
          case 'delete': {
            const p = resolvePage(store.scene, target);
            if (pagesOf(store.scene).length < 2) throw new ToolError('Can\'t delete the only page');
            const wasOpen = store.activePage === p.id;
            store.update((s) => { deletePage(s, p.id); });
            if (wasOpen) store.openPage(pagesOf(store.scene)[0].id);
            return list();
          }
          case 'reorder': {
            const order = (names ?? []).map((r: string) => resolvePage(store.scene, r));
            if (order.length !== pagesOf(store.scene).length || new Set(order.map((p: any) => p.id)).size !== order.length)
              throw new ToolError('reorder needs every page exactly once');
            store.update((s) => { const ps = ensurePages(s); s.pages = order.map((p: any) => ps.find((x) => x.id === p.id)!); });
            return list();
          }
          default:
            throw new ToolError(`Unknown action "${action}"`);
        }
      }),
    },
  ];
  // Batch: several calls as one all-or-nothing change that undoes with a single Ctrl+Z.
  const byName = new Map(tools.map((t) => [t.name, t]));
  tools.push({
    name: 'modeling8d_batch',
    title: 'Batch',
    description:
      'Run several tool calls in order as one change: if any call fails, everything is rolled back, and on success the whole batch undoes with a single Ctrl+Z. ' +
      'Each call is { tool, input }; tool names may omit the "modeling8d_" prefix. Returns every call\'s result.',
    inputSchema: {
      type: 'object',
      required: ['calls'],
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', required: ['tool'], properties: { tool: { type: 'string' }, input: { type: 'object' } } },
        },
      },
    },
    execute: guard(async ({ calls }: any) => {
      if (!Array.isArray(calls) || !calls.length) throw new ToolError('calls must be a non-empty array');
      const resolved = calls.map((c: any, i: number) => {
        const t = byName.get(c?.tool) ?? byName.get('modeling8d_' + c?.tool);
        if (!t || t.name === 'modeling8d_batch') throw new ToolError(`Call ${i + 1}: unknown tool "${c?.tool}"`);
        return { t, input: c.input ?? {} };
      });
      const mark = store.historyMark();
      const results: unknown[] = [];
      for (const [i, { t, input }] of resolved.entries()) {
        try {
          results.push(JSON.parse(await t.execute(input)));
        } catch (e) {
          store.rollback(mark);
          throw new ToolError(`Call ${i + 1} (${t.name}) failed, nothing was changed: ${(e as Error).message}`);
        }
      }
      store.squash(mark);
      return { results };
    }),
  });
  return tools;
}
