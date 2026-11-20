// WebMCP adapter: exposes Stratos tools to in-browser AI agents via the page's model context.
//
// Verified against Chrome 157 (chrome://flags/#enable-webmcp-testing): `document.modelContext` with
// registerTool(tool, { signal }) (abort = unregister), getTools(), executeTool(registeredTool) and
// toolchange/toolactivated/toolcancel events. Chrome calls execute(input, { signal }); a returned JSON
// string is parsed for the agent; a thrown Error is reported as status "Error". Agents invoke tools via
// the browser (DevTools protocol domain `WebMCP.invokeTool`).
//
// The API is still moving and older write-ups describe other shapes:
//  - location: `document.modelContext` (newer drafts) vs `navigator.modelContext` (older/deprecated)
//  - registration: `registerTool(tool, { signal })` + AbortController (newer) vs `registerTool(tool)` /
//    `unregisterTool(name)` (older) vs `provideContext({ tools })` (oldest, reportedly removed)
// So this feature-detects every variant and degrades to a no-op when none exists.

import type { ToolDef } from './tools';

export interface WebMCPStatus {
  supported: boolean;
  via: 'document.modelContext' | 'navigator.modelContext' | null;
  method: 'registerTool' | 'provideContext' | null;
  registered: number;
  error?: string;
}

/** Inject an origin-trial token (set VITE_WEBMCP_OT_TOKEN at build time) before feature detection. */
function injectOriginTrial() {
  const token = import.meta.env.VITE_WEBMCP_OT_TOKEN as string | undefined;
  if (!token || document.querySelector(`meta[http-equiv="origin-trial"][content="${token}"]`)) return;
  const m = document.createElement('meta');
  m.httpEquiv = 'origin-trial';
  m.content = token;
  document.head.append(m);
}

function findModelContext(): { mc: any; via: WebMCPStatus['via'] } {
  const d = (document as any).modelContext;
  if (d) return { mc: d, via: 'document.modelContext' };
  const n = (navigator as any).modelContext;
  if (n) return { mc: n, via: 'navigator.modelContext' };
  return { mc: null, via: null };
}

/** Shape a tool for the browser: keep the fields every draft agrees on. */
function toBrowserTool(t: ToolDef) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    // drafts pass (input, client) or (input, { signal }); we only need input
    execute: (input: unknown) => t.execute(input),
  };
}

/** `loadTools` is only called when the browser supports WebMCP, so the tool code stays out of the startup bundle. */
export async function registerWebMCP(loadTools: () => Promise<ToolDef[]>): Promise<{ status: WebMCPStatus; unregister: () => void }> {
  injectOriginTrial();
  const { mc, via } = findModelContext();
  const status: WebMCPStatus = { supported: !!mc, via, method: null, registered: 0 };
  if (!mc) return { status, unregister: () => {} };
  const tools = await loadTools();

  const ctrl = new AbortController();
  const names: string[] = [];
  try {
    if (typeof mc.registerTool === 'function') {
      status.method = 'registerTool';
      for (const t of tools) {
        const bt = toBrowserTool(t);
        try {
          await mc.registerTool(bt, { signal: ctrl.signal });
        } catch (e) {
          // older drafts take a single argument; "already registered" (e.g. dev hot reload) → replace it
          if (typeof mc.unregisterTool === 'function') { try { mc.unregisterTool(t.name); } catch { /* not registered */ } }
          await mc.registerTool(bt);
        }
        names.push(t.name);
      }
    } else if (typeof mc.provideContext === 'function') {
      status.method = 'provideContext';
      await mc.provideContext({ tools: tools.map(toBrowserTool) });
      names.push(...tools.map((t) => t.name));
    } else {
      status.supported = false;
      status.error = 'modelContext found but no known registration method';
    }
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e);
  }
  status.registered = names.length;

  const unregister = () => {
    ctrl.abort();
    if (typeof mc.unregisterTool === 'function') for (const n of names) { try { mc.unregisterTool(n); } catch { /* gone */ } }
    else if (status.method === 'provideContext' && typeof mc.clearContext === 'function') { try { mc.clearContext(); } catch { /* gone */ } }
  };
  return { status, unregister };
}

/**
 * Round trip through the browser: ask the model context which tools it lists, then execute
 * stratos_get_scene via the browser (not our own function) and check the answer parses.
 */
export async function selfTestWebMCP(): Promise<{ ok: boolean; message: string }> {
  const { mc } = findModelContext();
  if (!mc) return { ok: false, message: 'WebMCP is not available in this browser.' };
  try {
    if (typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
      return { ok: true, message: 'Tools registered (this browser version has no getTools/executeTool to test with).' };
    }
    const listed: any[] = await mc.getTools();
    const ours = listed.filter((t) => String(t.name).startsWith('stratos_'));
    if (!ours.length) return { ok: false, message: `The browser lists ${listed.length} tools, none from Stratos.` };
    const probe = ours.find((t) => t.name === 'stratos_get_scene');
    if (!probe) return { ok: false, message: 'stratos_get_scene is not listed by the browser.' };
    const raw = await mc.executeTool(probe);
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const n = Array.isArray(res?.nodes) ? res.nodes.length : null;
    if (n === null) return { ok: false, message: 'Test call returned an unexpected result.' };
    return { ok: true, message: `WebMCP OK: browser lists ${ours.length} Stratos tools; test call read ${n} nodes.` };
  } catch (e) {
    return { ok: false, message: `WebMCP test failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
