import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import { JOURNEY_COLORS, uid } from '../../shared/model/types';
import type { Journey } from '../../shared/model/types';
import { stepText } from './journeys';
import { Icon } from '../../shared/ui/icons';

export function JourneysPanel(props: {
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

  const edit = (id: string, fn: (j: Journey) => void, key?: string) =>
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
  const remove = (j: Journey) => {
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
