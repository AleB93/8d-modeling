// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLAG_URL, flagHelpMessage, isChrome, isMobile, markWebMCPHintSeen, pillState, pillTitle, shouldHintWebMCP } from './webmcpHelp';
import type { WebMCPStatus } from './webmcp';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const nav = (userAgent: string, brands?: string[]) =>
  ({ userAgent, ...(brands ? { userAgentData: { brands: brands.map((brand) => ({ brand })) } } : {}) }) as unknown as Navigator;

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('webmcpHelp (adversarial)', () => {
  it('isMobile: Android tablets without "Mobile" and iPads are still mobile; desktop Linux is not', () => {
    expect(isMobile('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/157 Safari/537.36')).toBe(true);
    expect(isMobile('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true);
    expect(isMobile('Mozilla/5.0 (X11; Linux x86_64) Chrome/157 Safari/537.36')).toBe(false);
    expect(isMobile('')).toBe(false);
  });

  it('isChrome: Chrome on iOS (CriOS) and headless are not desktop Chrome flags-capable; Edge/Opera excluded', () => {
    expect(isChrome(nav('Mozilla/5.0 (iPhone) CriOS/157.0 Mobile Safari/604.1'))).toBe(false);
    expect(isChrome(nav(CHROME_UA))).toBe(true);
    expect(isChrome(nav(CHROME_UA + ' Edg/157'))).toBe(false);
    expect(isChrome(nav(CHROME_UA + ' OPR/110'))).toBe(false);
    expect(isChrome(nav('', ['Not)A;Brand', 'Chromium']))).toBe(false);
  });

  it('isChrome: client hints win over the UA string', () => {
    expect(isChrome(nav(CHROME_UA, []))).toBe(false);
    expect(isChrome(nav('Firefox', ['Google Chrome']))).toBe(true);
  });

  it('hint: marking seen is permanent and survives repeated calls', () => {
    expect(shouldHintWebMCP()).toBe(true);
    markWebMCPHintSeen();
    markWebMCPHintSeen();
    expect(shouldHintWebMCP()).toBe(false);
  });

  it('pillState: registered wins even if supported is false (inconsistent status)', () => {
    const s: WebMCPStatus = { supported: false, via: 'navigator.modelContext', method: 'provideContext', registered: 3 };
    expect(pillState(s)).toBe('ok');
    expect(pillTitle(s)).toContain('3 tools registered via navigator.modelContext.provideContext()');
  });

  it('pillTitle: every state is a single sentence pair with no doubled punctuation', () => {
    const states: WebMCPStatus[] = [
      { supported: true, via: 'document.modelContext', method: 'registerTool', registered: 1 },
      { supported: true, via: 'document.modelContext', method: null, registered: 0, error: 'x' },
      { supported: false, via: null, method: null, registered: 0 },
    ];
    for (const s of states) {
      const t = pillTitle(s);
      expect(t).not.toMatch(/\.\./);
      expect(t).not.toContain('undefined');
      expect(t).not.toContain('null');
    }
  });

  it('flagHelpMessage: a copy function that throws synchronously is handled like a rejection', async () => {
    const msg = await flagHelpMessage(true, () => { throw new Error('sync'); });
    expect(msg).toBe(`Open ${FLAG_URL} in the address bar, set it to Enabled, then relaunch Chrome.`);
  });

  it('flagHelpMessage always mentions the flag URL', async () => {
    for (const chrome of [true, false]) {
      expect(await flagHelpMessage(chrome, async () => {})).toContain(FLAG_URL);
      expect(await flagHelpMessage(chrome, () => Promise.reject(new Error()))).toContain(FLAG_URL);
    }
  });
});
