// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedPdf } from '../src/shared/pdf.js';

const pdfjs = vi.hoisted(() => {
  const documents: Array<unknown> = [];
  const tasks: Array<{ promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> }> = [];

  class FakeTextLayer {
    private cancelled = false;

    constructor(private readonly options: { container: HTMLElement }) {}

    async render(): Promise<void> {
      if (this.cancelled) return;
      const span = document.createElement('span');
      span.className = 'fake-text';
      span.textContent = 'Selectable page text';
      this.options.container.append(span);
    }

    cancel(): void {
      this.cancelled = true;
    }
  }

  const getDocument = vi.fn(() => {
    const document = documents.shift();
    if (!document) throw new Error('No fake PDF queued');
    const task = {
      promise: Promise.resolve(document),
      destroy: vi.fn(async () => undefined)
    };
    tasks.push(task);
    return task;
  });

  return { documents, tasks, FakeTextLayer, getDocument };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  TextLayer: pdfjs.FakeTextLayer,
  getDocument: pdfjs.getDocument
}));

import { PdfReader } from '../src/renderer/pdf-reader.js';
import {
  MAX_READER_PAGES,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH
} from '../src/renderer/reader-math.js';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  private readonly observed = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe = vi.fn((target: Element) => {
    this.observed.add(target);
  });

  unobserve = vi.fn((target: Element) => {
    this.observed.delete(target);
  });

  disconnect = vi.fn(() => {
    this.observed.clear();
  });

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(target: Element, isIntersecting: boolean): void {
    if (!this.observed.has(target)) return;
    const entry = {
      target,
      isIntersecting,
      time: 0,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null
    } as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    void this.callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderTask(): { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> } {
  return { promise: Promise.resolve(), cancel: vi.fn() };
}

function makePdf(
  pageCount = 3,
  options: {
    delayedText?: Deferred<{ items: Array<{ str: string; hasEOL: boolean }> }>;
    extremeThumbnailPage?: number;
  } = {}
) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => {
      const extreme = pageNumber === options.extremeThumbnailPage;
      const baseWidth = extreme ? 1 : 600;
      const baseHeight = extreme ? 1_000_000 : 800;
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: baseWidth * scale,
          height: baseHeight * scale
        }),
        render: vi.fn(() => renderTask()),
        streamTextContent: vi.fn(() => new ReadableStream()),
        getTextContent: vi.fn(() => {
          if (pageNumber === 1 && options.delayedText) return options.delayedText.promise;
          return Promise.resolve({
            items: [{ str: pageNumber === 1 ? 'alpha needle' : 'beta text', hasEOL: false }]
          });
        })
      };
    }),
    getOutline: vi.fn(async () => null),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async () => 0),
    cleanup: vi.fn(async () => undefined)
  };
}

function openedPdf(id: string): OpenedPdf {
  return {
    documentId: id,
    name: id + '.pdf',
    bytes: new Uint8Array([1, 2, 3]),
    size: 3,
    modifiedAt: '2026-09-29T00:00:00.000Z'
  };
}

function createElements() {
  document.body.innerHTML =
    '<div id="viewport"><div id="pages"></div></div>' +
    '<div id="outline"></div>' +
    '<div id="thumbnails"></div>';
  const viewport = document.querySelector<HTMLElement>('#viewport')!;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 900 });
  return {
    viewport,
    pages: document.querySelector<HTMLElement>('#pages')!,
    outline: document.querySelector<HTMLElement>('#outline')!,
    thumbnails: document.querySelector<HTMLElement>('#thumbnails')!
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  pdfjs.documents.length = 0;
  pdfjs.tasks.length = 0;
  pdfjs.getDocument.mockClear();
  FakeIntersectionObserver.instances.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({ drawImage: vi.fn() }))
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('PdfReader behavior', () => {
  it('navigates pages, toggles zoom/fit, and keeps page surfaces lazy', async () => {
    pdfjs.documents.push(makePdf(3));
    const elements = createElements();
    const pages: number[] = [];
    const reader = new PdfReader(elements, {
      onPageChanged: page => pages.push(page)
    });

    await reader.open(openedPdf('doc-a'));

    expect(elements.pages.querySelectorAll('.pdf-page')).toHaveLength(3);
    expect(elements.pages.querySelectorAll('canvas')).toHaveLength(1);
    expect(elements.thumbnails.querySelectorAll('canvas')).toHaveLength(0);
    expect(reader.pageNumber).toBe(1);
    expect(reader.isFitWidth).toBe(true);

    reader.goToPage(99);
    await settle();
    expect(reader.pageNumber).toBe(3);
    expect(pages.at(-1)).toBe(3);

    reader.zoomIn();
    expect(reader.isFitWidth).toBe(false);
    reader.fitToWidth();
    expect(reader.isFitWidth).toBe(true);

    const pageOne = elements.pages.querySelector<HTMLElement>('[data-page="1"]')!;
    const pageObserver = FakeIntersectionObserver.instances[0]!;
    pageObserver.trigger(pageOne, false);
    await settle();
    expect(pageOne.querySelector('canvas')).toBeNull();
    expect(pageOne.querySelector('.pdf-text-layer')).toBeNull();

    reader.destroy();
  });

  it('extracts selected text with the owning PDF page', async () => {
    pdfjs.documents.push(makePdf(2));
    const elements = createElements();
    const selections: Array<{ text: string; page: number | null }> = [];
    const reader = new PdfReader(elements, {
      onSelectionChanged: (text, page) => selections.push({ text, page })
    });
    await reader.open(openedPdf('doc-selection'));

    const span = elements.pages.querySelector<HTMLElement>('[data-page="1"] .fake-text')!;
    const textNode = span.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(90);

    expect(selections.at(-1)).toEqual({ text: 'Selectable page text', page: 1 });
    reader.destroy();
  });

  it('cancels stale search results when another document opens', async () => {
    const delayed = deferred<{ items: Array<{ str: string; hasEOL: boolean }> }>();
    pdfjs.documents.push(makePdf(2, { delayedText: delayed }));
    const elements = createElements();
    const reader = new PdfReader(elements);
    await reader.open(openedPdf('doc-old'));

    const pendingSearch = reader.search('alpha');
    await Promise.resolve();
    await Promise.resolve();

    pdfjs.documents.push(makePdf(1));
    const opening = reader.open(openedPdf('doc-new'));
    delayed.resolve({ items: [{ str: 'alpha stale', hasEOL: false }] });
    await opening;

    expect(await pendingSearch).toEqual([]);
    expect(reader.documentId).toBe('doc-new');
    reader.destroy();
  });

  it('never destroys the newer loading task when overlapping opens settle out of order', async () => {
    const firstPdf = deferred<ReturnType<typeof makePdf>>();
    pdfjs.documents.push(firstPdf.promise, makePdf(1));
    const elements = createElements();
    const reader = new PdfReader(elements);

    const firstOpen = reader.open(openedPdf('doc-first'));
    await Promise.resolve();
    await Promise.resolve();
    const firstTask = pdfjs.tasks[0]!;

    const secondOpen = reader.open(openedPdf('doc-second'));
    await secondOpen;
    const secondTask = pdfjs.tasks[1]!;
    expect(reader.documentId).toBe('doc-second');

    firstPdf.resolve(makePdf(1));
    await firstOpen;

    expect(reader.documentId).toBe('doc-second');
    expect(firstTask.destroy).toHaveBeenCalled();
    expect(secondTask.destroy).not.toHaveBeenCalled();
    reader.destroy();
  });

  it('bounds extreme thumbnails and releases them outside the thumbnail viewport', async () => {
    pdfjs.documents.push(makePdf(2, { extremeThumbnailPage: 2 }));
    const elements = createElements();
    const reader = new PdfReader(elements);
    await reader.open(openedPdf('doc-thumb'));

    const thumbTwo = elements.thumbnails.querySelector<HTMLElement>('[data-page="2"]')!;
    const thumbnailObserver = FakeIntersectionObserver.instances[1]!;
    thumbnailObserver.trigger(thumbTwo, true);
    await settle();

    const canvas = thumbTwo.querySelector<HTMLCanvasElement>('canvas')!;
    expect(canvas.width).toBeLessThanOrEqual(THUMBNAIL_MAX_WIDTH);
    expect(canvas.height).toBeLessThanOrEqual(THUMBNAIL_MAX_HEIGHT);

    thumbnailObserver.trigger(thumbTwo, false);
    expect(thumbTwo.querySelector('canvas')).toBeNull();
    reader.destroy();
  });

  it('rejects page counts above the explicit reader limit', async () => {
    pdfjs.documents.push(makePdf(MAX_READER_PAGES + 1));
    const reader = new PdfReader(createElements());
    await expect(reader.open(openedPdf('doc-too-many'))).rejects.toThrow(
      'too many pages'
    );
    expect(reader.pageCount).toBe(0);
    reader.destroy();
  });
});
