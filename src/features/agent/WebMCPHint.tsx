import { Show } from 'solid-js';
import { Icon } from '../../shared/ui/icons';
import { FLAG_URL, isChrome } from './webmcpHelp';

export function WebMCPHint(props: { close: () => void; toast: (m: string) => void }) {
  const chrome = isChrome();
  const copy = async (text: string, done: string) => {
    try { await navigator.clipboard.writeText(text); props.toast(done); }
    catch { props.toast(`Copy this: ${text}`); }
    props.close();
  };
  return (
    <div class="overlay" onClick={props.close}>
      <div class="about webmcp-hint panel" role="dialog" aria-label="Use AI agents with 8D modeling" onClick={(e) => e.stopPropagation()}>
        <h3><span class="about-title"><Icon name="bolt" size={20} /> Let AI agents edit your diagram</span> <button class="icon sm" title="Close" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <p>8D modeling exposes its editing tools through <b>WebMCP</b>, so an AI agent in your browser can build, simulate and explain diagrams for you. For now, WebMCP works only in <b>Google Chrome</b> with a flag turned on.</p>
        <Show when={chrome} fallback={
          <ol>
            <li>Open this page in Google Chrome.</li>
            <li>Go to <code>{FLAG_URL}</code>, set it to <b>Enabled</b> and relaunch Chrome.</li>
          </ol>
        }>
          <ol>
            <li>Paste <code>{FLAG_URL}</code> into the address bar.</li>
            <li>Set <b>WebMCP for testing</b> to <b>Enabled</b> and relaunch Chrome.</li>
          </ol>
        </Show>
        <p class="fine">Everything else works without it. You can always find this again on the <b>WebMCP</b> button at the top.</p>
        <div class="about-links">
          <Show when={chrome} fallback={
            <button class="btn primary" onClick={() => copy(location.href, 'Page link copied: open it in Chrome.')}>Copy page link for Chrome</button>
          }>
            <button class="btn primary" onClick={() => copy(FLAG_URL, `Copied ${FLAG_URL}: paste it in the address bar, enable it, then relaunch Chrome.`)}>Copy flag link</button>
          </Show>
          <button class="btn" onClick={props.close}>Got it</button>
        </div>
      </div>
    </div>
  );
}
