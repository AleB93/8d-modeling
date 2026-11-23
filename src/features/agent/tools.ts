// Agent-facing tools for 8D modeling. Transport-agnostic: WebMCP registers them today, and a stdio bridge
// or anything else can reuse the same definitions later. Every mutation goes through the store, so an
// agent's edits show up live in 2D/3D and can be undone with Ctrl+Z like any user edit.

import type { Store } from '../../shared/model/store';
import { JOURNEY_COLORS, Journey, JStep, KINDS, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode, uid } from '../../shared/model/types';
import { findPath, stepEnds } from '../journeys/journeys';
import { Simulation } from '../simulation/sim';
import { shareUrl, ShareView } from '../share/share';

export interface AgentUI {
  setMode(m: 'design' | 'play'): Promise<void>;
  focus(nodeId: string): void;
  setSimulation(on: boolean): void;
  setFlows(on: boolean): void;
  fit(): void;
  /** Current mode, camera, tour stop, simulation and selection, for share links. */
  captureView(): ShareView;
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

// ---------------------------------------------------------------- helpers

function resolveLayer(store: Store, s: Scene, ref: string | undefined, created: string[]): string {
  if (!ref) return store.activeLayer;
  const hit = s.layers.find((l) => l.id === ref) ?? s.layers.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit.id;
  const l = { id: uid('l'), name: ref, visible: true };
  s.layers.push(l); // new layers go on top
  created.push(ref);
  return l.id;
}

/** Accepts a node id, a `ref` from the same call, or an exact (case-insensitive) label. */
function resolveNode(s: Scene, ref: string, refs?: Map<string, string>): SNode {
  if (s.nodes[ref]) return s.nodes[ref];
  const fromRef = refs?.get(ref);
  if (fromRef && s.nodes[fromRef]) return s.nodes[fromRef];
  const matches = Object.values(s.nodes).filter((n) => n.label.toLowerCase() === ref.toLowerCase());
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
function journeySteps(s: Scene, start: string, hops: { to: string; note?: string }[]): JStep[] {
  if (!Array.isArray(hops) || !hops.length) throw new ToolError('steps must list at least one hop');
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

/**
 * Layered layout: rank nodes by longest path from sources (clients/entry points first), then place each
 * floor as a block of rows, top floor first, so 2D reads top-down and 3D stacks cleanly.
 */
export function autoLayout(s: Scene, onlyLayers?: Set<string>) {
  const nodes = Object.values(s.nodes).filter((n) => n.kind !== 'zone' && n.kind !== 'text');
  const ids = new Set(nodes.map((n) => n.id));
  const outs = new Map<string, string[]>();
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of Object.values(s.edges)) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const rank = new Map<string, number>();
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of q) rank.set(id, 0);
  const deg = new Map(indeg);
  while (q.length) {
    const id = q.shift()!;
    for (const t of outs.get(id) ?? []) {
      rank.set(t, Math.max(rank.get(t) ?? 0, rank.get(id)! + 1));
      deg.set(t, deg.get(t)! - 1);
      if (deg.get(t) === 0) q.push(t);
    }
  }
  const maxRank = Math.max(0, ...rank.values());
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, maxRank + 1); // nodes caught in cycles

  const GX = 230, GY = 170, FLOOR_GAP = 120;
  let y = 0;
  for (let li = s.layers.length - 1; li >= 0; li--) {
    const layer = s.layers[li];
    const ln = nodes.filter((n) => n.layer === layer.id);
    if (!ln.length) continue;
    const rows = [...new Set(ln.map((n) => rank.get(n.id)!))].sort((a, b) => a - b);
    if (!onlyLayers || onlyLayers.has(layer.id)) {
      rows.forEach((r, ri) => {
        const row = ln.filter((n) => rank.get(n.id) === r).sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
        row.forEach((n, i) => {
          n.x = Math.round((i - (row.length - 1) / 2) * GX - n.w / 2);
          n.y = Math.round(y + ri * GY + (GY - 40 - n.h) / 2);
        });
      });
    }
    y += rows.length * GY + FLOOR_GAP;
  }
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

export function createTools(store: Store, ui: AgentUI): ToolDef[] {
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

  return [
    {
      name: 'modeling8d_get_scene',
      title: 'Read diagram',
      description:
        'Read the current 8D modeling system diagram: floors (layers, index 0 = bottom), nodes (services, databases, queues, caches, load balancers, clients, zones, text) and directed connections. Call this before editing.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: guard(() => {
        const s = store.scene;
        return {
          layers: s.layers.map((l, i) => ({ id: l.id, name: l.name, floor: i, visible: l.visible })),
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
        if (!Array.isArray(nodes) || !nodes.length) throw new ToolError('nodes must be a non-empty array');
        const created: SNode[] = [];
        const newLayers: string[] = [];
        const refs: Record<string, string> = {};
        store.transact((s) => {
          for (const spec of nodes) {
            if (!NODE_KINDS.includes(spec.kind)) throw new ToolError(`Unknown kind "${spec.kind}"`);
            const kind = spec.kind as NodeKind;
            const layer = resolveLayer(store, s, spec.layer, newLayers);
            const d = KINDS[kind];
            const w = spec.w ?? d.w, h = spec.h ?? d.h;
            const pos = spec.x != null && spec.y != null ? { x: spec.x, y: spec.y } : freeSlot(s, layer, w, h, created);
            const n = makeNode(kind, pos.x, pos.y, layer, {
              label: String(spec.label), w, h,
              ...(spec.height != null && { height: spec.height }),
              ...(spec.color && { color: spec.color }),
              ...(spec.capacity != null && { capacity: spec.capacity }),
              ...(spec.latency != null && { latency: spec.latency }),
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
        if (!Array.isArray(edges) || !edges.length) throw new ToolError('edges must be a non-empty array');
        const refMap = new Map(Object.entries(refs ?? {}));
        const made: SEdge[] = [];
        const skipped: string[] = [];
        store.transact((s) => {
          for (const spec of edges) {
            const a = resolveNode(s, String(spec.from), refMap), b = resolveNode(s, String(spec.to), refMap);
            if (a.id === b.id) { skipped.push(`${a.label} → itself`); continue; }
            if (Object.values(s.edges).some((e) => e.from === a.id && e.to === b.id)) { skipped.push(`${a.label} → ${b.label} (exists)`); continue; }
            const e = makeEdge(a.id, b.id, { label: spec.label ?? '', mult: spec.mult ?? 1, dashed: !!spec.async });
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
        const changed: string[] = [];
        const newLayers: string[] = [];
        store.transact((s) => {
          for (const u of updates) {
            const e = s.edges[u.target];
            if (e) {
              if (u.label != null) e.label = String(u.label);
              if (u.mult != null) e.mult = Math.max(0, +u.mult);
              if (u.async != null) e.dashed = !!u.async;
              if (u.from != null) e.from = resolveNode(s, u.from).id;
              if (u.to != null) e.to = resolveNode(s, u.to).id;
              changed.push(e.id);
              continue;
            }
            const n = resolveNode(s, String(u.target));
            for (const k of ['label', 'x', 'y', 'w', 'h', 'height', 'color', 'capacity', 'latency'] as const) {
              if (u[k] != null) (n as any)[k] = k === 'label' || k === 'color' ? String(u[k]) : +u[k];
            }
            if (u.kind != null) {
              if (!NODE_KINDS.includes(u.kind)) throw new ToolError(`Unknown kind "${u.kind}"`);
              n.kind = u.kind;
            }
            if (u.down != null) n.down = !!u.down;
            if (u.layer != null) n.layer = resolveLayer(store, s, u.layer, newLayers);
            changed.push(n.id);
          }
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
        const s = store.scene;
        const ids = targets.map((t) => (s.edges[t] ? t : resolveNode(s, t).id));
        store.select(ids);
        store.deleteSelection();
        return { deleted: ids.length };
      }),
    },
    {
      name: 'modeling8d_layers',
      title: 'Manage floors',
      description: 'Manage floors. Actions: add (names, appended on top), rename (target, name), reorder (names bottom→top, all floors), show/hide (target).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'rename', 'reorder', 'show', 'hide'] },
          names: { type: 'array', items: { type: 'string' } },
          target: { type: 'string', description: 'Layer name or id' },
          name: { type: 'string' },
        },
        required: ['action'],
      },
      execute: guard(({ action, names, target, name }: any) => {
        store.transact((s) => {
          const find = (r: string) => {
            const l = s.layers.find((x) => x.id === r || x.name.toLowerCase() === String(r).toLowerCase());
            if (!l) throw new ToolError(`No layer "${r}"`);
            return l;
          };
          if (action === 'add') for (const nm of names ?? []) s.layers.push({ id: uid('l'), name: nm, visible: true });
          else if (action === 'rename') find(target).name = String(name);
          else if (action === 'show' || action === 'hide') find(target).visible = action === 'show';
          else if (action === 'reorder') {
            const order = (names ?? []).map(find);
            if (order.length !== s.layers.length) throw new ToolError('reorder needs every layer name exactly once, bottom → top');
            s.layers = order;
          } else throw new ToolError(`Unknown action "${action}"`);
        });
        return { layers: store.scene.layers.map((l, i) => ({ name: l.name, floor: i, visible: l.visible })) };
      }),
    },
    {
      name: 'modeling8d_auto_layout',
      title: 'Auto-layout',
      description: 'Arrange nodes neatly: request flow goes top→bottom by dependency depth, each floor forms its own block. Optionally only some floors.',
      inputSchema: { type: 'object', properties: { layers: { type: 'array', items: { type: 'string' } } } },
      execute: guard(({ layers }: { layers?: string[] }) => {
        const find = (r: string) => {
          const l = store.scene.layers.find((x) => x.id === r || x.name.toLowerCase() === r.toLowerCase());
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
        for (const r of down) resolveNode(s, r).down = true;
        const sim = new Simulation();
        sim.multiplier = multiplier;
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
        'Control what the user sees: switch between the 2D editor ("design") and the 3D view ("play"), start/stop the live simulation and animated flows in 3D, and focus a node.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['design', 'play'] },
          simulate: { type: 'boolean' },
          flows: { type: 'boolean' },
          focus: { type: 'string', description: 'Node id or label to center on' },
          fit: { type: 'boolean', description: 'Zoom 2D to fit everything' },
        },
      },
      execute: guard(async ({ mode, simulate, flows, focus, fit }: any) => {
        if (mode) await ui.setMode(mode);
        if (simulate != null) ui.setSimulation(!!simulate);
        if (flows != null) ui.setFlows(!!flows);
        if (focus) ui.focus(resolveNode(store.scene, focus).id);
        if (fit) ui.fit();
        return { ok: true };
      }),
    },
    {
      name: 'modeling8d_journeys',
      title: 'User journeys',
      description:
        'Manage user journeys: named, ordered paths a request takes through the diagram (e.g. "Login", "Checkout"), shown as a numbered, animated path in 2D and 3D. ' +
        'Actions: list (read), create, update (rename/recolor/replace steps), delete, show (put one on screen, optionally focused on a step; omit id to hide). ' +
        'Define a path with `start` (node id or label) and `steps`, each a hop `{to, note}` to the next node. A hop follows the direct connection, or the shortest chain of connections if there is none; ' +
        'hops back toward the caller (responses) walk connections backwards automatically. Connections must already exist (modeling8d_connect).',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'show'] },
          id: { type: 'string', description: 'Journey id or name (update/delete/show)' },
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
            const built = journeySteps(s, start, steps);
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
            const built = steps ? journeySteps(s, start ?? (() => { throw new ToolError('Replacing steps needs `start`'); })(), steps) : null;
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
  ];
}
