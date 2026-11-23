import type { WebMCPStatus } from './webmcp';

// Helping people turn WebMCP on: browser detection, the one-time popup flag, and the status pill's texts.

export const FLAG_URL = 'chrome://flags/#enable-webmcp-testing';
const HINT_KEY = '8dm.webmcpHintSeen';

export const isMobile = (ua = navigator.userAgent) => /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

/** Google Chrome specifically (WebMCP's flag exists only there), not other Chromium browsers. */
export function isChrome(nav: Navigator = navigator): boolean {
  const brands: { brand: string }[] | undefined = (nav as any).userAgentData?.brands;
  if (brands) return brands.some((b) => b.brand === 'Google Chrome');
  return /Chrome\//.test(nav.userAgent) && !/Edg\/|OPR\/|Brave/.test(nav.userAgent);
}

/** Show the popup once per browser, never on phones/tablets (no WebMCP there). */
export function shouldHintWebMCP(): boolean {
  try { return !isMobile() && !localStorage.getItem(HINT_KEY); } catch { return false; }
}

/** Any dismissal is final. */
export function markWebMCPHintSeen(): void {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* storage blocked: it just shows again next time */ }
}

export type PillState = 'ok' | 'warn' | 'off';

export const pillState = (s: WebMCPStatus): PillState => (s.registered ? 'ok' : s.supported ? 'warn' : 'off');

export function pillTitle(s: WebMCPStatus): string {
  const tip = s.registered
    ? `WebMCP active: ${s.registered} tools registered via ${s.via}.${s.method}()`
    : s.supported
      ? `WebMCP found (${s.via}) but registration failed: ${s.error ?? 'unknown error'}`
      : `WebMCP not available in this browser (enable ${FLAG_URL})`;
  return `${tip}. ${s.supported ? 'Click to run a test call.' : 'Click to copy the flag URL.'}`;
}

/** What clicking the pill does when WebMCP is missing: copy the flag URL (pages can't open chrome:// URLs). */
export async function flagHelpMessage(chrome: boolean, copy: (t: string) => Promise<void>): Promise<string> {
  if (!chrome) return `WebMCP needs Chrome: open this page in Chrome and enable ${FLAG_URL}`;
  try {
    await copy(FLAG_URL);
    return `Copied ${FLAG_URL} — paste it in the address bar, set it to Enabled, then relaunch Chrome.`;
  } catch {
    return `Open ${FLAG_URL} in the address bar, set it to Enabled, then relaunch Chrome.`;
  }
}
