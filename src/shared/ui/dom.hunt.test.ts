// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTyping } from './dom';

describe('isTyping (adversarial)', () => {
  it('ignores non-HTMLElement targets (SVG, text nodes, document, plain objects)', () => {
    expect(isTyping(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))).toBe(false);
    expect(isTyping(document.createTextNode('x') as unknown as EventTarget)).toBe(false);
    expect(isTyping(document)).toBe(false);
    expect(isTyping({} as EventTarget)).toBe(false);
    expect(isTyping(undefined as unknown as null)).toBe(false);
  });

  it('matches tag names case-insensitively via the DOM (uppercase tagName)', () => {
    const el = document.createElement('INPUT');
    expect(isTyping(el)).toBe(true);
    expect(isTyping(document.createElement('option'))).toBe(false);
    expect(isTyping(document.createElement('label'))).toBe(false);
  });

  it('treats a non-editable element inside nothing special as not typing', () => {
    const d = document.createElement('div');
    Object.defineProperty(d, 'isContentEditable', { value: false });
    expect(isTyping(d)).toBe(false);
  });
});
