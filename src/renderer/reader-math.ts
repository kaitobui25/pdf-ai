import { MAX_RENDER_PIXELS } from '../shared/constants.js';
import type { PdfSearchHit } from '../shared/pdf.js';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.2;
export const MAX_CANVAS_DIMENSION = 8192;
export const MAX_PAGE_CSS_DIMENSION = 32_768;
export const MAX_READER_PAGES = 5_000;
export const THUMBNAIL_MAX_WIDTH = 112;
export const THUMBNAIL_MAX_HEIGHT = 160;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function fitWidthScale(containerWidth: number, pageWidth: number): number {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(pageWidth) || containerWidth <= 0 || pageWidth <= 0) return 1;
  return clampZoom(Math.max(120, containerWidth - 32) / pageWidth);
}

export function clampPageNumber(page: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount < 1) return 1;
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.min(Math.trunc(pageCount), Math.trunc(page)));
}

export function boundedOutputScale(width: number, height: number, devicePixelRatio = 1): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const pixelBound = Math.sqrt(MAX_RENDER_PIXELS / (width * height));
  return Math.min(
    2,
    Math.max(1, devicePixelRatio || 1),
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height,
    pixelBound
  );
}

export function isRenderableViewport(width: number, height: number): boolean {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_PAGE_CSS_DIMENSION &&
    height <= MAX_PAGE_CSS_DIMENSION &&
    width * height <= 100_000_000;
}

export function thumbnailScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(
    0.4,
    THUMBNAIL_MAX_WIDTH / width,
    THUMBNAIL_MAX_HEIGHT / height
  );
}

export function searchSnippet(text: string, index: number, queryLength: number, radius = 48): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + queryLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

export function findPageSearchHits(
  text: string,
  query: string,
  page: number,
  maxHits: number
): PdfSearchHit[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || maxHits <= 0) return [];
  const lower = text.toLocaleLowerCase();
  const hits: PdfSearchHit[] = [];
  let from = 0;
  while (hits.length < maxHits) {
    const at = lower.indexOf(normalized, from);
    if (at < 0) break;
    hits.push({ page, index: at, snippet: searchSnippet(text, at, normalized.length) });
    from = at + Math.max(1, normalized.length);
  }
  return hits;
}

export function pageNumberFromNode(node: Node | null): number | null {
  if (!node) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const page = element?.closest<HTMLElement>('.pdf-page');
  if (!page) return null;
  const value = Number(page.dataset.page);
  return Number.isInteger(value) && value > 0 ? value : null;
}
