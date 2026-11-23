import type { ToolDef } from './tools';

// The same agent tools as WebMCP, exposed as a plain JavaScript API on `window.modeling8d`.
// Any agent that can run JavaScript in the page (Claude in Chrome, Playwright, the DevTools console)
// can drive the app this way, in every browser, without the WebMCP flag.
//
//   await modeling8d.help()                                  // how to use it + every tool's input schema
//   await modeling8d.tools.modeling8d_get_scene()            // or modeling8d.call('get_scene')
//   await modeling8d.call('add_nodes', { nodes: [...] })     // the "modeling8d_" prefix is optional
//   await modeling8d.batch([{ tool: 'add_nodes', input }, { tool: 'connect', input }])  // all-or-nothing, one undo step
//
// Results are parsed JSON. Failures resolve to { error } instead of throwing, so an agent reading the
// return value always sees what went wrong; nothing is changed when a call fails.

export interface ToolInfo { name: string; title: string; description: string; readOnly: boolean; inputSchema: Record<string, unknown> }
export interface PageApi {
  readonly version: string;
  /** URL of the agent guide (llms.txt). */
  readonly docs: string;
  help(): Promise<{ about: string; docs: string; usage: string[]; tools: ToolInfo[] }>;
  list(): Promise<ToolInfo[]>;
  call(name: string, input?: unknown): Promise<unknown>;
  /** Several calls as one change: all-or-nothing, and a single Ctrl+Z undoes them all. */
  batch(calls: { tool: string; input?: unknown }[]): Promise<unknown>;
  /** `tools.<name>(input)`, for every tool name (with or without the "modeling8d_" prefix). */
  readonly tools: Record<string, (input?: unknown) => Promise<unknown>>;
}

const PREFIX = 'modeling8d_';
export const API_VERSION = '1';

export function createPageApi(loadTools: () => Promise<ToolDef[]>, docs: string): PageApi {
  let loaded: Promise<Map<string, ToolDef>> | null = null;
  const tools = () => (loaded ??= loadTools().then((ts) => new Map(ts.map((t) => [t.name, t]))));
  const info = (t: ToolDef): ToolInfo => ({
    name: t.name, title: t.title, description: t.description, readOnly: !!t.annotations?.readOnlyHint, inputSchema: t.inputSchema,
  });

  const call = async (name: string, input: unknown = {}) => {
    const all = await tools();
    const t = all.get(name) ?? all.get(PREFIX + name);
    if (!t) return { error: `Unknown tool "${name}". Available: ${[...all.keys()].join(', ')}` };
    try {
      return JSON.parse(await t.execute(input));
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const list = async () => [...(await tools()).values()].map(info);

  return {
    version: API_VERSION,
    docs,
    list,
    call,
    batch: (calls) => call('batch', { calls }),
    help: async () => ({
      about: '8D modeling: system architecture diagrams in 2D and 3D. These tools edit the diagram open in this tab; every change shows live and can be undone with Ctrl+Z.',
      docs,
      usage: [
        'Read first: await modeling8d.call("get_scene")',
        'Then edit: add_nodes → connect → auto_layout; journeys for user paths; simulate for load; tour for camera stops',
        'Group edits with modeling8d.batch([{ tool, input }, ...]): all-or-nothing, one undo step',
        'Results are JSON; a failed call returns { error } and changes nothing',
        'Share the result: await modeling8d.call("share_link")',
      ],
      tools: await list(),
    }),
    tools: new Proxy({} as PageApi['tools'], {
      get: (_t, name) => (typeof name === 'string' ? (input?: unknown) => call(name, input) : undefined),
    }),
  };
}

/** Install on window (non-enumerable, read-only), and return it. */
export function installPageApi(loadTools: () => Promise<ToolDef[]>, docs: string, target: object = window): PageApi {
  const api = createPageApi(loadTools, docs);
  Object.defineProperty(target, 'modeling8d', { value: api, configurable: true });
  return api;
}
