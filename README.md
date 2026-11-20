# Stratos — system modeling in 3D

Draw your architecture in 2D (Excalidraw-style), press **Tab**, and it rises into 3D, where you can run traffic through it.
Runs entirely in the browser: no server, no account.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
```

## Modes

**Design (2D)**: Canvas2D editor. Tools: select, pan, connect, service, database, queue, cache, load balancer, client, zone, text.
Snapping and alignment guides, resize handles, marquee selection, copy/paste/duplicate, undo/redo, inline labels.
Layers are floors: the top of the list is the top floor in 3D.

**Play (3D)**: three.js view of the same model.
- **Flows**: particles travel along every connection.
- **Simulate**: clients emit traffic. Nodes handle up to their capacity and drop the rest. Edges fan out by "calls per request". Load balancers split load across healthy targets. Queues buffer and act as an async boundary. Latency grows with utilization. Kill a node (**X**) to watch failover and cascading errors.
- **3D editing**: drag a node to move it, Alt+drag to change its height. Every change is shared with the 2D view.
- **Tour**: save camera stops, then **Present** (←/→ to step, Esc to exit).

Press **?** in the app for all shortcuts.

## AI agent tools (WebMCP)

Stratos registers its editing tools with the browser through **WebMCP**, so an in-browser AI agent can build and analyze diagrams in the open tab. There's no server: the tools run in the page against the live store, so you watch every change happen and can undo it with Ctrl+Z. A green **Agent tools** pill in the top bar shows when the browser exposes the API.

| Tool | What it does |
|---|---|
| `stratos_get_scene` | Read floors, nodes and connections (read-only) |
| `stratos_add_nodes` | Batch-add components; `ref`s can be used in `stratos_connect`; layers are auto-created by name |
| `stratos_connect` | Batch-add directed connections (by id, ref or label), with calls-per-request and async |
| `stratos_update` | Change node/edge fields, move between floors, mark nodes `down` |
| `stratos_delete` | Remove nodes/edges |
| `stratos_layers` | Add / rename / reorder / show / hide floors |
| `stratos_auto_layout` | Lay nodes out by dependency depth, each floor in its own block |
| `stratos_simulate` | Run the traffic simulation headlessly (load multiplier, what-if failures) → totals + bottlenecks (read-only) |
| `stratos_view` | Switch 2D/3D, toggle simulation/flows, focus a node |
| `stratos_undo` | Undo recent changes |
| `stratos_share_link` | URL with the whole scene compressed into it (read-only) |

Each tool call applies fully or not at all: if anything in a batch fails, the scene is restored.

**Status:** verified end to end in Chrome 157 with `chrome://flags/#enable-webmcp-testing` enabled. The page uses `document.modelContext.registerTool(tool, { signal })`, and agents invoke tools through the browser. The adapter in `src/agent/webmcp.ts` also handles older API shapes, and does nothing in browsers without WebMCP. Tools return JSON; failures throw, so agents see `status: "Error"`. To ship on a real origin, set `VITE_WEBMCP_OT_TOKEN` to your origin-trial token at build time. Desktop MCP clients such as Claude Code can't reach page tools directly; `src/agent/tools.ts` doesn't depend on the transport, so a stdio bridge could reuse it.

**Checking it works:**
- Click the **WebMCP** pill. It asks the browser to list the tools and runs one through the browser, then reports the result.
- `npm run test:webmcp` (with `npm run dev` running) launches an isolated headless Chrome with the flag on (your own Chrome is untouched). It acts as an agent: it discovers the tools, runs reads, writes, a simulation, undo and an error case, and prints PASS/FAIL.

In dev you can call the tools from the console: `await __stratos.tools.stratos_simulate({ multiplier: 2 })`.

## Architecture

```
src/model/     types (Scene/Node/Edge/Layer/Stop), store (mutable scene + snapshot undo), persist (IndexedDB, share links), demo
src/design/    DesignCanvas — 2D renderer + interaction; redraws only when dirty, culls off-screen nodes
src/play/      Viewer3D — lazy-loaded; one InstancedMesh per node kind, merged edge lines, a single Points cloud for particles,
               render-on-demand, shadows rebuilt only when the scene changes
src/sim/       Simulation — steady-state load propagation + error/latency DFS
src/agent/     tools.ts (transport-agnostic tool definitions), webmcp.ts (browser registration adapter)
src/App.tsx    SolidJS shell: toolbar, inspector, layers, simulation and tour panels
```

- 2D (x, y) maps to 3D (x, z); `layer` sets the elevation and `height` the extrusion. Both views read one store, so nothing is ever converted between them.
- Autosaves to IndexedDB. **Menu → Copy share link** compresses the scene (deflate-raw + base64url) into the URL hash.
- The initial bundle is about 25 KB gzipped. three.js (about 150 KB gzipped) loads only on the first switch to Play, and the agent tools only when the browser supports WebMCP.
- `public/sw.js` caches what has loaded (production builds only), so the app works offline.
