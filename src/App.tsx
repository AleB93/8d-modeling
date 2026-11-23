import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Store } from './model/store';
import { DesignCanvas, Tool } from './design/DesignCanvas';
import type { Viewer3D } from './play/Viewer3D';
import type { SimResult } from './sim/sim';
import { demoScene } from './model/demo';
import { download, idbGet, idbSet, validateScene } from './model/persist';
import { decodeShare, shareUrl, ShareView } from './model/share';
import { emptyScene, JOURNEY_COLORS, KINDS, NodeKind, PALETTE, Scene, SEdge, SIM_KINDS, SNode, uid } from './model/types';
import { stepText, STEP_MS } from './model/journeys';
import { Icon } from './ui/icons';
import type { AgentUI } from './agent/tools';
import { registerWebMCP, WebMCPStatus } from './agent/webmcp';

const store = new Store();

const TOOLS: { t: Tool; key: string; label: string }[] = [
  { t: 'select', key: 'V', label: 'Select' },
  { t: 'hand', key: 'H', label: 'Pan' },
  { t: 'arrow', key: 'A', label: 'Connect' },
  { t: 'service', key: 'S', label: 'Service' },
  { t: 'database', key: 'D', label: 'Database' },
  { t: 'queue', key: 'Q', label: 'Queue' },
  { t: 'cache', key: 'K', label: 'Cache' },
  { t: 'lb', key: 'L', label: 'Load balancer' },
  { t: 'client', key: 'C', label: 'Client' },
  { t: 'zone', key: 'Z', label: 'Zone' },
  { t: 'text', key: 'T', label: 'Text' },
];

const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString());
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export default function App() {
  const [ver, setVer] = createSignal(0);
  store.subscribe(() => setVer((v) => v + 1));
  const [mode, setMode] = createSignal<'design' | 'play'>('design');
  const [busy, setBusy] = createSignal(false);
  const [tool, setTool] = createSignal<Tool>('select');
  const [editing, setEditing] = createSignal<string | null>(null);
  const [flows, setFlows] = createSignal(true);
  const [simOn, setSimOn] = createSignal(false);
  const [mult, setMult] = createSignal(1);
  const [stats, setStats] = createSignal<SimResult | null>(null);
  const [hover, setHover] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [present, setPresent] = createSignal<number | null>(null);
  const [menu, setMenu] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [about, setAbout] = createSignal(false);
  const [toast, setToastMsg] = createSignal('');
  const [agent, setAgent] = createSignal<WebMCPStatus | null>(null);
  const [jPlaying, setJPlaying] = createSignal(false);
  let toastT = 0;
  const toastMsg = (m: string) => {
    setToastMsg(m);
    clearTimeout(toastT);
    toastT = window.setTimeout(() => setToastMsg(''), 2600);
  };

  let canvasEl!: HTMLCanvasElement;
  let host3d!: HTMLDivElement;
  let fileIn!: HTMLInputElement;
  let design!: DesignCanvas;
  let viewer: Viewer3D | undefined;

  // ---------- persistence ----------
  let saveT = 0;
  store.subscribe(() => {
    clearTimeout(saveT);
    saveT = window.setTimeout(() => idbSet('scene', store.scene).catch(() => {}), 400);
  });

  const replaceScene = (s: Scene) => {
    store.checkpoint();
    store.load(s, false);
    store.select([]);
    design.fit();
  };

  onMount(async () => {
    design = new DesignCanvas(canvasEl, store, { onTool: setTool, onEditLabel: setEditing, onToast: toastMsg });
    let shared: Awaited<ReturnType<typeof decodeShare>> = null;
    try {
      shared = await decodeShare(location.hash);
      if (shared) {
        store.load(shared.scene);
        history.replaceState(null, '', location.pathname);
        toastMsg('Loaded shared scene');
      }
    } catch {
      toastMsg('That share link is invalid');
    }
    if (!shared) {
      const saved = await idbGet<Scene>('scene').catch(() => undefined);
      try { store.load(saved ? validateScene(saved) : demoScene()); } catch { store.load(demoScene()); }
    }
    design.fit();
    if (shared?.view) await applyView(shared.view);

    // A share link pasted into an already-open tab only changes the hash (no reload), so load it here too.
    const onHash = async () => {
      try {
        const sh = await decodeShare(location.hash);
        if (!sh) return;
        if (mode() === 'play') await toDesign();
        replaceScene(sh.scene); // checkpointed: Ctrl+Z restores the previous scene
        history.replaceState(null, '', location.pathname);
        if (sh.view) await applyView(sh.view);
        toastMsg('Loaded shared scene · Ctrl+Z to undo');
      } catch {
        toastMsg('That share link is invalid');
      }
    };
    window.addEventListener('hashchange', onHash);
    import.meta.hot?.dispose(() => window.removeEventListener('hashchange', onHash)); // after an await, onCleanup has no owner

    // ---- agent tools (WebMCP) ----
    const agentUI: AgentUI = {
      setMode: (m) => (m === 'play' ? toPlay() : toDesign()),
      focus: (id) => {
        store.select([id]);
        if (mode() === 'play') viewer?.focusNode(id);
        else {
          const n = store.scene.nodes[id];
          if (n) design.setView({ cx: n.x + n.w / 2, cy: n.y + n.h / 2, width: Math.max(800, design.getView().width * 0.6) });
        }
      },
      setSimulation: (on) => { if (on !== simOn()) toggleSim(); },
      setFlows: (on) => { if (on !== flows()) toggleFlows(); },
      fit: () => design.fit(),
      captureView,
    };
    const loadTools = async () => (await import('./agent/tools')).createTools(store, agentUI);
    const reg = await registerWebMCP(loadTools);
    setAgent(reg.status);
    import.meta.hot?.dispose(reg.unregister); // app root never unmounts; only dev reloads need cleanup

    if (import.meta.env.DEV) {
      // dev-only console handle: __modeling8d.store / .design / .viewer() / .stress(n) / .tools.<name>(input)
      (window as any).__modeling8d = {
        store, design, viewer: () => viewer, agent: reg.status,
        stress: async (n = 2000) => replaceScene((await import('./model/stress')).stressScene(n)),
        tools: Object.fromEntries((await loadTools()).map((t) => [t.name, async (input: unknown) => {
          try { return JSON.parse(await t.execute(input)); } catch (e) { return { error: (e as Error).message }; }
        }])),
      };
    }
    if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });

  // ---------- modes ----------
  async function toPlay() {
    if (mode() === 'play' || busy()) return;
    setBusy(true);
    setEditing(null);
    setMenu(false);
    if (!viewer) {
      const { Viewer3D } = await import('./play/Viewer3D');
      viewer = new Viewer3D(host3d, store, { onHover: setHover, onSim: setStats, onToast: toastMsg });
    }
    design.setActive(false);
    setMode('play');
    viewer.setFlows(flows());
    viewer.setSim(simOn());
    viewer.sim.multiplier = mult();
    await viewer.enter(design.getView());
    setBusy(false);
  }

  async function toDesign() {
    if (mode() === 'design' || busy() || !viewer) return;
    setBusy(true);
    setPresent(null);
    setHover(null);
    const v = await viewer.leave();
    setMode('design');
    design.setActive(true);
    design.setView(v);
    setBusy(false);
  }

  const toggleSim = () => {
    const on = !simOn();
    setSimOn(on);
    viewer?.setSim(on);
  };
  const toggleFlows = () => {
    const on = !flows();
    setFlows(on);
    viewer?.setFlows(on);
  };
  const toggleDown = () => {
    const ns = store.selectedNodes.filter((n) => SIM_KINDS.has(n.kind));
    if (!ns.length) return toastMsg('Select a node first');
    const down = !ns[0].down;
    store.update((s) => { for (const n of ns) s.nodes[n.id].down = down; });
  };

  const goStop = (i: number) => {
    const stops = store.scene.stops;
    if (!stops.length || !viewer) return;
    const k = ((i % stops.length) + stops.length) % stops.length;
    if (present() !== null) setPresent(k);
    stopJourneyPlay();
    store.setJourney(stops[k].journey ?? null);
    viewer.goTo(stops[k]);
  };

  // ---------- journeys ----------
  let jTimer = 0;
  function stopJourneyPlay() {
    clearInterval(jTimer);
    setJPlaying(false);
  }
  /** Step through the shown journey (or `id`) one hop at a time, stopping on the last step. */
  function playJourney(id?: string) {
    const j = store.journeyById(id ?? store.journey?.id);
    if (!j?.steps.length) return toastMsg('This journey has no steps yet: record it first');
    store.stopRecording();
    const cur = store.journey?.id === j.id ? store.journey.step : -1;
    store.setJourney(j.id, cur < 0 || cur >= j.steps.length - 1 ? 0 : cur);
    clearInterval(jTimer);
    setJPlaying(true);
    jTimer = window.setInterval(() => {
      const v = store.journey, jj = store.activeJourney;
      if (!v || !jj || v.id !== j.id) return stopJourneyPlay();
      if (v.step >= jj.steps.length - 1) return stopJourneyPlay();
      store.setJourney(jj.id, v.step + 1);
    }, STEP_MS * 1.6);
  }
  const stepJourney = (d: number) => {
    const v = store.journey, j = store.activeJourney;
    if (!v || !j) return;
    stopJourneyPlay();
    store.setJourney(j.id, Math.max(-1, Math.min(j.steps.length - 1, v.step + d)));
  };
  const closeJourney = () => { stopJourneyPlay(); store.stopRecording(); store.setJourney(null); };
  const journeyOn = createMemo(() => (ver(), !!store.journey));
  const startPresent = () => {
    if (!store.scene.stops.length) return toastMsg('Add a camera stop first');
    setPresent(0);
    goStop(0);
  };

  // ---------- share-link view state ----------
  /** How you are looking at the scene right now, for share links. */
  function captureView(): ShareView {
    const v: ShareView = { mode: mode(), sim: simOn(), mult: mult(), flows: flows(), sel: [...store.selection] };
    if (store.journey) v.journey = { ...store.journey };
    if (mode() === 'play' && viewer) {
      const { pos, target } = viewer.captureStop('');
      v.cam = { pos, target };
      if (present() !== null) v.stop = present()!;
    } else v.view2d = design.getView();
    return v;
  }

  /** Restore a shared view on top of the already-loaded scene. Unknown ids and stops are ignored. */
  async function applyView(v: ShareView) {
    if ((v.flows ?? true) !== flows()) toggleFlows();
    if (!!v.sim !== simOn()) toggleSim();
    setMult(v.mult ?? 1);
    if (viewer) viewer.sim.multiplier = mult();
    const sc = store.scene;
    store.select((v.sel ?? []).filter((id) => sc.nodes[id] || sc.edges[id]));
    store.setJourney(v.journey?.id ?? null, v.journey?.step ?? -1);
    if (v.mode === 'play') {
      await toPlay();
      if (v.stop != null && sc.stops[v.stop]) {
        setPresent(v.stop);
        goStop(v.stop);
      } else if (v.cam && viewer) await viewer.goTo({ id: '', name: '', ...v.cam });
    } else {
      if (mode() === 'play') await toDesign();
      if (v.view2d) design.setView(v.view2d);
    }
  }

  // ---------- keyboard ----------
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target) || busy()) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      mode() === 'design' ? toPlay() : toDesign();
      return;
    }
    if (e.key === '?') { setHelp((h) => !h); return; }
    if (e.key === 'Escape' && (help() || menu() || about())) { setHelp(false); setMenu(false); setAbout(false); return; }
    if (e.key === 'Escape' && store.recording) { store.stopRecording(); toastMsg('Recording finished'); return; }
    if (store.journey && !(e.metaKey || e.ctrlKey)) {
      if (e.key === '[' || e.key === ']') { stepJourney(e.key === ']' ? 1 : -1); return; }
      if (e.key === 'Escape' && !store.selection.size && present() === null) { closeJourney(); return; }
    }
    if (mode() === 'design') {
      if (design.onKey(e)) e.preventDefault();
      return;
    }
    const p = present();
    if (p !== null) {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goStop(p + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goStop(p - 1); }
      else if (e.key === 'Escape') setPresent(null);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
    else if (mod && k === 'y') { e.preventDefault(); store.redo(); }
    else if (mod) return;
    else if (k === 'f') toggleFlows();
    else if (k === 'm') toggleSim();
    else if (k === 'x') toggleDown();
    else if (k === 'p') startPresent();
    else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) viewer?.overview();
    else if (e.key === 'Escape') store.select([]);
    else if (e.key === 'Delete' || e.key === 'Backspace') store.deleteSelection();
    else if (/^[1-9]$/.test(e.key)) goStop(+e.key - 1);
  };
  const onKeyUp = (e: KeyboardEvent) => mode() === 'design' && design?.onKeyUp(e);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  onCleanup(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); });

  // ---------- menu actions ----------
  const actions = {
    newScene: () => { replaceScene(emptyScene()); toastMsg('New scene (Ctrl+Z to undo)'); },
    demo: () => replaceScene(demoScene()),
    importJson: () => fileIn.click(),
    exportJson: () => download('system.8d-modeling.json', new Blob([JSON.stringify(store.scene, null, 2)], { type: 'application/json' })),
    exportHtml: async () => {
      const { sceneToHtml } = await import('./export/html'); // lazy: pulls in three only for REVISION
      download('system-3d.html', new Blob([sceneToHtml(store.scene)], { type: 'text/html' }));
      toastMsg('Exported a standalone 3D viewer (needs internet to load three.js)');
    },
    exportPng: async () => {
      if (mode() === 'play' && viewer) {
        const blob = await (await fetch(viewer.snapshot())).blob();
        download('system-3d.png', blob);
      } else {
        const b = await design.exportPNG();
        if (b) download('system-2d.png', b);
      }
    },
    share: async (withView: boolean) => {
      const url = shareUrl(store.scene, withView ? captureView() : undefined);
      try {
        await navigator.clipboard.writeText(url);
        toastMsg(`${withView ? 'Share link with current view' : 'Share link (scene only)'} copied (${(url.length / 1024).toFixed(1)} KB)`);
      } catch {
        prompt('Copy this link', url);
      }
    },
  };
  const onFile = async (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!f) return;
    try {
      replaceScene(validateScene(JSON.parse(await f.text())));
      toastMsg(`Imported ${f.name}`);
    } catch (err) {
      toastMsg(`Import failed: ${(err as Error).message}`);
    }
  };

  const canUndo = createMemo(() => (ver(), store.canUndo));
  const canRedo = createMemo(() => (ver(), store.canRedo));

  return (
    <div class="app" classList={{ play: mode() === 'play', presenting: present() !== null, journeying: journeyOn() }}>
      <canvas ref={canvasEl} class="stage" classList={{ hidden: mode() !== 'design' }} />
      <div ref={host3d} class="stage" classList={{ hidden: mode() !== 'play' }} />

      {/* ---- top bar ---- */}
      <header class="topbar">
        <button class="brand" title="About 8D modeling" onClick={() => setAbout(true)}><Icon name="layers" size={20} /> 8D modeling</button>
        <Show when={mode() === 'design'}>
          <nav class="toolbar panel">
            <For each={TOOLS}>
              {(t) => (
                <button class="tool" classList={{ on: tool() === t.t }} title={`${t.label} (${t.key})`} onClick={() => design.setTool(t.t)}>
                  <Icon name={t.t} />
                  <span class="k">{t.key}</span>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <Show when={mode() === 'play'}>
          <nav class="toolbar panel">
            <button class="chip" classList={{ on: flows() }} onClick={toggleFlows} title="Animated flows (F)"><Icon name="flow" /> Flows</button>
            <button class="chip" classList={{ on: simOn() }} onClick={toggleSim} title="Traffic simulation (M)"><Icon name={simOn() ? 'pause' : 'play'} /> Simulate</button>
            <button class="chip" onClick={toggleDown} title="Kill / revive selected node (X)"><Icon name="skull" /> Kill / revive</button>
          </nav>
        </Show>
        <div class="right">
          <Show when={agent()}>
            {(a) => {
              const state = () => (a().registered ? 'ok' : a().supported ? 'warn' : 'off');
              const tip = () =>
                a().registered
                  ? `WebMCP active: ${a().registered} tools registered via ${a().via}.${a().method}()`
                  : a().supported
                    ? `WebMCP found (${a().via}) but registration failed: ${a().error ?? 'unknown error'}`
                    : 'WebMCP not available in this browser (enable chrome://flags/#enable-webmcp-testing)';
              const FLAG_URL = 'chrome://flags/#enable-webmcp-testing';
              const test = async () => {
                if (!a().supported) {
                  // Pages can't navigate to chrome:// URLs (Chrome blocks it), so copy the flag URL for the user to paste.
                  const isChrome = /Chrome\//.test(navigator.userAgent);
                  if (!isChrome) return toastMsg('WebMCP needs Chrome: open this page in Chrome and enable chrome://flags/#enable-webmcp-testing');
                  try {
                    await navigator.clipboard.writeText(FLAG_URL);
                    toastMsg(`Copied ${FLAG_URL} — paste it in the address bar, set it to Enabled, then relaunch Chrome.`);
                  } catch {
                    toastMsg(`Open ${FLAG_URL} in the address bar, set it to Enabled, then relaunch Chrome.`);
                  }
                  return;
                }
                const { selfTestWebMCP } = await import('./agent/webmcp');
                toastMsg((await selfTestWebMCP()).message);
              };
              return (
                <button class={`agentpill panel ${state()}`} title={`${tip()}. ${a().supported ? 'Click to run a test call.' : 'Click to copy the flag URL.'}`} data-webmcp={state()} onClick={test}>
                  <span class="adot" /> WebMCP
                </button>
              );
            }}
          </Show>
          <div class="seg panel" role="tablist">
            <button classList={{ on: mode() === 'design' }} onClick={toDesign} disabled={busy()}>Design</button>
            <button classList={{ on: mode() === 'play' }} onClick={toPlay} disabled={busy()}>Play 3D</button>
          </div>
          <button class="icon panel" title="Shortcuts (?)" onClick={() => setHelp(true)}><Icon name="help" /></button>
          <div class="menuwrap">
            <button class="icon panel" title="Menu" onClick={() => setMenu(!menu())}><Icon name="menu" /></button>
            <Show when={menu()}>
              <div class="menu panel" onClick={() => setMenu(false)}>
                <button onClick={() => actions.share(true)} title="Opens in the same mode, camera, tour stop, simulation and selection">Copy share link</button>
                <button onClick={() => actions.share(false)}>Copy share link (scene only)</button>
                <button onClick={actions.exportJson}>Export JSON</button>
                <button onClick={actions.importJson}>Import JSON…</button>
                <button onClick={actions.exportHtml}>Export HTML (3D viewer)</button>
                <button onClick={actions.exportPng}>Export PNG ({mode() === 'play' ? '3D' : '2D'} view)</button>
                <hr />
                <button onClick={actions.demo}>Load demo system</button>
                <button onClick={actions.newScene}>New empty scene</button>
                <hr />
                <button onClick={() => setAbout(true)}>About 8D modeling</button>
              </div>
            </Show>
          </div>
        </div>
      </header>
      <input ref={fileIn} type="file" accept=".json,application/json" hidden onChange={onFile} />

      <LayersPanel ver={ver} toast={toastMsg} />
      <JourneysPanel ver={ver} toast={toastMsg} play={playJourney} playing={jPlaying} stopPlay={stopJourneyPlay} />
      <Show when={journeyOn()}>
        <JourneyBar ver={ver} playing={jPlaying} play={() => (jPlaying() ? stopJourneyPlay() : playJourney())} step={stepJourney} close={closeJourney} />
      </Show>
      <Inspector ver={ver} simOn={simOn} stats={stats} toggleDown={toggleDown} />

      <Show when={mode() === 'design'}>
        <div class="zoombar panel">
          <button class="icon" disabled={!canUndo()} onClick={() => store.undo()} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
          <button class="icon" disabled={!canRedo()} onClick={() => store.redo()} title="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
          <span class="sep" />
          <button class="icon" onClick={() => design.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2)} title="Zoom out"><Icon name="minus" /></button>
          <button class="icon" onClick={() => design.fit()} title="Fit (Shift+1)"><Icon name="fit" /></button>
          <button class="icon" onClick={() => design.zoomAt(innerWidth / 2, innerHeight / 2, 1.2)} title="Zoom in"><Icon name="plus" /></button>
        </div>
        <div class="hint">Tab → 3D · double-click to label · drag from a node with <b>A</b> to connect</div>
      </Show>

      <Show when={mode() === 'play'}>
        <Show when={simOn()}>
          <SimPanel stats={stats} mult={mult} setMult={(v) => { setMult(v); if (viewer) viewer.sim.multiplier = v; }} />
        </Show>
        <TourPanel ver={ver} go={goStop} present={startPresent} capture={(name) => {
          const st = viewer!.captureStop(name);
          if (store.journey) st.journey = store.journey.id;
          return st;
        }} />
        <div class="zoombar panel">
          <button class="icon" onClick={() => viewer?.overview()} title="Overview: show everything (Shift+1)"><Icon name="fit" /></button>
        </div>
        <div class="hint">Drag to orbit · right-drag to pan · drag a node to move it · Alt+drag to change height · double-click to focus</div>
      </Show>

      <Show when={present() !== null}>
        <div class="presentbar panel">
          <button class="icon" onClick={() => goStop(present()! - 1)}>‹</button>
          <span>{present()! + 1} / {store.scene.stops.length} · {store.scene.stops[present()!]?.name}</span>
          <button class="icon" onClick={() => goStop(present()! + 1)}>›</button>
          <button class="icon" onClick={() => setPresent(null)} title="Exit (Esc)"><Icon name="close" /></button>
        </div>
      </Show>

      <Show when={editing()}>
        {(id) => <LabelEditor id={id()} design={design} done={() => setEditing(null)} />}
      </Show>

      <Show when={mode() === 'play' && hover()}>
        {(h) => <Tooltip h={h()} stats={stats} simOn={simOn} />}
      </Show>

      <Show when={help()}><Help close={() => setHelp(false)} /></Show>
      <Show when={about()}><About close={() => setAbout(false)} /></Show>
      <Show when={toast()}><div class="toast">{toast()}</div></Show>
    </div>
  );
}

// =====================================================================

function LabelEditor(props: { id: string; design: DesignCanvas; done: () => void }) {
  const n = store.scene.nodes[props.id];
  if (!n) { queueMicrotask(props.done); return null; }
  const r = props.design.screenRect(n);
  const isText = n.kind === 'text';
  let el!: HTMLTextAreaElement;
  let closed = false;
  const commit = (cancel = false) => {
    if (closed) return;
    closed = true;
    const v = el.value;
    const cur = store.scene.nodes[props.id];
    if (cur && !cancel) {
      if (isText && !v.trim()) store.update((s) => { delete s.nodes[props.id]; });
      else if (v !== cur.label) {
        store.update((s) => {
          const m = s.nodes[props.id];
          m.label = v;
          if (isText) [m.w, m.h] = props.design.textSize(v);
        });
      }
    } else if (cur && cancel && isText && !cur.label.trim()) store.update((s) => { delete s.nodes[props.id]; }, false);
    props.done();
  };
  onMount(() => { el.focus(); el.select(); });
  const style = isText
    ? { left: `${r.x}px`, top: `${r.y}px`, 'min-width': `${Math.max(120, r.w)}px`, 'font-size': `${20 * r.z}px`, 'text-align': 'left' as const }
    : { left: `${r.x}px`, top: `${r.y + r.h / 2 - 18}px`, width: `${Math.max(120, r.w)}px`, 'font-size': '14px' };
  return (
    <textarea
      ref={el}
      class="labeledit"
      style={style}
      rows={isText ? Math.max(1, n.label.split('\n').length) : 1}
      value={n.label}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') commit(true);
        else if (e.key === 'Enter' && !(isText && e.shiftKey)) { e.preventDefault(); commit(); }
      }}
      onBlur={() => commit()}
    />
  );
}

function Swatches(props: { value?: string; set: (c: string) => void }) {
  return (
    <div class="swatches">
      <For each={PALETTE}>
        {(c) => <button class="sw" classList={{ on: props.value === c }} style={{ background: c }} onClick={() => props.set(c)} title={c} />}
      </For>
      <label class="sw custom" title="Custom color">
        <input type="color" value={props.value ?? '#ffffff'} onInput={(e) => props.set(e.currentTarget.value)} />
      </label>
    </div>
  );
}

function Inspector(props: { ver: () => number; simOn: () => boolean; stats: () => SimResult | null; toggleDown: () => void }) {
  const sel = createMemo(() => (props.ver(), [...store.selection]), [], { equals: false });
  const nodes = createMemo(() => sel().map((id) => store.scene.nodes[id]).filter(Boolean) as SNode[], [], { equals: false });
  const edges = createMemo(() => sel().map((id) => store.scene.edges[id]).filter(Boolean) as SEdge[], [], { equals: false });
  const single = createMemo(() => (nodes().length === 1 ? nodes()[0] : null), null, { equals: false });
  const edge = createMemo(() => (edges().length === 1 && !nodes().length ? edges()[0] : null), null, { equals: false });
  const layers = createMemo(() => (props.ver(), store.scene.layers.slice().reverse()), [], { equals: false });

  const setN = <K extends keyof SNode>(field: K, value: SNode[K], coalesce = true) =>
    store.update((s) => {
      for (const n of nodes()) if (s.nodes[n.id]) s.nodes[n.id][field] = value;
    }, coalesce ? `n:${String(field)}:${sel().join()}` : true);
  const setE = <K extends keyof SEdge>(field: K, value: SEdge[K]) =>
    store.update((s) => { const e = edge(); if (e && s.edges[e.id]) s.edges[e.id][field] = value; }, `e:${String(field)}:${edge()?.id}`);
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  return (
    <Show when={nodes().length || edges().length}>
      <aside class="inspector panel">
        <Show when={single()}>
          {(_) => { const n = () => single()!; return (
            <>
              <h3><span class="dot" style={{ background: n().color }} />{KINDS[n().kind].name}</h3>
              <label>Label<input value={n().label} onInput={(e) => setN('label', e.currentTarget.value)} /></label>
              <Show when={n().kind !== 'text' && n().kind !== 'zone'}>
                <label>Type
                  <select value={n().kind} onChange={(e) => {
                    const k = e.currentTarget.value as NodeKind;
                    const old = KINDS[n().kind], d = KINDS[k];
                    store.update((s) => {
                      const m = s.nodes[n().id];
                      m.kind = k;
                      if (m.color === old.color) m.color = d.color;
                      if (m.capacity === old.capacity) m.capacity = d.capacity;
                      if (m.latency === old.latency) m.latency = d.latency;
                    });
                  }}>
                    <For each={(['service', 'database', 'queue', 'cache', 'lb', 'client'] as NodeKind[])}>{(k) => <option value={k}>{KINDS[k].name}</option>}</For>
                  </select>
                </label>
              </Show>
              <label>Layer
                <select value={n().layer} onChange={(e) => { setN('layer', e.currentTarget.value, false); store.setActiveLayer(e.currentTarget.value); }}>
                  <For each={layers()}>{(l) => <option value={l.id}>{l.name}</option>}</For>
                </select>
              </label>
              <div class="field">Color<Swatches value={n().color} set={(c) => setN('color', c)} /></div>
              <Show when={n().kind !== 'text'}>
                <div class="row2">
                  <label>Width<input type="number" value={Math.round(n().w)} onInput={(e) => setN('w', num(e.currentTarget.value, 20))} /></label>
                  <label>Depth<input type="number" value={Math.round(n().h)} onInput={(e) => setN('h', num(e.currentTarget.value, 20))} /></label>
                </div>
              </Show>
              <Show when={n().kind !== 'text' && n().kind !== 'zone'}>
                <label>Height (3D) <span class="val">{n().height}</span>
                  <input type="range" min="2" max="400" value={n().height} onInput={(e) => setN('height', +e.currentTarget.value)} />
                </label>
              </Show>
              <Show when={SIM_KINDS.has(n().kind)}>
                <h4>Simulation</h4>
                <div class="row2">
                  <label>{n().kind === 'client' ? 'Traffic rps' : n().kind === 'queue' ? 'Drain rps' : 'Capacity rps'}
                    <input type="number" value={n().capacity} onInput={(e) => setN('capacity', num(e.currentTarget.value))} />
                  </label>
                  <label>Latency ms<input type="number" value={n().latency} onInput={(e) => setN('latency', num(e.currentTarget.value))} /></label>
                </div>
                <button class="btn" classList={{ danger: !n().down }} onClick={props.toggleDown}>
                  <Icon name="skull" size={16} /> {n().down ? 'Revive node' : 'Kill node'}
                </button>
                <Show when={props.simOn() && props.stats()?.nodes.get(n().id)}>
                  {(st) => (
                    <div class="stats">
                      <div><b>{fmt(st().inRps)}</b><span>rps in</span></div>
                      <Show when={n().kind !== 'client'}><div><b>{Math.round(st().util * 100)}%</b><span>util</span></div></Show>
                      <div><b>{Math.round(st().lat)}ms</b><span>latency</span></div>
                      <div><b>{(st().err * 100).toFixed(1)}%</b><span>errors</span></div>
                    </div>
                  )}
                </Show>
              </Show>
            </>
          ); }}
        </Show>

        <Show when={nodes().length > 1}>
          <h3>{nodes().length} nodes</h3>
          <div class="field">Color<Swatches set={(c) => setN('color', c)} /></div>
          <label>Move to layer
            <select value="" onChange={(e) => { setN('layer', e.currentTarget.value, false); store.setActiveLayer(e.currentTarget.value); }}>
              <option value="" disabled>Choose…</option>
              <For each={layers()}>{(l) => <option value={l.id}>{l.name}</option>}</For>
            </select>
          </label>
          <label>Height (3D)
            <input type="range" min="2" max="400" value={nodes()[0].height} onInput={(e) => setN('height', +e.currentTarget.value)} />
          </label>
        </Show>

        <Show when={edge()}>
          {(_) => { const e = () => edge()!; return (
            <>
              <h3>Connection</h3>
              <p class="muted">{store.scene.nodes[e().from]?.label} → {store.scene.nodes[e().to]?.label}</p>
              <label>Label<input value={e().label} onInput={(ev) => setE('label', ev.currentTarget.value)} /></label>
              <label>Calls per request<input type="number" step="0.1" min="0" value={e().mult} onInput={(ev) => setE('mult', num(ev.currentTarget.value))} /></label>
              <label class="check"><input type="checkbox" checked={e().dashed} onChange={(ev) => setE('dashed', ev.currentTarget.checked)} /> Dashed (async)</label>
              <label class="check"><input type="checkbox" checked={e().flow} onChange={(ev) => setE('flow', ev.currentTarget.checked)} /> Animate flow</label>
              <button class="btn" onClick={() => store.update((s) => { const x = s.edges[e().id]; [x.from, x.to] = [x.to, x.from]; })}>Reverse direction</button>
            </>
          ); }}
        </Show>
        <button class="btn danger" onClick={() => store.deleteSelection()}><Icon name="trash" size={16} /> Delete</button>
      </aside>
    </Show>
  );
}

function LayersPanel(props: { ver: () => number; toast: (m: string) => void }) {
  const layers = createMemo(() => (props.ver(), store.scene.layers.map((l, i) => ({ l, i })).reverse()), [], { equals: false });
  const counts = createMemo(() => {
    props.ver();
    const c = new Map<string, number>();
    for (const n of Object.values(store.scene.nodes)) c.set(n.layer, (c.get(n.layer) ?? 0) + 1);
    return c;
  });
  const active = createMemo(() => (props.ver(), store.activeLayer));
  const all = createMemo(() => (props.ver(), store.allLayers));
  const [renaming, setRenaming] = createSignal<string | null>(null);

  const add = () => {
    const l = { id: uid('l'), name: `Floor ${store.scene.layers.length + 1}`, visible: true };
    store.update((s) => { s.layers.push(l); });
    store.setActiveLayer(l.id);
  };
  const move = (i: number, d: number) => store.update((s) => {
    const j = i + d;
    if (j < 0 || j >= s.layers.length) return;
    [s.layers[i], s.layers[j]] = [s.layers[j], s.layers[i]];
  });
  const remove = (i: number) => {
    const s = store.scene;
    if (s.layers.length < 2) return props.toast('A scene needs at least one layer');
    const id = s.layers[i].id;
    const target = s.layers[i === 0 ? 1 : i - 1];
    const n = counts().get(id) ?? 0;
    store.update((sc) => {
      for (const node of Object.values(sc.nodes)) if (node.layer === id) node.layer = target.id;
      sc.layers.splice(i, 1);
    });
    if (store.activeLayer === id) store.setActiveLayer(target.id);
    if (n) props.toast(`Moved ${n} node${n > 1 ? 's' : ''} to “${target.name}”`);
  };

  return (
    <aside class="layers panel">
      <h3><Icon name="layers" size={16} /> Layers <button class="icon sm" title="Add layer on top" onClick={add}><Icon name="plus" size={16} /></button></h3>
      <div class="layer all" classList={{ on: all() }} onClick={() => store.setAllLayers(true)} title="Show every layer at full brightness">
        <span class="icon-spacer"><Icon name="layers" size={14} /></span>
        <span class="name">All layers</span>
        <span class="count">{[...counts().values()].reduce((a, b) => a + b, 0)}</span>
      </div>
      <For each={layers()}>
        {(row) => (
          <div class="layer" classList={{ on: !all() && active() === row.l.id, target: all() && active() === row.l.id, off: !row.l.visible }}
            title={all() && active() === row.l.id ? 'New boxes go on this layer' : undefined} onClick={() => store.focusLayer(row.l.id)}>
            <button class="icon sm" title="Toggle visibility" onClick={(e) => { e.stopPropagation(); store.update((s) => { s.layers[row.i].visible = !s.layers[row.i].visible; }); }}>
              <Icon name={row.l.visible ? 'eye' : 'eyeOff'} size={16} />
            </button>
            <Show when={renaming() === row.l.id} fallback={<span class="name" onDblClick={() => setRenaming(row.l.id)} title="Double-click to rename">{row.l.name}</span>}>
              <input class="name" value={row.l.name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) store.update((s) => { s.layers[row.i].name = v; }); setRenaming(null); }} />
            </Show>
            <span class="count">{counts().get(row.l.id) ?? 0}</span>
            <span class="acts">
              <button class="icon sm" title="Move up" onClick={(e) => { e.stopPropagation(); move(row.i, 1); }}><Icon name="up" size={14} /></button>
              <button class="icon sm" title="Move down" onClick={(e) => { e.stopPropagation(); move(row.i, -1); }}><Icon name="down" size={14} /></button>
              <button class="icon sm" title="Delete layer" onClick={(e) => { e.stopPropagation(); remove(row.i); }}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )}
      </For>
      <p class="muted small">Top of the list = top floor in 3D.</p>
    </aside>
  );
}

function SimPanel(props: { stats: () => SimResult | null; mult: () => number; setMult: (v: number) => void }) {
  const t = () => props.stats()?.total;
  const errCls = () => ((t()?.err ?? 0) > 0.05 ? 'bad' : (t()?.err ?? 0) > 0.005 ? 'warn' : 'ok');
  return (
    <div class="simpanel panel">
      <div class="stats">
        <div><b>{fmt(t()?.rps ?? 0)}</b><span>req/s</span></div>
        <div class={errCls()}><b>{((t()?.err ?? 0) * 100).toFixed(1)}%</b><span>errors</span></div>
        <div><b>{Math.round(t()?.lat ?? 0)}ms</b><span>avg latency</span></div>
      </div>
      <label>Traffic ×{props.mult().toFixed(1)}
        <input type="range" min="-2.3" max="2.3" step="0.01" value={Math.log(props.mult())}
          onInput={(e) => props.setMult(Math.round(Math.exp(+e.currentTarget.value) * 10) / 10)} />
      </label>
      <p class="muted small">Select a node and press <b>X</b> to kill it; watch failures propagate. Queues absorb bursts.</p>
    </div>
  );
}

function TourPanel(props: { ver: () => number; go: (i: number) => void; present: () => void; capture: (name: string) => import('./model/types').Stop }) {
  const stops = createMemo(() => (props.ver(), store.scene.stops.slice()), [], { equals: false });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  return (
    <aside class="tour panel">
      <h3><Icon name="camera" size={16} /> Tour
        <button class="icon sm" title="Save current view as a stop" onClick={() => {
          const s = props.capture(`View ${store.scene.stops.length + 1}`);
          store.update((sc) => { sc.stops.push(s); });
        }}><Icon name="plus" size={16} /></button>
      </h3>
      <For each={stops()} fallback={<p class="muted small">Orbit to a nice angle, then press + to save it.</p>}>
        {(s, i) => (
          <div class="layer" onClick={() => props.go(i())}>
            <span class="num">{i() + 1}</span>
            <Show when={store.journeyById(s.journey)}>{(j) => <span class="jdot sm" style={{ background: j().color }} title={`Shows journey “${j().name}”`} />}</Show>
            <Show when={renaming() === s.id} fallback={<span class="name" onDblClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}>{s.name}</span>}>
              <input class="name" value={s.name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) store.update((sc) => { const x = sc.stops.find((y) => y.id === s.id); if (x) x.name = v; }); setRenaming(null); }} />
            </Show>
            <span class="acts">
              <button class="icon sm" title="Update with current view" onClick={(e) => {
                e.stopPropagation();
                const c = props.capture(s.name);
                store.update((sc) => { const x = sc.stops.find((y) => y.id === s.id); if (x) { x.pos = c.pos; x.target = c.target; x.journey = c.journey; } });
              }}><Icon name="camera" size={14} /></button>
              <button class="icon sm" title="Delete stop" onClick={(e) => { e.stopPropagation(); store.update((sc) => { sc.stops = sc.stops.filter((y) => y.id !== s.id); }); }}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )}
      </For>
      <button class="btn primary" onClick={props.present} disabled={!stops().length}><Icon name="play" size={16} /> Present</button>
    </aside>
  );
}

function Tooltip(props: { h: { id: string; x: number; y: number }; stats: () => SimResult | null; simOn: () => boolean }) {
  const n = () => store.scene.nodes[props.h.id];
  const st = () => (props.simOn() ? props.stats()?.nodes.get(props.h.id) : undefined);
  return (
    <Show when={n()}>
      <div class="tooltip" style={{ left: `${props.h.x + 14}px`, top: `${props.h.y + 14}px` }}>
        <b>{n()!.label}</b> <span class="muted">{KINDS[n()!.kind].name}{n()!.down ? ' · DOWN' : ''}</span>
        <Show when={st()}>
          {(s) => (
            <div class="small">
              {fmt(s().inRps)} rps in · {fmt(s().rps)} handled
              <Show when={n()!.kind !== 'client'}> · {Math.round(s().util * 100)}% util</Show>
              <br />{Math.round(s().lat)}ms · {(s().err * 100).toFixed(1)}% errors
              <Show when={s().backlog > 1}> · {fmt(s().backlog)} queued</Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

function JourneysPanel(props: {
  ver: () => number; toast: (m: string) => void; play: (id: string) => void; playing: () => boolean; stopPlay: () => void;
}) {
  // fresh copies each version so rows re-render after in-place edits (rename, new steps, captions)
  const list = createMemo(() => (props.ver(), store.scene.journeys.map((j) => ({ ...j, steps: j.steps.map((st) => ({ ...st })) }))), [], { equals: false });
  const view = createMemo(() => (props.ver(), store.journey ? { ...store.journey } : null), null, { equals: false });
  const rec = createMemo(() => (props.ver(), store.recording ? { ...store.recording } : null), null, { equals: false });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(true);
  let el!: HTMLElement;
  onMount(() => {
    // the inspector shares the right column: tell CSS how tall this panel is
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--jh', `${el.offsetHeight}px`));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const edit = (id: string, fn: (j: import('./model/types').Journey) => void, key?: string) =>
    store.update((s) => { const j = s.journeys.find((x) => x.id === id); if (j) fn(j); }, key ?? true);
  const add = () => {
    const n = store.scene.journeys.length;
    const used = new Set(store.scene.journeys.map((x) => x.color));
    const color = JOURNEY_COLORS.find((c) => !used.has(c)) ?? JOURNEY_COLORS[n % JOURNEY_COLORS.length];
    const j = { id: uid('j'), name: `Journey ${n + 1}`, color, steps: [] };
    store.update((s) => { s.journeys.push(j); });
    props.stopPlay();
    store.startRecording(j.id);
    setOpen(true);
    props.toast('Recording: click the boxes in order (connections are followed automatically) · Esc to finish');
  };
  const toggleRec = (id: string) => {
    props.stopPlay();
    if (store.recording?.id === id) return store.stopRecording();
    store.startRecording(id);
    props.toast('Recording: click the next box · Esc to finish');
  };
  const remove = (j: import('./model/types').Journey) => {
    store.update((s) => { s.journeys = s.journeys.filter((x) => x.id !== j.id); });
    props.toast(`Deleted “${j.name}” (Ctrl+Z to undo)`);
  };

  return (
    <aside class="journeys panel" ref={el}>
      <h3 onClick={() => setOpen(!open())} title={open() ? 'Collapse' : 'Expand'}>
        <Icon name="route" size={16} /> Journeys <span class="count">{list().length || ''}</span>
        <button class="icon sm" title="New journey (records your clicks)" onClick={(e) => { e.stopPropagation(); add(); }}><Icon name="plus" size={16} /></button>
      </h3>
      <Show when={open()}>
        <For each={list()} fallback={<p class="muted small">A journey is a path a user's request takes, e.g. Login or Checkout. Press + and click boxes in order.</p>}>
          {(j) => {
            const shown = () => view()?.id === j.id;
            const recording = () => rec()?.id === j.id;
            return (
              <>
                <div class="layer jrow" classList={{ on: shown() }} onClick={() => { props.stopPlay(); store.setJourney(shown() ? null : j.id); }}>
                  <button class="jdot" style={{ background: j.color }} title="Change color" onClick={(e) => {
                    e.stopPropagation();
                    edit(j.id, (x) => { x.color = JOURNEY_COLORS[(JOURNEY_COLORS.indexOf(x.color) + 1) % JOURNEY_COLORS.length]; });
                  }} />
                  <Show when={renaming() === j.id} fallback={<span class="name" onDblClick={(e) => { e.stopPropagation(); setRenaming(j.id); }} title="Double-click to rename">{j.name}</span>}>
                    <input class="name" value={j.name} ref={(r) => queueMicrotask(() => { r.focus(); r.select(); })}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) edit(j.id, (x) => { x.name = v; }); setRenaming(null); }} />
                  </Show>
                  <Show when={recording()}><span class="recdot" title="Recording" /></Show>
                  <span class="count">{j.steps.length}</span>
                  <span class="acts">
                    <button class="icon sm" title="Play" onClick={(e) => { e.stopPropagation(); props.play(j.id); }}><Icon name="play" size={14} /></button>
                    <button class="icon sm" title="Delete journey" onClick={(e) => { e.stopPropagation(); remove(j); }}><Icon name="trash" size={14} /></button>
                  </span>
                </div>
                <Show when={shown()}>
                  <div class="jsteps">
                    <For each={j.steps}>
                      {(st, k) => (
                        <div class="jstep" classList={{ on: view()?.step === k() }} onClick={() => { props.stopPlay(); store.setJourney(j.id, view()?.step === k() ? -1 : k()); }}>
                          <span class="num" style={{ background: j.color }}>{k() + 1}</span>
                          <div class="jtext">
                            <span class="jhop">{stepText(store.scene, st)}{st.back ? ' (back)' : ''}</span>
                            <input class="note" placeholder="Add a caption…" value={st.note ?? ''}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                              onChange={(e) => { const v = e.currentTarget.value.trim(); edit(j.id, (x) => { if (x.steps[k()]) x.steps[k()].note = v || undefined; }); }} />
                          </div>
                          <span class="acts">
                            <button class="icon sm" title="Reverse direction (e.g. a response)" onClick={(e) => { e.stopPropagation(); edit(j.id, (x) => { const y = x.steps[k()]; if (y) y.back = !y.back || undefined; }); }}><Icon name="swap" size={14} /></button>
                            <button class="icon sm" title="Remove step" onClick={(e) => { e.stopPropagation(); edit(j.id, (x) => { x.steps.splice(k(), 1); }); }}><Icon name="trash" size={14} /></button>
                          </span>
                        </div>
                      )}
                    </For>
                    <Show when={recording()}>
                      <p class="muted small jhint">{store.recordingHead ? 'Click the next box (or a connection). Esc to finish.' : 'Click the box where the journey starts.'}</p>
                    </Show>
                    <div class="jbtns">
                      <button class="btn" classList={{ rec: recording() }} onClick={() => toggleRec(j.id)}>
                        <Icon name={recording() ? 'stop' : 'rec'} size={14} /> {recording() ? 'Done' : j.steps.length ? 'Record more' : 'Record'}
                      </button>
                      <button class="btn" disabled={!j.steps.length} onClick={() => (props.playing() ? props.stopPlay() : props.play(j.id))}>
                        <Icon name={props.playing() ? 'pause' : 'play'} size={14} /> {props.playing() ? 'Pause' : 'Play'}
                      </button>
                    </div>
                  </div>
                </Show>
              </>
            );
          }}
        </For>
      </Show>
    </aside>
  );
}

/** Caption bar for the shown journey: step-by-step playback with the current hop and its caption. */
function JourneyBar(props: { ver: () => number; playing: () => boolean; play: () => void; step: (d: number) => void; close: () => void }) {
  const info = createMemo(() => {
    props.ver();
    const j = store.activeJourney, v = store.journey;
    if (!j || !v) return null;
    const st = v.step >= 0 ? j.steps[v.step] : undefined;
    return { j, step: v.step, n: j.steps.length, hop: st ? stepText(store.scene, st) : '', note: st?.note ?? '', rec: store.recording?.id === j.id };
  });
  return (
    <Show when={info()}>
      {(i) => (
        <div class="journeybar panel" style={{ '--jc': i().j.color }}>
          <span class="jdot" style={{ background: i().j.color }} />
          <b class="jname">{i().j.name}</b>
          <button class="icon" disabled={i().step < 0} onClick={() => props.step(-1)} title="Previous step ([)"><Icon name="prev" /></button>
          <span class="jcap">
            <Show when={i().step >= 0} fallback={<span class="muted">{i().rec ? 'Recording… ' : ''}{i().n} step{i().n === 1 ? '' : 's'}</span>}>
              <span class="jk">{i().step + 1}/{i().n}</span> {i().hop}
              <Show when={i().note}><span class="jnote"> · {i().note}</span></Show>
            </Show>
          </span>
          <button class="icon" disabled={i().step >= i().n - 1} onClick={() => props.step(1)} title="Next step (])"><Icon name="next" /></button>
          <button class="icon" disabled={!i().n} onClick={props.play} title={props.playing() ? 'Pause' : 'Play step by step'}><Icon name={props.playing() ? 'pause' : 'play'} /></button>
          <button class="icon" onClick={props.close} title="Hide journey (Esc)"><Icon name="close" /></button>
        </div>
      )}
    </Show>
  );
}

function Help(props: { close: () => void }) {
  const rows: [string, string][] = [
    ['Tab', 'Switch Design ↔ Play 3D'],
    ['V H A', 'Select · pan · connect'],
    ['S D Q K L C Z T', 'Service · database · queue · cache · LB · client · zone · text'],
    ['Drag / click', 'Draw a shape / drop default size'],
    ['Double-click', 'Edit label (empty canvas: new text)'],
    ['Mouse wheel · pinch', 'Zoom at cursor (trackpad two-finger scroll or Space + drag: pan)'],
    ['Shift+1', 'Fit to content'],
    ['Alt while dragging', 'Disable snapping'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+C / V / D', 'Copy · paste · duplicate'],
    ['Arrows (+Shift)', 'Nudge 1px (10px)'],
    ['— Play 3D —', ''],
    ['F · M', 'Toggle flows · simulation'],
    ['X', 'Kill / revive selected node'],
    ['Alt + drag node', 'Change its height'],
    ['1–9 · P', 'Jump to stop · present tour (←/→, Esc)'],
    ['Shift+1', 'Overview: reset camera to show everything'],
    ['— Journeys —', ''],
    ['Journeys panel ▸ +', 'New journey: click boxes in order to record it'],
    ['[ · ]', 'Previous / next step of the shown journey'],
    ['Esc', 'Finish recording · hide the journey'],
  ];
  return (
    <div class="overlay" onClick={props.close}>
      <div class="help panel" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts <button class="icon sm" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <table>
          <For each={rows}>{([k, v]) => <tr><td><kbd>{k}</kbd></td><td>{v}</td></tr>}</For>
        </table>
      </div>
    </div>
  );
}


const REPO_URL = 'https://github.com/AleB93/8d-modeling';
const AUTHOR_URL = 'https://github.com/AleB93';

function About(props: { close: () => void }) {
  return (
    <div class="overlay" onClick={props.close}>
      <div class="about panel" role="dialog" aria-label="About 8D modeling" onClick={(e) => e.stopPropagation()}>
        <h3><span class="about-title"><Icon name="layers" size={20} /> 8D modeling</span> <button class="icon sm" title="Close" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <p class="lead">Draw your system architecture in 2D, then press <kbd>Tab</kbd> and watch it rise into 3D, where you can run traffic through it.</p>
        <ul>
          <li><b>Design</b>: a fast 2D editor with layers as floors, snapping and undo.</li>
          <li><b>Play 3D</b>: flows, a traffic simulation with capacity, failover and cascading errors, and guided camera tours.</li>
          <li><b>Journeys</b>: record user paths such as login or checkout and replay them step by step.</li>
          <li><b>Share</b>: the whole diagram fits in a link or a standalone HTML file. No server, no account: everything stays in your browser.</li>
          <li><b>AI agents</b>: tools exposed through WebMCP let an in-browser agent build and analyze diagrams.</li>
        </ul>
        <h4>Contact</h4>
        <p>Made by <b>AleB93</b>. Questions, ideas or bugs? Reach me on GitHub.</p>
        <div class="about-links">
          <a class="btn" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer"><Icon name="github" size={16} /> github.com/AleB93</a>
          <a class="btn" href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer"><Icon name="info" size={16} /> Open an issue</a>
        </div>
        <p class="fine">Open source under the <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT License</a> · © 2026 AleB93</p>
      </div>
    </div>
  );
}
