import type { WebMCPStatus } from './webmcp';
import { flagHelpMessage, isChrome, pillState, pillTitle } from './webmcpHelp';

/** Top-bar WebMCP status. Click: run a test call through the browser, or copy the flag URL when WebMCP is missing. */
export function AgentPill(props: { status: WebMCPStatus; toast: (m: string) => void }) {
  const test = async () => {
    if (!props.status.supported) {
      props.toast(await flagHelpMessage(isChrome(), (t) => navigator.clipboard.writeText(t)));
      return;
    }
    const { selfTestWebMCP } = await import('./webmcp');
    props.toast((await selfTestWebMCP()).message);
  };
  return (
    <button class={`agentpill panel ${pillState(props.status)}`} title={pillTitle(props.status)} data-webmcp={pillState(props.status)} onClick={test}>
      <span class="adot" /> WebMCP
    </button>
  );
}
