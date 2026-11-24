// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, execCopy } from './copyText';

// Embedded browsers and webviews reject the Clipboard API; copyText must fall back, never throw.

const setClipboard = (writeText?: (t: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
const setExec = (impl?: (cmd: string) => boolean) =>
  Object.defineProperty(document, 'execCommand', { value: impl, configurable: true, writable: true });

afterEach(() => {
  setClipboard(undefined);
  setExec(undefined);
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('uses the Clipboard API when it works', async () => {
    const writeText = vi.fn(async () => {});
    const exec = vi.fn(() => true);
    setClipboard(writeText);
    setExec(exec);
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the Clipboard API is rejected', async () => {
    setClipboard(async () => { throw new DOMException('Document is not focused', 'NotAllowedError'); });
    let copied = '';
    setExec((cmd) => { copied = (document.activeElement as HTMLTextAreaElement).value; return cmd === 'copy'; });
    expect(await copyText('https://x/#z=abc')).toBe(true);
    expect(copied).toBe('https://x/#z=abc');
    expect(document.querySelector('textarea')).toBeNull(); // temporary textarea removed
  });

  it('returns false, without throwing, when every path is blocked', async () => {
    setClipboard(async () => { throw new Error('denied'); });
    setExec(() => { throw new Error('not supported'); });
    await expect(copyText('x')).resolves.toBe(false);
    setExec(() => false);
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('works when there is no Clipboard API at all', async () => {
    setClipboard(undefined);
    setExec(() => true);
    expect(await copyText('x')).toBe(true);
  });

  it('execCopy gives the focus back to the element that had it', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    setExec(() => true);
    expect(execCopy('x')).toBe(true);
    expect(document.activeElement).toBe(input);
  });
});
