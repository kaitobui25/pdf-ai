// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_DIMENSION,
  MAX_ZOOM,
  MIN_ZOOM,
  boundedOutputScale,
  clampPageNumber,
  clampZoom,
  findPageSearchHits,
  fitWidthScale,
  pageNumberFromNode,
  searchSnippet
} from '../src/renderer/reader-math.js';
import { MAX_RENDER_PIXELS } from '../src/shared/constants.js';

describe('reader math and selection mapping', () => {
  it('bounds zoom and fit-width scale', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(fitWidthScale(800, 600)).toBeGreaterThan(1);
    expect(fitWidthScale(0, 600)).toBe(1);
  });

  it('clamps navigation to valid pages', () => {
    expect(clampPageNumber(-4, 12)).toBe(1);
    expect(clampPageNumber(7.9, 12)).toBe(7);
    expect(clampPageNumber(99, 12)).toBe(12);
  });

  it('bounds canvas memory and dimensions', () => {
    const width = 10_000;
    const height = 10_000;
    const scale = boundedOutputScale(width, height, 4);
    expect(width * scale).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION + 0.001);
    expect(height * scale).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION + 0.001);
    expect(width * height * scale * scale).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1);
  });

  it('maps nested selected text back to its PDF page', () => {
    document.body.innerHTML =
      '<section class="pdf-page" data-page="7"><div class="textLayer"><span id="selected">needle</span></div></section>';
    const textNode = document.querySelector('#selected')?.firstChild ?? null;
    expect(pageNumberFromNode(textNode)).toBe(7);
    expect(pageNumberFromNode(document.body)).toBeNull();
  });

  it('creates bounded search snippets around a match', () => {
    const text = 'before '.repeat(20) + 'needle' + ' after'.repeat(20);
    const at = text.indexOf('needle');
    const snippet = searchSnippet(text, at, 'needle'.length, 20);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('maps search matches to the page that produced them', () => {
    const first = findPageSearchHits('alpha needle alpha', 'alpha', 1, 10);
    const second = findPageSearchHits('needle alpha', 'alpha', 2, 10);
    expect(first.map(hit => hit.page)).toEqual([1, 1]);
    expect(second.map(hit => hit.page)).toEqual([2]);
    expect(first[0]?.index).toBe(0);
  });
});
