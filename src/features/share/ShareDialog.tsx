import { createSignal, onMount } from 'solid-js';
import { Icon } from '../../shared/ui/icons';
import { copyText, execCopy } from './copyText';

/**
 * Shown when the link couldn't be copied automatically (embedded browsers, webviews, denied
 * clipboard permission). Drawn by the page itself: `window.prompt()` is blocked in those hosts too.
 */
export function ShareDialog(props: { url: string; title: string; close: () => void }) {
  let input!: HTMLInputElement;
  const [state, setState] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  const selectAll = () => { input.focus(); input.select(); };
  onMount(selectAll);

  const copy = async () => {
    selectAll();
    // inside a click the page has focus, so either path may now work
    const ok = execCopy(props.url) || (await copyText(props.url));
    setState(ok ? 'copied' : 'failed');
    selectAll();
  };

  return (
    <div class="overlay" onClick={props.close}>
      <div class="share-dialog panel" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h3>{props.title} <button class="icon sm" title="Close (Esc)" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <p class="fine">This browser didn't allow copying automatically. Copy the link below.</p>
        <div class="share-row">
          <input ref={input} readonly value={props.url} aria-label="Share link" spellcheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); props.close(); } }} />
          <button class="btn primary" onClick={copy}>{state() === 'copied' ? 'Copied' : 'Copy'}</button>
        </div>
        <p class="fine">
          {state() === 'failed' ? 'Still blocked: the link is selected, press Ctrl+C (⌘C on Mac).' : `${(props.url.length / 1024).toFixed(1)} KB · nothing is uploaded, the diagram is in the link`}
        </p>
      </div>
    </div>
  );
}
