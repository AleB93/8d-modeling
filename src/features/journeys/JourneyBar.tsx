import { createMemo, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import { stepText } from './journeys';
import { Icon } from '../../shared/ui/icons';

export function JourneyBar(props: { ver: () => number; playing: () => boolean; play: () => void; step: (d: number) => void; close: () => void }) {
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
