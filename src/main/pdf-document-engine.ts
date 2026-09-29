import path from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import {
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  MAX_MCP_TEXT_CHARS,
  MAX_PDF_PAGES,
  MAX_RENDER_PIXELS
} from '../shared/constants.js';
import type {
  OpenedPdf,
  PdfCurrentPage,
  PdfDocumentSummary,
  PdfEngineSearchHit,
  PdfNormalizedRegion,
  PdfPageText,
  PdfReadPagesResult,
  PdfRenderedImage,
  PdfSelectionState,
  PdfSelectionUpdate
} from '../shared/pdf.js';
import {
  loadPdfSnapshotRecord,
  pdfFileIdentityMatches,
  type PdfFileIdentity
} from './pdf-file.js';

const MAX_TEXT_CACHE_CHARS = 5_000_000;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_READ_PAGES = 50;
const MAX_SELECTION_CHARS = 50_000;
const MIN_RENDER_SCALE = 0.1;
const MAX_RENDER_SCALE = 4;
const MAX_RENDER_DIMENSION = 4096;

export type PdfEngineErrorCode =
  | 'document_not_found'
  | 'document_changed'
  | 'page_out_of_range'
  | 'invalid_argument'
  | 'limit_exceeded';

export class PdfEngineError extends Error {
  constructor(
    readonly code: PdfEngineErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PdfEngineError';
  }
}

interface DocumentRecord {
  documentId: string;
  name: string;
  sources: Map<string, PdfDocumentSource>;
  activeSourcePath: string;
  size: number;
  modifiedAt: string;
  pageCount: number;
  currentPage: number;
  selection: PdfSelectionState | null;
  changed: boolean;
  openedOrder: number;
  loadingTask: PDFDocumentLoadingTask;
  pdf: PDFDocumentProxy;
  textCache: Map<number, string>;
  textCacheChars: number;
  textInflight: Map<number, Promise<string>>;
}

interface PdfDocumentSource {
  filePath: string;
  identity: PdfFileIdentity;
  name: string;
  modifiedAt: string;
}

interface RenderedCanvas {
  canvas: Canvas;
  width: number;
  height: number;
  scale: number;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pageReference(documentId: string, page: number): string {
  return 'pdf://' + documentId + '/page/' + page;
}

function finiteInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

function normalizedRegion(region: PdfNormalizedRegion): PdfNormalizedRegion {
  const values = [region.x, region.y, region.width, region.height];
  if (values.some(value => !Number.isFinite(value))) {
    throw new PdfEngineError('invalid_argument', 'Region coordinates must be finite numbers.');
  }
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
      region.x > 1 || region.y > 1 ||
      region.x + region.width > 1.000001 ||
      region.y + region.height > 1.000001) {
    throw new PdfEngineError('invalid_argument', 'Region must fit inside normalized page coordinates 0..1.');
  }
  return {
    x: Math.max(0, Math.min(1, region.x)),
    y: Math.max(0, Math.min(1, region.y)),
    width: Math.min(1 - region.x, region.width),
    height: Math.min(1 - region.y, region.height)
  };
}

export class PdfDocumentEngine {
  private readonly records = new Map<string, DocumentRecord>();
  private currentDocumentId: string | null = null;
  private openedCounter = 0;
  private viewEpochCounter = 0;
  private activeView: {
    documentId: string;
    viewEpoch: number;
    lastPageSeq: number;
    lastSelectionSeq: number;
  } | null = null;

  async openFile(filePath: string): Promise<OpenedPdf> {
    const snapshot = await loadPdfSnapshotRecord(filePath);
    const { document } = snapshot;

    for (const record of [...this.records.values()]) {
      if (record.documentId !== document.documentId) {
        const sourcePath = [...record.sources.keys()].find(candidate => samePath(candidate, snapshot.filePath));
        if (sourcePath) await this.detachSource(record, sourcePath);
      }
    }

    const existing = this.records.get(document.documentId);
    if (existing) {
      existing.sources.set(snapshot.filePath, {
        filePath: snapshot.filePath,
        identity: snapshot.identity,
        name: document.name,
        modifiedAt: document.modifiedAt
      });
      existing.name = document.name;
      existing.activeSourcePath = snapshot.filePath;
      existing.size = document.size;
      existing.modifiedAt = document.modifiedAt;
      existing.currentPage = 1;
      existing.selection = null;
      existing.changed = false;
      existing.openedOrder = ++this.openedCounter;
      return this.activateView(existing, document);
    }

    const loadingTask = getDocument({
      data: document.bytes.slice(),
      enableXfa: false,
      useSystemFonts: true,
      maxImageSize: 16 * 1024 * 1024,
      canvasMaxAreaInBytes: 64 * 1024 * 1024
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new PdfEngineError(
          'limit_exceeded',
          'PDF has too many pages for the local engine limit of ' + MAX_PDF_PAGES + '.'
        );
      }
      const record: DocumentRecord = {
        documentId: document.documentId,
        name: document.name,
        sources: new Map([[snapshot.filePath, {
          filePath: snapshot.filePath,
          identity: snapshot.identity,
          name: document.name,
          modifiedAt: document.modifiedAt
        }]]),
        activeSourcePath: snapshot.filePath,
        size: document.size,
        modifiedAt: document.modifiedAt,
        pageCount: pdf.numPages,
        currentPage: 1,
        selection: null,
        changed: false,
        openedOrder: ++this.openedCounter,
        loadingTask,
        pdf,
        textCache: new Map(),
        textCacheChars: 0,
        textInflight: new Map()
      };
      this.records.set(record.documentId, record);
      return this.activateView(record, document);
    } catch (error) {
      await loadingTask.destroy().catch(() => undefined);
      throw error;
    }
  }

  async listDocuments(): Promise<PdfDocumentSummary[]> {
    const records = [...this.records.values()].sort((a, b) => a.openedOrder - b.openedOrder);
    return Promise.all(records.map(async record => {
      const source = this.activeSource(record);
      record.changed = !(await pdfFileIdentityMatches(source.filePath, source.identity));
      return {
        documentId: record.documentId,
        revision: record.documentId,
        name: record.name,
        size: record.size,
        modifiedAt: record.modifiedAt,
        pageCount: record.pageCount,
        currentPage: record.currentPage,
        current: record.documentId === this.currentDocumentId,
        changed: record.changed
      };
    }));
  }

  async getCurrentPage(documentId?: string): Promise<PdfCurrentPage> {
    const record = this.recordFor(documentId);
    await this.assertUnchanged(record);
    return {
      documentId: record.documentId,
      revision: record.documentId,
      name: record.name,
      page: record.currentPage,
      pageCount: record.pageCount,
      reference: pageReference(record.documentId, record.currentPage)
    };
  }

  setCurrentPage(documentId: string, viewEpoch: number, seq: number, page: number): boolean {
    const record = this.recordFor(documentId);
    this.assertPage(record, page);
    const view = this.activeView;
    if (!view || view.documentId !== documentId || view.viewEpoch !== viewEpoch) return false;
    if (!finiteInteger(seq) || seq <= view.lastPageSeq) return false;
    view.lastPageSeq = seq;
    record.currentPage = page;
    return true;
  }

  async getSelection(documentId?: string): Promise<PdfSelectionState | null> {
    const record = this.recordFor(documentId);
    await this.assertUnchanged(record);
    return record.selection ? { ...record.selection, bounds: record.selection.bounds ? { ...record.selection.bounds } : undefined } : null;
  }

  setSelection(
    documentId: string,
    viewEpoch: number,
    seq: number,
    selection: PdfSelectionUpdate | null
  ): boolean {
    const record = this.recordFor(documentId);
    const view = this.activeView;
    if (!view || view.documentId !== documentId || view.viewEpoch !== viewEpoch) return false;
    if (!finiteInteger(seq) || seq <= view.lastSelectionSeq) return false;
    view.lastSelectionSeq = seq;
    if (!selection || !selection.text.trim()) {
      record.selection = null;
      return true;
    }
    if (selection.text.length > MAX_SELECTION_CHARS) {
      throw new PdfEngineError('limit_exceeded', 'Selection text exceeds the local selection limit.');
    }
    this.assertPage(record, selection.startPage);
    this.assertPage(record, selection.endPage);
    if (selection.endPage < selection.startPage) {
      throw new PdfEngineError('invalid_argument', 'Selection end page must not precede the start page.');
    }
    const bounds = selection.bounds ? normalizedRegion(selection.bounds) : undefined;
    if (bounds && selection.startPage !== selection.endPage) {
      throw new PdfEngineError('invalid_argument', 'Selection bounds are only valid for a single-page selection.');
    }
    record.selection = {
      documentId: record.documentId,
      revision: record.documentId,
      text: selection.text,
      startPage: selection.startPage,
      endPage: selection.endPage,
      bounds,
      startReference: pageReference(record.documentId, selection.startPage),
      endReference: pageReference(record.documentId, selection.endPage)
    };
    return true;
  }

  async search(documentId: string, query: string, maxResults = 50): Promise<PdfEngineSearchHit[]> {
    const record = this.recordFor(documentId);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new PdfEngineError('invalid_argument', 'Search query must not be empty.');
    if (needle.length > MAX_SEARCH_QUERY_CHARS) {
      throw new PdfEngineError('limit_exceeded', 'Search query is too long.');
    }
    if (!finiteInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      throw new PdfEngineError('invalid_argument', 'maxResults must be an integer from 1 to ' + MAX_SEARCH_RESULTS + '.');
    }
    await this.assertUnchanged(record);
    const hits: PdfEngineSearchHit[] = [];
    for (let page = 1; page <= record.pageCount && hits.length < maxResults; page++) {
      const text = await this.pageText(record, page);
      const lower = text.toLocaleLowerCase();
      let from = 0;
      while (hits.length < maxResults) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        const radius = 64;
        const start = Math.max(0, index - radius);
        const end = Math.min(text.length, index + needle.length + radius);
        hits.push({
          documentId: record.documentId,
          revision: record.documentId,
          page,
          index,
          snippet:
            (start > 0 ? '…' : '') +
            text.slice(start, end).replace(/\s+/g, ' ').trim() +
            (end < text.length ? '…' : ''),
          reference: pageReference(record.documentId, page)
        });
        from = index + Math.max(1, needle.length);
      }
    }
    await this.assertUnchanged(record);
    return hits;
  }

  async readPages(documentId: string, startPage: number, endPage = startPage): Promise<PdfReadPagesResult> {
    const record = this.recordFor(documentId);
    this.assertPage(record, startPage);
    this.assertPage(record, endPage);
    if (endPage < startPage) {
      throw new PdfEngineError('invalid_argument', 'endPage must not precede startPage.');
    }
    if (endPage - startPage + 1 > MAX_READ_PAGES) {
      throw new PdfEngineError('limit_exceeded', 'A single read may include at most ' + MAX_READ_PAGES + ' pages.');
    }
    await this.assertUnchanged(record);
    const pages: PdfPageText[] = [];
    let totalCharacters = 0;
    for (let page = startPage; page <= endPage; page++) {
      const text = await this.pageText(record, page);
      totalCharacters += text.length;
      if (totalCharacters > MAX_MCP_TEXT_CHARS) {
        throw new PdfEngineError('limit_exceeded', 'Requested page text exceeds the local result limit.');
      }
      pages.push({
        documentId: record.documentId,
        revision: record.documentId,
        page,
        pageCount: record.pageCount,
        reference: pageReference(record.documentId, page),
        text
      });
    }
    await this.assertUnchanged(record);
    return {
      documentId: record.documentId,
      revision: record.documentId,
      name: record.name,
      pages,
      totalCharacters
    };
  }

  async renderPage(documentId: string, page: number, scale = 1): Promise<PdfRenderedImage> {
    const record = this.recordFor(documentId);
    this.assertPage(record, page);
    await this.assertUnchanged(record);
    const rendered = await this.renderCanvas(record, page, scale);
    await this.assertUnchanged(record);
    return {
      documentId: record.documentId,
      revision: record.documentId,
      page,
      pageCount: record.pageCount,
      reference: pageReference(record.documentId, page),
      mimeType: 'image/png',
      width: rendered.width,
      height: rendered.height,
      scale: rendered.scale,
      bytes: new Uint8Array(rendered.canvas.toBuffer('image/png'))
    };
  }

  async renderRegion(
    documentId: string,
    page: number,
    regionInput: PdfNormalizedRegion,
    scale = 1
  ): Promise<PdfRenderedImage> {
    const record = this.recordFor(documentId);
    this.assertPage(record, page);
    const region = normalizedRegion(regionInput);
    await this.assertUnchanged(record);
    const full = await this.renderCanvas(record, page, scale);
    const sourceX = Math.min(full.width - 1, Math.max(0, Math.floor(full.width * region.x)));
    const sourceY = Math.min(full.height - 1, Math.max(0, Math.floor(full.height * region.y)));
    const sourceWidth = Math.max(
      1,
      Math.min(full.width - sourceX, Math.ceil(full.width * region.width))
    );
    const sourceHeight = Math.max(
      1,
      Math.min(full.height - sourceY, Math.ceil(full.height * region.height))
    );
    const canvas = createCanvas(sourceWidth, sourceHeight);
    canvas.getContext('2d').drawImage(
      full.canvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    await this.assertUnchanged(record);
    return {
      documentId: record.documentId,
      revision: record.documentId,
      page,
      pageCount: record.pageCount,
      reference: pageReference(record.documentId, page),
      mimeType: 'image/png',
      width: sourceWidth,
      height: sourceHeight,
      scale: full.scale,
      region,
      bytes: new Uint8Array(canvas.toBuffer('image/png'))
    };
  }

  async destroy(): Promise<void> {
    const records = [...this.records.values()];
    this.records.clear();
    this.currentDocumentId = null;
    this.activeView = null;
    await Promise.all(records.map(record => this.destroyRecord(record)));
  }

  private recordFor(documentId?: string): DocumentRecord {
    const resolved = documentId ?? this.currentDocumentId;
    if (!resolved) throw new PdfEngineError('document_not_found', 'No PDF document is currently open.');
    const record = this.records.get(resolved);
    if (!record) throw new PdfEngineError('document_not_found', 'PDF document not found: ' + resolved);
    return record;
  }

  private assertPage(record: DocumentRecord, page: number): void {
    if (!finiteInteger(page) || page < 1 || page > record.pageCount) {
      throw new PdfEngineError(
        'page_out_of_range',
        'Page must be an integer from 1 to ' + record.pageCount + '.'
      );
    }
  }

  private async assertUnchanged(record: DocumentRecord): Promise<void> {
    this.assertRecordLive(record);
    const source = this.activeSource(record);
    if (record.changed || !(await pdfFileIdentityMatches(source.filePath, source.identity))) {
      record.changed = true;
      throw new PdfEngineError(
        'document_changed',
        'The PDF changed on disk after it was opened. Reopen it before reading or rendering.'
      );
    }
  }

  private async pageText(record: DocumentRecord, page: number): Promise<string> {
    const cached = record.textCache.get(page);
    if (cached !== undefined) {
      record.textCache.delete(page);
      record.textCache.set(page, cached);
      return cached;
    }
    const inflight = record.textInflight.get(page);
    if (inflight) return inflight;
    const extraction = (async () => {
      const pdfPage = await record.pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      this.assertRecordLive(record);
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        text += item.hasEOL ? '\n' : ' ';
      }
      return text.trim();
    })();
    record.textInflight.set(page, extraction);
    try {
      const text = await extraction;
      const previous = record.textCache.get(page);
      if (previous !== undefined) record.textCacheChars -= previous.length;
      record.textCache.set(page, text);
      record.textCacheChars += text.length;
      while (record.textCacheChars > MAX_TEXT_CACHE_CHARS && record.textCache.size > 1) {
        const oldest = record.textCache.entries().next().value as [number, string] | undefined;
        if (!oldest) break;
        record.textCache.delete(oldest[0]);
        record.textCacheChars -= oldest[1].length;
      }
      return text;
    } finally {
      if (record.textInflight.get(page) === extraction) record.textInflight.delete(page);
    }
  }

  private async renderCanvas(record: DocumentRecord, page: number, requestedScale: number): Promise<RenderedCanvas> {
    if (!Number.isFinite(requestedScale) || requestedScale < MIN_RENDER_SCALE || requestedScale > MAX_RENDER_SCALE) {
      throw new PdfEngineError(
        'invalid_argument',
        'Render scale must be between ' + MIN_RENDER_SCALE + ' and ' + MAX_RENDER_SCALE + '.'
      );
    }
    const pdfPage = await record.pdf.getPage(page);
    const base = pdfPage.getViewport({ scale: 1 });
    if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
      throw new PdfEngineError('invalid_argument', 'PDF page dimensions are invalid.');
    }
    const pixelScale = Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height));
    const safeScale = Math.min(
      requestedScale,
      MAX_RENDER_DIMENSION / base.width,
      MAX_RENDER_DIMENSION / base.height,
      pixelScale
    );
    if (!Number.isFinite(safeScale) || safeScale <= 0) {
      throw new PdfEngineError('limit_exceeded', 'PDF page cannot be rendered within local limits.');
    }
    const viewport = pdfPage.getViewport({ scale: safeScale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION ||
        width * height > MAX_RENDER_PIXELS) {
      throw new PdfEngineError('limit_exceeded', 'Rendered page exceeds local image limits.');
    }
    const canvas = createCanvas(width, height);
    await pdfPage.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext('2d') as never,
      viewport
    }).promise;
    return { canvas, width, height, scale: safeScale };
  }

  private async removeRecord(record: DocumentRecord): Promise<void> {
    this.records.delete(record.documentId);
    if (this.currentDocumentId === record.documentId) {
      this.currentDocumentId = null;
      this.activeView = null;
    }
    await this.destroyRecord(record);
  }

  private async detachSource(record: DocumentRecord, sourcePath: string): Promise<void> {
    record.sources.delete(sourcePath);
    if (record.sources.size === 0) {
      await this.removeRecord(record);
      return;
    }
    if (samePath(record.activeSourcePath, sourcePath)) {
      const next = [...record.sources.values()].at(-1);
      if (!next) {
        await this.removeRecord(record);
        return;
      }
      record.activeSourcePath = next.filePath;
      record.name = next.name;
      record.modifiedAt = next.modifiedAt;
      record.changed = false;
    }
  }

  private activeSource(record: DocumentRecord): PdfDocumentSource {
    const source = record.sources.get(record.activeSourcePath);
    if (!source) throw new PdfEngineError('document_not_found', 'PDF source is no longer available.');
    return source;
  }

  private assertRecordLive(record: DocumentRecord): void {
    if (this.records.get(record.documentId) !== record) {
      throw new PdfEngineError('document_not_found', 'PDF document was replaced or closed.');
    }
  }

  private activateView(
    record: DocumentRecord,
    document: Omit<OpenedPdf, 'viewEpoch'>
  ): OpenedPdf {
    const viewEpoch = ++this.viewEpochCounter;
    this.currentDocumentId = record.documentId;
    this.activeView = {
      documentId: record.documentId,
      viewEpoch,
      lastPageSeq: 0,
      lastSelectionSeq: 0
    };
    return { ...document, viewEpoch };
  }

  private async destroyRecord(record: DocumentRecord): Promise<void> {
    record.textCache.clear();
    record.textInflight.clear();
    await record.pdf.cleanup().catch(() => undefined);
    await record.loadingTask.destroy().catch(() => undefined);
  }
}
