# 8D modeling — system architecture in 2D and 3D

Draw your architecture in 2D, press **Tab**, and it rises into 3D, where you can run traffic through it.
Runs entirely in the browser: no server, no account.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
npm test         # unit + smoke tests
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

**Journeys** (both modes): named user paths such as *Login* or *Checkout*. Press **+** in the Journeys panel and click boxes in order. Each hop follows the existing connections, and hops back toward the caller are recorded as responses. Give steps captions, then **Play** to walk through them: the rest of the diagram fades, a token travels hop by hop, and the caption bar shows the current step. Step with **[ / ]**; **Esc** finishes recording or hides the journey. A tour stop can carry a journey, and journeys travel in share links and HTML exports.

Press **?** in the app for all shortcuts.

## AI agents (Claude in Chrome and others)

Any agent that can run JavaScript in the page can drive the app through **`window.modeling8d`**, in every browser and with no flags:

```js
await modeling8d.help()                    // usage + every tool with its input schema
await modeling8d.call('get_scene')         // results are JSON; failures return { error } and change nothing
await modeling8d.call('add_nodes', { nodes: [{ kind: 'service', label: 'API' }] })
await modeling8d.batch([{ tool: 'add_nodes', input: {...} }, { tool: 'connect', input: {...} }])  // one undo step
```

- **Agent guide:** [`llms.txt`](public/llms.txt) is served next to the app and linked from the page's `<head>`.
- **Diagram outline:** agents that only read the page get a text version of the canvas: floors, boxes, connections and journeys. It's hidden from sight but present in the accessibility tree.
- **Diagram list:** press **O**, or use **Menu → Diagram list**, to show the outline as a panel whose buttons select boxes and show journeys. This is also what screen-reader and keyboard users get.

## AI agent tools (WebMCP)

8D modeling registers its editing tools with the browser through **WebMCP**, so an in-browser AI agent can build and analyze diagrams in the open tab. There's no server: the tools run in the page against the live store, so you watch every change happen and can undo it with Ctrl+Z. A green **Agent tools** pill in the top bar shows when the browser exposes the API.

| Tool | What it does |
|---|---|
| `modeling8d_get_scene` | Read floors, nodes and connections (read-only) |
| `modeling8d_add_nodes` | Batch-add components; `ref`s can be used in `modeling8d_connect`; layers are auto-created by name |
| `modeling8d_connect` | Batch-add directed connections (by id, ref or label), with calls-per-request and async |
| `modeling8d_update` | Change node/edge fields, move between floors, mark nodes `down` |
| `modeling8d_delete` | Remove nodes/edges |
| `modeling8d_layers` | Add / rename / reorder / show / hide / delete floors, focus one floor |
| `modeling8d_auto_layout` | Lay nodes out by dependency depth, each floor in its own block |
| `modeling8d_simulate` | Run the traffic simulation headlessly (load multiplier, what-if failures) → totals + bottlenecks (read-only) |
| `modeling8d_journeys` | List / create / update / delete user journeys (start node + hops with captions), show or play one |
| `modeling8d_view` | Switch 2D/3D, toggle simulation/flows, set live load, focus a node, fit, 3D overview |
| `modeling8d_tour` | Save / update / rename / reorder / delete 3D camera stops, fly to one, present |
| `modeling8d_scene` | New or demo scene, load a scene JSON, export JSON (returned) or HTML/PNG (downloaded) |
| `modeling8d_undo` / `modeling8d_redo` | Undo / redo recent changes |
| `modeling8d_batch` | Several calls as one all-or-nothing change, undone with a single Ctrl+Z |
| `modeling8d_share_link` | URL with the whole scene compressed into it (read-only) |

Each tool call applies fully or not at all: if anything in a batch fails, the scene is restored.

**Status:** verified end to end in Chrome 157 with `chrome://flags/#enable-webmcp-testing` enabled. The page uses `document.modelContext.registerTool(tool, { signal })`, and agents invoke tools through the browser. The adapter in `src/agent/webmcp.ts` also handles older API shapes, and does nothing in browsers without WebMCP. Tools return JSON; failures throw, so agents see `status: "Error"`. To ship on a real origin, set `VITE_WEBMCP_OT_TOKEN` to your origin-trial token at build time. Desktop MCP clients such as Claude Code can't reach page tools directly; `src/agent/tools.ts` doesn't depend on the transport, so a stdio bridge could reuse it.

**Checking it works:**
- Click the **WebMCP** pill. It asks the browser to list the tools and runs one through the browser, then reports the result.
- `npm run test:webmcp` (with `npm run dev` running) launches an isolated headless Chrome with the flag on (your own Chrome is untouched). It acts as an agent: it discovers the tools, runs reads, writes, a simulation, undo and an error case, and prints PASS/FAIL.

In dev you can call the tools from the console: `await __modeling8d.tools.modeling8d_simulate({ multiplier: 2 })`.

## Architecture

Code is grouped by feature. Each feature folder holds its logic, its UI and its tests side by side; anything used by several features lives in `shared/`.

```
src/main.tsx               entry point
src/app/App.tsx            shell: top bar, modes, keyboard shortcuts, wiring between features
src/shared/model/          types (Scene/Node/Edge/Layer/Stop/Journey), geom, store (mutable scene + snapshot undo)
src/shared/appStore.ts     the app's single Store instance
src/shared/ui/             icons, number formatting, DOM helpers
src/features/
  design/                  DesignCanvas (2D renderer + interaction), toolbar, inline label editor
  play3d/                  Viewer3D (lazy-loaded three.js view), hover tooltip
  inspector/               properties panel for the selection
  layers/                  floors panel, incl. "All layers"
  simulation/              traffic simulation engine + panel
  journeys/                path finding and playback timing, journeys panel, caption bar
  tour/                    camera stops panel
  share/                   share links (compressed scene + view in the URL hash)
  persistence/             IndexedDB autosave, scene validation, file download
  export/                  standalone HTML viewer export
  agent/                   agent tools, WebMCP registration, window.modeling8d page API, status pill, setup popup
  outline/                 text outline of the diagram (accessibility tree + Diagram list panel)
  samples/                 demo scene, stress-test scene
  about/ · help/           About dialog, keyboard shortcuts
src/test/                  fakes for browser APIs jsdom lacks (2D canvas, ResizeObserver)
```

## Tests

```bash
npm test            # all unit + smoke tests (Vitest)
npm run coverage    # same, with coverage; fails below 100%
```

Every logic module (`.ts` under `shared/` and `features/`) is held at **100%** statement, branch, function and line coverage. Rendering and UI (Solid components, the 2D canvas editor and the WebGL viewer) are covered by smoke tests that mount the real code in jsdom: the whole app, the 2D editor driven by pointer events, and the 3D viewer with only the WebGL renderer faked.

- 2D (x, y) maps to 3D (x, z); `layer` sets the elevation and `height` the extrusion. Both views read one store, so nothing is ever converted between them.
- Autosaves to IndexedDB. **Menu → Copy share link** compresses the scene (deflate-raw + base64url) into the URL hash.
- The initial bundle is about 25 KB gzipped. three.js (about 150 KB gzipped) loads only on the first switch to Play, and the agent tools only when the browser supports WebMCP.
- `public/sw.js` caches what has loaded (production builds only), so the app works offline.

## About & contact

8D modeling is made by **AleB93**. For questions, ideas or bug reports, [open an issue](https://github.com/AleB93/8d-modeling/issues) or reach me on GitHub: [github.com/AleB93](https://github.com/AleB93). In the app, click the logo or **Menu → About 8D modeling**.

## License

[MIT](LICENSE) © 2026 AleB93

## Publishing on GitHub Pages

`.github/workflows/pages.yml` builds the app and deploys it on every push to `main`. One-time setup: **Settings → Pages → Source: GitHub Actions**. Builds use relative asset paths, so the app works at `https://<user>.github.io/<repo>/` whatever the repo is called. Share links use the page's own address. Pages on a private repo needs a paid GitHub plan; the published site is public either way.
