import { vi } from 'vitest';

// Fakes for browser APIs jsdom lacks, so UI smoke tests can mount real components.

/** A CanvasRenderingContext2D whose every method is a no-op (measureText returns a plausible width). */
function fake2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const special: Record<string, unknown> = {
    canvas,
    measureText: (t: string) => ({ width: t.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    getLineDash: () => [],
  };
  const props: Record<string | symbol, unknown> = {};
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, k) => (k in special ? special[k as string] : k in props ? props[k] : () => {}),
    set: (_t, k, v) => ((props[k] = v), true),
  });
}

export function installBrowserFakes() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return fake2d(this) as any;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any;
  // Give layout a size so renderers don't bail on 0×0.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON() {} } as DOMRect,
  );
}
