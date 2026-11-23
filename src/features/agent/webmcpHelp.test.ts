// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_URL, flagHelpMessage, isChrome, isMobile, markWebMCPHintSeen, pillState, pillTitle, shouldHintWebMCP,
} from './webmcpHelp';
import type { WebMCPStatus } from './webmcp';

const CHROME_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const nav = (userAgent: string, brands?: string[]) =>
  ({ userAgent, ...(brands ? { userAgentData: { brands: brands.map((brand) => ({ brand })) } } : {}) }) as unknown as Navigator;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('isMobile', () => {
  it('detects phones and tablets', () => {
    expect(isMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')).toBe(true);
    expect(isMobile('Mozilla/5.0 (Linux; Android 15) Mobile')).toBe(true);
    expect(isMobile(CHROME_UA)).toBe(false);
  });
  it('defaults to the current browser', () => expect(isMobile()).toBe(false));
});

describe('isChrome', () => {
  it('trusts client hints when present', () => {
    expect(isChrome(nav('x', ['Chromium', 'Google Chrome']))).toBe(true);
    expect(isChrome(nav(CHROME_UA, ['Chromium', 'Microsoft Edge']))).toBe(false);
  });
  it('falls back to the user agent and excludes other Chromium browsers', () => {
    expect(isChrome(nav(CHROME_UA))).toBe(true);
    expect(isChrome(nav(CHROME_UA + ' Edg/157.0'))).toBe(false);
    expect(isChrome(nav(CHROME_UA + ' OPR/120.0'))).toBe(false);
    expect(isChrome(nav('Mozilla/5.0 (Macintosh) Version/19.0 Safari/605.1.15'))).toBe(false);
  });
  it('defaults to the current browser (jsdom is not Chrome)', () => expect(isChrome()).toBe(false));
});

describe('one-time hint', () => {
  it('shows until marked seen, then never again', () => {
    expect(shouldHintWebMCP()).toBe(true);
    markWebMCPHintSeen();
    expect(shouldHintWebMCP()).toBe(false);
  });
  it('never shows on mobile', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone)');
    expect(shouldHintWebMCP()).toBe(false);
  });
  it('stays hidden and does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(shouldHintWebMCP()).toBe(false);
    expect(() => markWebMCPHintSeen()).not.toThrow();
  });
});

describe('status pill', () => {
  const ok: WebMCPStatus = { supported: true, via: 'document.modelContext', method: 'registerTool', registered: 12 };
  const failed: WebMCPStatus = { supported: true, via: 'navigator.modelContext', method: null, registered: 0, error: 'boom' };
  const off: WebMCPStatus = { supported: false, via: null, method: null, registered: 0 };

  it('maps status to a state', () => {
    expect(pillState(ok)).toBe('ok');
    expect(pillState(failed)).toBe('warn');
    expect(pillState(off)).toBe('off');
  });
  it('explains each state and what a click does', () => {
    expect(pillTitle(ok)).toBe('WebMCP active: 12 tools registered via document.modelContext.registerTool(). Click to run a test call.');
    expect(pillTitle(failed)).toBe('WebMCP found (navigator.modelContext) but registration failed: boom. Click to run a test call.');
    expect(pillTitle({ ...failed, error: undefined })).toContain('registration failed: unknown error');
    expect(pillTitle(off)).toBe(`WebMCP not available in this browser (enable ${FLAG_URL}). Click to copy the flag URL.`);
  });
});

describe('flagHelpMessage', () => {
  it('tells non-Chrome users to switch browser without copying', async () => {
    const copy = vi.fn();
    expect(await flagHelpMessage(false, copy)).toMatch(/^WebMCP needs Chrome/);
    expect(copy).not.toHaveBeenCalled();
  });
  it('copies the flag URL in Chrome', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await flagHelpMessage(true, copy)).toMatch(/^Copied chrome:\/\/flags/);
    expect(copy).toHaveBeenCalledWith(FLAG_URL);
  });
  it('falls back to instructions when the clipboard is unavailable', async () => {
    expect(await flagHelpMessage(true, () => Promise.reject(new Error('denied')))).toMatch(/^Open chrome:\/\/flags/);
  });
});
