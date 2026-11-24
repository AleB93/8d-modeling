/**
 * Copy text to the clipboard. Returns false instead of throwing when the host refuses.
 *
 * Tries the async Clipboard API first, then the legacy `execCommand('copy')` on a hidden textarea.
 * Embedded browsers and webviews often reject the first ("Document is not focused", permission
 * denied) but allow the second during a click.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return execCopy(text);
}

/** Legacy copy through a temporary off-screen textarea. Keeps the focus where it was. */
export function execCopy(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(ta);
  try {
    ta.focus(); // some engines copy only from a focused field
    ta.select();
    return document.execCommand?.('copy') === true;
  } catch {
    return false;
  } finally {
    ta.remove();
    prev?.focus?.();
  }
}
