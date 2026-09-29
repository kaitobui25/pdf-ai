import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { OpenedPdf, PdfSearchHit } from '../shared/pdf.js';
import {
  boundedOutputScale,
  clampPageNumber,
  clampZoom,
  findPageSearchHits,
  fitWidthScale,
  isRenderableViewport,
  MAX_READER_PAGES,
  pageNumberFromNode,
  thumbnailScale,
  ZOOM_STEP
} from './reader-math.js';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PageView {
  number: number;
  root: HTMLElement;
  canvas: HTMLCanvasElement | null;
  text: HTMLDivElement | null;
  loading: boolean;
  renderedScale: number | null;
  renderTask: RenderTask | null;
  textLayer: TextLayer | null;
  generation: number;
}

interface ThumbnailView {
  number: number;
  root: HTMLButtonElement;
  canvas: HTMLCanvasElement | null;
  rendered: boolean;
  renderTask: RenderTask | null;
  generation: number;
}

export interface PdfReaderElements {
  viewport: HTMLElement;
  pages: HTMLElement;
  outline: HTMLElement;
  thumbnails: HTMLElement;
}

export interface PdfReaderEvents {
  onDocumentChanged?(document: OpenedPdf | null, pageCount: number): void;
  onPageChanged?(page: number, pageCount: number): void;
  onSelectionChanged?(text: string, page: number | null): void;
  onStatus?(message: string, error?: boolean): void;
}

export class PdfReader {
  private static readonly MAX_TEXT_CACHE_CHARS = 2_000_000;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pdf: PDFDocumentProxy | null = null;
  private document: OpenedPdf | null = null;
  private pageViews = new Map<number, PageView>();
  private thumbnailViews = new Map<number, ThumbnailView>();
  private textCache = new Map<number, string>();
  private textCacheChars = 0;
  private nearbyPages = new Set<number>();
  private pageObserver: IntersectionObserver;
  private thumbnailObserver: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private currentPage = 1;
  private zoom = 1;
  private fitWidth = true;
  private destroyed = false;
  private documentGeneration = 0;
  private pageTrackFrame = 0;
  private selectionTimer = 0;

  constructor(
    private readonly elements: PdfReaderElements,
    private readonly events: PdfReaderEvents = {}
  ) {
    this.pageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const root = entry.target as HTMLElement;
        const page = Number(root.dataset.page);
        if (!Number.isInteger(page)) continue;
        if (entry.isIntersecting) {
          this.nearbyPages.add(page);
          void this.renderPage(page);
        } else {
          this.nearbyPages.delete(page);
          this.releasePage(page);
        }
      }
      this.scheduleCurrentPageUpdate();
    }, {
      root: this.elements.viewport,
      rootMargin: '1400px 0px',
      threshold: 0.01
    });
    this.thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isInteger(page)) continue;
        if (entry.isIntersecting) void this.renderThumbnail(page);
        else this.releaseThumbnail(page);
      }
    }, {
      root: this.elements.thumbnails,
      rootMargin: '600px 0px',
      threshold: 0.01
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.fitWidth || !this.pdf) return;
      this.invalidateVisiblePages();
    });
    this.resizeObserver.observe(this.elements.viewport);
    this.elements.viewport.addEventListener('scroll', this.scheduleCurrentPageUpdate, { passive: true });
    document.addEventListener('selectionchange', this.scheduleSelectionUpdate);
  }

  get pageCount(): number {
    return this.pdf?.numPages ?? 0;
  }

  get pageNumber(): number {
    return this.currentPage;
  }

  get documentId(): string | null {
    return this.document?.documentId ?? null;
  }

  get isFitWidth(): boolean {
    return this.fitWidth;
  }

  async open(document: OpenedPdf): Promise<void> {
    const generation = ++this.documentGeneration;
    await this.closeDocument();
    if (this.destroyed || generation !== this.documentGeneration) return;
    this.document = document;
    this.events.onStatus?.('Loading ' + document.name + '…');
    try {
      const loadingTask = getDocument({
        data: document.bytes,
        enableXfa: false,
        useSystemFonts: true,
        maxImageSize: 16 * 1024 * 1024,
        canvasMaxAreaInBytes: 64 * 1024 * 1024
      });
      this.loadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      if (this.destroyed || generation !== this.documentGeneration) {
        if (this.loadingTask === loadingTask) this.loadingTask = null;
        await loadingTask.destroy();
        return;
      }
      this.pdf = pdf;
      if (pdf.numPages > MAX_READER_PAGES) {
        throw new Error('PDF has too many pages for the local reader limit of ' + MAX_READER_PAGES + '.');
      }
      this.currentPage = 1;
      this.zoom = 1;
      this.fitWidth = true;
      this.createPagePlaceholders(pdf.numPages);
      this.createThumbnailPlaceholders(pdf.numPages);
      void this.populateOutline(generation);
      this.events.onDocumentChanged?.(document, pdf.numPages);
      this.events.onPageChanged?.(1, pdf.numPages);
      this.events.onStatus?.(document.name + ' · ' + pdf.numPages + ' pages');
      const first = this.pageViews.get(1);
      first?.root.scrollIntoView({ block: 'start' });
      await this.renderPage(1);
    } catch (error) {
      if (generation !== this.documentGeneration || this.destroyed) return;
      await this.closeDocument();
      const message = error instanceof Error ? error.message : 'Unknown PDF error';
      this.events.onStatus?.('Could not open PDF: ' + message, true);
      throw error;
    }
  }

  async closeDocument(): Promise<void> {
    this.pageObserver.disconnect();
    this.thumbnailObserver.disconnect();
    for (const view of this.pageViews.values()) {
      view.generation++;
      view.renderTask?.cancel();
      view.textLayer?.cancel();
    }
    for (const view of this.thumbnailViews.values()) {
      view.generation++;
      view.renderTask?.cancel();
    }
    this.pageViews.clear();
    this.thumbnailViews.clear();
    this.nearbyPages.clear();
    this.textCache.clear();
    this.textCacheChars = 0;
    this.elements.pages.replaceChildren();
    this.elements.outline.replaceChildren();
    this.elements.thumbnails.replaceChildren();
    const pdf = this.pdf;
    this.pdf = null;
    const loading = this.loadingTask;
    this.loadingTask = null;
    this.document = null;
    this.currentPage = 1;
    if (pdf) await pdf.cleanup().catch(() => undefined);
    if (loading) await loading.destroy().catch(() => undefined);
    this.events.onDocumentChanged?.(null, 0);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.documentGeneration++;
    if (this.pageTrackFrame) cancelAnimationFrame(this.pageTrackFrame);
    if (this.selectionTimer) window.clearTimeout(this.selectionTimer);
    this.resizeObserver.disconnect();
    this.elements.viewport.removeEventListener('scroll', this.scheduleCurrentPageUpdate);
    document.removeEventListener('selectionchange', this.scheduleSelectionUpdate);
    void this.closeDocument();
  }

  previousPage(): void {
    this.goToPage(this.currentPage - 1);
  }

  nextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  goToPage(page: number): void {
    const count = this.pageCount;
    if (!count) return;
    const target = clampPageNumber(page, count);
    const view = this.pageViews.get(target);
    if (!view) return;
    view.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.setCurrentPage(target);
    void this.renderPage(target);
  }

  zoomIn(): void {
    this.fitWidth = false;
    this.zoom = clampZoom(this.zoom + ZOOM_STEP);
    this.invalidateVisiblePages();
  }

  zoomOut(): void {
    this.fitWidth = false;
    this.zoom = clampZoom(this.zoom - ZOOM_STEP);
    this.invalidateVisiblePages();
  }

  fitToWidth(): void {
    this.fitWidth = true;
    this.invalidateVisiblePages();
  }

  async search(query: string): Promise<PdfSearchHit[]> {
    const pdf = this.pdf;
    const generation = this.documentGeneration;
    const normalized = query.trim().toLocaleLowerCase();
    if (!pdf || !normalized) return [];
    const hits: PdfSearchHit[] = [];
    for (let page = 1; page <= pdf.numPages && hits.length < 200; page++) {
      if (this.pdf !== pdf || generation !== this.documentGeneration) return [];
      let text: string;
      try {
        text = await this.pageText(pdf, page, generation);
      } catch (error) {
        if (this.pdf !== pdf || generation !== this.documentGeneration) return [];
        throw error;
      }
      if (this.pdf !== pdf || generation !== this.documentGeneration) return [];
      hits.push(...findPageSearchHits(text, normalized, page, 200 - hits.length));
    }
    return hits;
  }

  private createPagePlaceholders(pageCount: number): void {
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= pageCount; page++) {
      const root = document.createElement('section');
      root.className = 'pdf-page';
      root.dataset.page = String(page);
      root.setAttribute('aria-label', 'Page ' + page);
      const label = document.createElement('span');
      label.className = 'pdf-page-label';
      label.textContent = String(page);
      root.append(label);
      fragment.append(root);
      const view: PageView = {
        number: page,
        root,
        canvas: null,
        text: null,
        loading: false,
        renderedScale: null,
        renderTask: null,
        textLayer: null,
        generation: 0
      };
      this.pageViews.set(page, view);
      this.pageObserver.observe(root);
    }
    this.elements.pages.append(fragment);
  }

  private createThumbnailPlaceholders(pageCount: number): void {
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= pageCount; page++) {
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'pdf-thumbnail';
      root.dataset.page = String(page);
      root.title = 'Go to page ' + page;
      const label = document.createElement('span');
      label.textContent = String(page);
      root.append(label);
      root.addEventListener('click', () => this.goToPage(page));
      fragment.append(root);
      this.thumbnailViews.set(page, {
        number: page,
        root,
        canvas: null,
        rendered: false,
        renderTask: null,
        generation: 0
      });
      this.thumbnailObserver.observe(root);
    }
    this.elements.thumbnails.append(fragment);
    this.thumbnailViews.get(1)?.root.classList.add('is-current');
  }

  private async renderPage(pageNumber: number): Promise<void> {
    const pdf = this.pdf;
    const view = this.pageViews.get(pageNumber);
    if (!pdf || !view || view.loading || this.destroyed) return;
    const generation = ++view.generation;
    view.loading = true;
    try {
      const page = await pdf.getPage(pageNumber);
      if (!this.isCurrent(view, generation)) return;
      const base = page.getViewport({ scale: 1 });
      const scale = this.fitWidth ? fitWidthScale(this.elements.viewport.clientWidth, base.width) : this.zoom;
      if (view.renderedScale !== null && Math.abs(view.renderedScale - scale) < 0.001 &&
          view.canvas !== null && view.canvas.width > 1) return;
      view.renderTask?.cancel();
      view.textLayer?.cancel();
      const viewport = page.getViewport({ scale });
      if (!isRenderableViewport(viewport.width, viewport.height)) {
        throw new Error('PDF page dimensions exceed the reader limit.');
      }
      const outputScale = boundedOutputScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
      if (!Number.isFinite(outputScale) || outputScale <= 0) {
        throw new Error('PDF page scale is invalid.');
      }
      const nextCanvas = document.createElement('canvas');
      nextCanvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      nextCanvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
      view.renderTask = page.render({ canvas: nextCanvas, viewport, transform });
      await view.renderTask.promise;
      if (!this.isCurrent(view, generation)) return;
      view.renderTask = null;
      const surface = this.ensurePageSurface(view);
      view.root.style.width = Math.ceil(viewport.width) + 'px';
      view.root.style.height = Math.ceil(viewport.height) + 'px';
      surface.canvas.width = nextCanvas.width;
      surface.canvas.height = nextCanvas.height;
      surface.canvas.style.width = Math.ceil(viewport.width) + 'px';
      surface.canvas.style.height = Math.ceil(viewport.height) + 'px';
      surface.canvas.getContext('2d')?.drawImage(nextCanvas, 0, 0);
      surface.text.replaceChildren();
      surface.text.style.width = Math.ceil(viewport.width) + 'px';
      surface.text.style.height = Math.ceil(viewport.height) + 'px';
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: surface.text,
        viewport
      });
      view.textLayer = textLayer;
      await textLayer.render();
      if (!this.isCurrent(view, generation)) return;
      view.renderedScale = scale;
    } catch (error) {
      if ((error as { name?: string }).name !== 'RenderingCancelledException') {
        const message = error instanceof Error ? error.message : 'Page render failed';
        this.events.onStatus?.('Page ' + pageNumber + ': ' + message, true);
      }
    } finally {
      if (view.generation === generation) view.loading = false;
    }
  }

  private ensurePageSurface(view: PageView): { canvas: HTMLCanvasElement; text: HTMLDivElement } {
    let canvas = view.canvas;
    let text = view.text;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      view.root.prepend(canvas);
      view.canvas = canvas;
    }
    if (!text) {
      text = document.createElement('div');
      text.className = 'textLayer pdf-text-layer';
      const label = view.root.querySelector('.pdf-page-label');
      if (label) view.root.insertBefore(text, label);
      else view.root.append(text);
      view.text = text;
    }
    return { canvas, text };
  }

  private releasePage(pageNumber: number): void {
    const view = this.pageViews.get(pageNumber);
    if (!view) return;
    view.generation++;
    view.renderTask?.cancel();
    view.renderTask = null;
    view.textLayer?.cancel();
    view.textLayer = null;
    view.loading = false;
    view.text?.remove();
    view.canvas?.remove();
    view.text = null;
    view.canvas = null;
    view.renderedScale = null;
  }

  private async renderThumbnail(pageNumber: number): Promise<void> {
    const pdf = this.pdf;
    const view = this.thumbnailViews.get(pageNumber);
    if (!pdf || !view || view.rendered) return;
    const generation = ++view.generation;
    view.rendered = true;
    try {
      const page = await pdf.getPage(pageNumber);
      if (view.generation !== generation || this.pdf !== pdf) return;
      const base = page.getViewport({ scale: 1 });
      const scale = thumbnailScale(base.width, base.height);
      const viewport = page.getViewport({ scale });
      if (!isRenderableViewport(viewport.width, viewport.height)) throw new Error('Thumbnail dimensions exceed limits.');
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      view.root.prepend(canvas);
      view.canvas = canvas;
      view.renderTask = page.render({ canvas, viewport });
      await view.renderTask.promise;
      if (view.generation !== generation || this.pdf !== pdf) return;
      view.renderTask = null;
    } catch {
      if (view.generation === generation) view.root.classList.add('is-error');
    }
  }

  private releaseThumbnail(pageNumber: number): void {
    const view = this.thumbnailViews.get(pageNumber);
    if (!view) return;
    view.generation++;
    view.renderTask?.cancel();
    view.renderTask = null;
    view.canvas?.remove();
    view.canvas = null;
    view.rendered = false;
  }

  private async populateOutline(generation: number): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) return;
    try {
      const outline = await pdf.getOutline();
      if (!outline?.length || generation !== this.documentGeneration) {
        const empty = document.createElement('p');
        empty.className = 'sidebar-empty';
        empty.textContent = 'No outline';
        this.elements.outline.replaceChildren(empty);
        return;
      }
      const root = document.createElement('div');
      root.className = 'outline-tree';
      const addItems = async (items: typeof outline, parent: HTMLElement): Promise<void> => {
        for (const item of items) {
          if (generation !== this.documentGeneration) return;
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = item.title || 'Untitled';
          const page = await this.outlinePage(item.dest);
          if (page !== null) button.addEventListener('click', () => this.goToPage(page));
          else button.disabled = true;
          parent.append(button);
          if (item.items?.length) {
            const children = document.createElement('div');
            children.className = 'outline-children';
            parent.append(children);
            await addItems(item.items, children);
          }
        }
      };
      await addItems(outline, root);
      if (generation === this.documentGeneration) this.elements.outline.replaceChildren(root);
    } catch {
      const empty = document.createElement('p');
      empty.className = 'sidebar-empty';
      empty.textContent = 'Outline unavailable';
      this.elements.outline.replaceChildren(empty);
    }
  }

  private async outlinePage(destination: string | unknown[] | null): Promise<number | null> {
    const pdf = this.pdf;
    if (!pdf || !destination) return null;
    try {
      const explicit = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
      const target = explicit?.[0];
      if (typeof target === 'number') return target + 1;
      if (target && typeof target === 'object') return (await pdf.getPageIndex(target as never)) + 1;
    } catch {
      return null;
    }
    return null;
  }

  private async pageText(pdf: PDFDocumentProxy, pageNumber: number, generation: number): Promise<string> {
    const cached = this.textCache.get(pageNumber);
    if (cached !== undefined) {
      this.textCache.delete(pageNumber);
      this.textCache.set(pageNumber, cached);
      return cached;
    }
    if (this.pdf !== pdf || generation !== this.documentGeneration) return '';
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    if (this.pdf !== pdf || generation !== this.documentGeneration) return '';
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    text = text.trim();
    const existing = this.textCache.get(pageNumber);
    if (existing !== undefined) this.textCacheChars -= existing.length;
    this.textCache.set(pageNumber, text);
    this.textCacheChars += text.length;
    while (this.textCacheChars > PdfReader.MAX_TEXT_CACHE_CHARS && this.textCache.size > 1) {
      const oldest = this.textCache.entries().next().value as [number, string] | undefined;
      if (!oldest) break;
      this.textCache.delete(oldest[0]);
      this.textCacheChars -= oldest[1].length;
    }
    return text;
  }

  private invalidateVisiblePages(): void {
    const pages = new Set(this.nearbyPages);
    if (this.pdf) pages.add(this.currentPage);
    for (const page of pages) {
      const view = this.pageViews.get(page);
      if (!view) continue;
      view.generation++;
      view.renderTask?.cancel();
      view.renderTask = null;
      view.textLayer?.cancel();
      view.textLayer = null;
      view.loading = false;
      view.renderedScale = null;
      void this.renderPage(view.number);
    }
  }

  private isCurrent(view: PageView, generation: number): boolean {
    return !this.destroyed && this.pdf !== null && view.generation === generation;
  }

  private readonly scheduleCurrentPageUpdate = (): void => {
    if (this.pageTrackFrame) return;
    this.pageTrackFrame = requestAnimationFrame(() => {
      this.pageTrackFrame = 0;
      const viewport = this.elements.viewport.getBoundingClientRect();
      const center = viewport.top + viewport.height / 2;
      let bestPage = this.currentPage;
      let bestDistance = Infinity;
      for (const page of this.nearbyPages) {
        const view = this.pageViews.get(page);
        if (!view) continue;
        const rect = view.root.getBoundingClientRect();
        const distance = Math.abs((rect.top + rect.bottom) / 2 - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = view.number;
        }
      }
      this.setCurrentPage(bestPage);
    });
  };

  private setCurrentPage(page: number): void {
    if (!this.pdf || page === this.currentPage) return;
    this.thumbnailViews.get(this.currentPage)?.root.classList.remove('is-current');
    this.currentPage = page;
    this.events.onPageChanged?.(page, this.pdf.numPages);
    this.thumbnailViews.get(page)?.root.classList.add('is-current');
  }

  private readonly scheduleSelectionUpdate = (): void => {
    if (this.selectionTimer) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = 0;
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection || selection.rangeCount === 0 || !text) {
        this.events.onSelectionChanged?.('', null);
        return;
      }
      const range = selection.getRangeAt(0);
      const page = pageNumberFromNode(range.commonAncestorContainer);
      this.events.onSelectionChanged?.(text, page);
    }, 80);
  };
}
