import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { store } from '../shared/appStore';
import { DesignCanvas, Tool } from '../features/design/DesignCanvas';
import { TOOLS } from '../features/design/toolbar';
import type { Viewer3D } from '../features/play3d/Viewer3D';
import type { SimResult } from '../features/simulation/sim';
import { demoScene } from '../features/samples/demo';
import { download, idbGet, idbSet, validateScene } from '../features/persistence/persist';
import { decodeShare, shareUrl, ShareView } from '../features/share/share';
import { emptyScene, Scene, SIM_KINDS, Stop } from '../shared/model/types';
import { STEP_MS } from '../features/journeys/journeys';
import { Icon } from '../shared/ui/icons';
import type { AgentUI } from '../features/agent/tools';
import { registerWebMCP, WebMCPStatus } from '../features/agent/webmcp';
import { markWebMCPHintSeen, shouldHintWebMCP } from '../features/agent/webmcpHelp';
import { AgentPill } from '../features/agent/AgentPill';
import { installPageApi } from '../features/agent/pageApi';
import { WebMCPHint } from '../features/agent/WebMCPHint';
import { About } from '../features/about/About';
import { Help } from '../features/help/Help';
import { LabelEditor } from '../features/design/LabelEditor';
import { Inspector } from '../features/inspector/Inspector';
import { LayersPanel } from '../features/layers/LayersPanel';
import { SimPanel } from '../features/simulation/SimPanel';
import { TourPanel } from '../features/tour/TourPanel';
import { Tooltip } from '../features/play3d/Tooltip';
import { JourneysPanel } from '../features/journeys/JourneysPanel';
import { JourneyBar } from '../features/journeys/JourneyBar';
import { SceneOutline } from '../features/outline/SceneOutline';
import { isTyping } from '../shared/ui/dom';

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
  const [agentHint, setAgentHint] = createSignal(false);
  const [outline, setOutline] = createSignal(false);
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
      focus: focusNode,
      setSimulation: (on) => { if (on !== simOn()) toggleSim(); },
      setFlows: (on) => { if (on !== flows()) toggleFlows(); },
      fit: () => design.fit(),
      captureView,
      captureStop: async (name) => {
        await toPlay();
        if (!viewer) throw new Error('The 3D view is not available');
        return captureStop(name);
      },
      goStop: async (i) => { await toPlay(); goStop(i); },
      present: async (on) => {
        if (!on) return void setPresent(null);
        await toPlay();
        startPresent();
      },
      overview: async () => { await toPlay(); viewer?.overview(); },
      setMultiplier: setMultiplier,
      playJourney: (id) => playJourney(id),
      exportFile: (f) => (f === 'json' ? Promise.resolve(actions.exportJson()) : f === 'html' ? actions.exportHtml() : actions.exportPng()),
    };
    const loadTools = async () => (await import('../features/agent/tools')).createTools(store, agentUI);
    // Same tools for any agent that can run JavaScript here (e.g. Claude in Chrome), in every browser.
    const pageApi = installPageApi(loadTools, new URL('llms.txt', document.baseURI).href);
    const reg = await registerWebMCP(loadTools);
    setAgent(reg.status);
    if (!reg.status.supported && shouldHintWebMCP()) setTimeout(() => setAgentHint(true), 1200);
    import.meta.hot?.dispose(reg.unregister); // app root never unmounts; only dev reloads need cleanup

    if (import.meta.env.DEV) {
      // dev-only console handle (the agent tools themselves are public: window.modeling8d)
      (window as any).__modeling8d = {
        store, design, viewer: () => viewer, agent: reg.status, tools: pageApi.tools,
        stress: async (n = 2000) => replaceScene((await import('../features/samples/stress')).stressScene(n)),
      };
    }
    if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });

  /** Select a node and bring it into view in the current mode. */
  function focusNode(id: string) {
    store.select([id]);
    if (mode() === 'play') viewer?.focusNode(id);
    else {
      const n = store.scene.nodes[id];
      if (n) design.setView({ cx: n.x + n.w / 2, cy: n.y + n.h / 2, width: Math.max(800, design.getView().width * 0.6) });
    }
  }

  // ---------- modes ----------
  async function toPlay() {
    if (mode() === 'play' || busy()) return;
    setBusy(true);
    setEditing(null);
    setMenu(false);
    if (!viewer) {
      try {
        const { Viewer3D } = await import('../features/play3d/Viewer3D');
        viewer = new Viewer3D(host3d, store, { onHover: setHover, onSim: setStats, onToast: toastMsg });
      } catch {
        // Usually a new version was deployed while this tab was open, so the old 3D file is gone.
        // The diagram is autosaved, so reloading is safe.
        setBusy(false);
        toastMsg('Couldn’t load the 3D view: 8D modeling may have been updated. Reload the page; your diagram is saved.');
        return;
      }
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

  /** Current 3D camera as a tour stop, remembering the journey on screen. */
  function captureStop(name: string): Stop {
    const st = viewer!.captureStop(name);
    if (store.journey) st.journey = store.journey.id;
    return st;
  }
  const setMultiplier = (v: number) => { setMult(v); if (viewer) viewer.sim.multiplier = v; };

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
    if (e.key.toLowerCase() === 'o' && !(e.metaKey || e.ctrlKey || e.altKey)) { setOutline((v) => !v); return; }
    if (e.key === 'Escape' && outline()) { setOutline(false); return; }
    if (e.key === 'Escape' && agentHint()) { markWebMCPHintSeen(); setAgentHint(false); return; }
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
    exportJson: () => {
      download('system.8d-modeling.json', new Blob([JSON.stringify(store.scene, null, 2)], { type: 'application/json' }));
      return 'system.8d-modeling.json';
    },
    exportHtml: async () => {
      const { sceneToHtml } = await import('../features/export/html'); // lazy: pulls in three only for REVISION
      download('system-3d.html', new Blob([sceneToHtml(store.scene)], { type: 'text/html' }));
      toastMsg('Exported a standalone 3D viewer (needs internet to load three.js)');
      return 'system-3d.html';
    },
    exportPng: async () => {
      if (mode() === 'play' && viewer) {
        const blob = await (await fetch(viewer.snapshot())).blob();
        download('system-3d.png', blob);
        return 'system-3d.png';
      }
      const b = await design.exportPNG();
      if (!b) throw new Error('Could not render the 2D view');
      download('system-2d.png', b);
      return 'system-2d.png';
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
          <Show when={agent()}>{(a) => <AgentPill status={a()} toast={toastMsg} />}</Show>
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
                <button onClick={() => actions.exportPng().catch((e: Error) => toastMsg(e.message))}>Export PNG ({mode() === 'play' ? '3D' : '2D'} view)</button>
                <hr />
                <button onClick={actions.demo}>Load demo system</button>
                <button onClick={actions.newScene}>New empty scene</button>
                <hr />
                <button onClick={() => setOutline(true)} title="The diagram as a clickable list (O)">Diagram list</button>
                <button onClick={() => setAbout(true)}>About 8D modeling</button>
              </div>
            </Show>
          </div>
        </div>
      </header>
      <input ref={fileIn} type="file" accept=".json,application/json" hidden onChange={onFile} />

      <LayersPanel ver={ver} toast={toastMsg} />
      <SceneOutline ver={ver} open={outline()} close={() => setOutline(false)} focus={focusNode} showJourney={(id) => store.setJourney(id)} />
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
          <SimPanel stats={stats} mult={mult} setMult={setMultiplier} />
        </Show>
        <TourPanel ver={ver} go={goStop} present={startPresent} capture={captureStop} />
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
      <Show when={agentHint()}><WebMCPHint close={() => { markWebMCPHintSeen(); setAgentHint(false); }} toast={toastMsg} /></Show>
      <Show when={toast()}><div class="toast">{toast()}</div></Show>
    </div>
  );
}
