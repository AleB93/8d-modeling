// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTyping } from './dom';

describe('isTyping', () => {
  it('is true for text inputs and editable elements', () => {
    for (const tag of ['input', 'textarea', 'select']) expect(isTyping(document.createElement(tag))).toBe(true);
    const div = document.createElement('div');
    div.contentEditable = 'true';
    Object.defineProperty(div, 'isContentEditable', { value: true }); // jsdom doesn't compute it
    expect(isTyping(div)).toBe(true);
  });
  it('is false for other elements and non-elements', () => {
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(window)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
