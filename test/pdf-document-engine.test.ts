import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PdfDocumentEngine,
  PdfEngineError
} from '../src/main/pdf-document-engine.js';

const temporary = new Set<string>();
const engines = new Set<PdfDocumentEngine>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-engine-'));
  temporary.add(directory);
  return directory;
}

async function textPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = pdf.addPage([400, 300]);
    page.drawText(line, { x: 36, y: 240, size: 18, font });
  }
  return pdf.save();
}

async function colorPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  page.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 100, y: 0, width: 100, height: 100, color: rgb(0, 0, 1) });
  return pdf.save();
}

function engine(): PdfDocumentEngine {
  const instance = new PdfDocumentEngine();
  engines.add(instance);
  return instance;
}

async function pixel(bytes: Uint8Array, xFraction: number, yFraction: number) {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(image.width * xFraction)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(image.height * yFraction)));
  return [...context.getImageData(x, y, 1, 1).data];
}

afterEach(async () => {
  await Promise.all([...engines].map(instance => instance.destroy()));
  engines.clear();
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PdfDocumentEngine', () => {
  it('returns exact page text, stable page references, and multi-page search hits', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'search.pdf');
    await writeFile(filePath, await textPdf([
      'Alpha needle page one',
      'Middle page without target',
      'Alpha needle page three'
    ]));
    const store = engine();
    const opened = await store.openFile(filePath);

    const read = await store.readPages(opened.documentId, 1, 3);
    expect(read.pages.map(page => page.text)).toEqual([
      'Alpha needle page one',
      'Middle page without target',
      'Alpha needle page three'
    ]);
    expect(read.revision).toBe(opened.documentId);
    expect(read.pages[1]).toMatchObject({
      documentId: opened.documentId,
      revision: opened.documentId,
      page: 2,
      pageCount: 3,
      reference: 'pdf://' + opened.documentId + '/page/2'
    });

    const hits = await store.search(opened.documentId, 'needle');
    expect(hits.map(hit => hit.page)).toEqual([1, 3]);
    expect(hits.every(hit => hit.revision === opened.documentId)).toBe(true);
  });

  it('keeps multiple documents isolated and delayed state updates cannot steal current document', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'first.pdf');
    const secondPath = path.join(directory, 'second.pdf');
    await writeFile(firstPath, await textPdf(['First one', 'First two']));
    await writeFile(secondPath, await textPdf(['Second one', 'Second two', 'Second three']));
    const store = engine();
    const first = await store.openFile(firstPath);
    const second = await store.openFile(secondPath);

    expect((await store.listDocuments()).map(item => item.documentId)).toEqual([
      first.documentId,
      second.documentId
    ]);
    expect((await store.getCurrentPage()).documentId).toBe(second.documentId);

    expect(store.setCurrentPage(first.documentId, first.viewEpoch, 1, 2)).toBe(false);
    expect((await store.getCurrentPage(first.documentId)).page).toBe(1);
    expect((await store.getCurrentPage()).documentId).toBe(second.documentId);
  });

  it('serves bounded upload chunks by document id and rejects changed backing files', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'upload.pdf');
    const bytes = await textPdf(['Upload bytes']);
    await writeFile(filePath, bytes);
    const store = engine();
    const opened = await store.openFile(filePath);

    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const chunk = await store.readDocumentChunk(opened.documentId, offset, 97);
      expect(chunk.documentId).toBe(opened.documentId);
      expect(chunk.name).toBe('upload.pdf');
      expect(chunk.mimeType).toBe('application/pdf');
      expect(chunk.offset).toBe(offset);
      chunks.push(Buffer.from(chunk.base64, 'base64'));
      offset = chunk.nextOffset;
      if (chunk.done) break;
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));

    await writeFile(filePath, await textPdf(['Changed upload bytes']));
    await expect(store.readDocumentChunk(opened.documentId, 0, 97)).rejects.toMatchObject({
      code: 'document_changed'
    });
  });

  it('rejects stale renderer epochs when the same document is reopened after another document', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'epoch-a.pdf');
    const secondPath = path.join(directory, 'epoch-b.pdf');
    await writeFile(firstPath, await textPdf(['A one', 'A two']));
    await writeFile(secondPath, await textPdf(['B one']));
    const store = engine();
    const firstView = await store.openFile(firstPath);
    await store.openFile(secondPath);
    const secondViewOfA = await store.openFile(firstPath);

    expect(secondViewOfA.documentId).toBe(firstView.documentId);
    expect(secondViewOfA.viewEpoch).not.toBe(firstView.viewEpoch);
    expect(store.setCurrentPage(firstView.documentId, firstView.viewEpoch, 99, 2)).toBe(false);
    expect(store.setCurrentPage(
      secondViewOfA.documentId,
      secondViewOfA.viewEpoch,
      1,
      2
    )).toBe(true);
    expect((await store.getCurrentPage()).page).toBe(2);
  });

  it('stores page-qualified selection text and normalized bounds', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'selection.pdf');
    await writeFile(filePath, await textPdf(['Selection page']));
    const store = engine();
    const opened = await store.openFile(filePath);
    store.setSelection(opened.documentId, opened.viewEpoch, 1, {
      text: 'Selection',
      startPage: 1,
      endPage: 1,
      bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
    });

    expect(await store.getSelection(opened.documentId)).toEqual({
      documentId: opened.documentId,
      revision: opened.documentId,
      text: 'Selection',
      startPage: 1,
      endPage: 1,
      bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      startReference: 'pdf://' + opened.documentId + '/page/1',
      endReference: 'pdf://' + opened.documentId + '/page/1'
    });

    expect(() => store.setSelection(opened.documentId, opened.viewEpoch, 2, {
      text: 'bad',
      startPage: 1,
      endPage: 1,
      bounds: { x: 0.9, y: 0.2, width: 0.2, height: 0.1 }
    })).toThrow(PdfEngineError);
  });

  it('renders a full page and normalized region with correct image content', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'colors.pdf');
    await writeFile(filePath, await colorPdf());
    const store = engine();
    const opened = await store.openFile(filePath);

    const full = await store.renderPage(opened.documentId, 1, 1);
    expect(full.mimeType).toBe('image/png');
    expect(full.width).toBeGreaterThan(100);
    expect(full.height).toBeGreaterThan(50);
    const left = await pixel(full.bytes, 0.25, 0.5);
    const right = await pixel(full.bytes, 0.75, 0.5);
    expect(left[0]).toBeGreaterThan(200);
    expect(left[2]).toBeLessThan(50);
    expect(right[2]).toBeGreaterThan(200);
    expect(right[0]).toBeLessThan(50);

    const region = await store.renderRegion(
      opened.documentId,
      1,
      { x: 0, y: 0, width: 0.5, height: 1 },
      1
    );
    expect(region.width).toBeLessThan(full.width);
    const regionCenter = await pixel(region.bytes, 0.5, 0.5);
    expect(regionCenter[0]).toBeGreaterThan(200);
    expect(regionCenter[2]).toBeLessThan(50);
  });

  it('handles an image-only/scanned-style PDF with empty text without failing', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'scanned.pdf');
    await writeFile(filePath, await colorPdf());
    const store = engine();
    const opened = await store.openFile(filePath);

    const read = await store.readPages(opened.documentId, 1);
    expect(read.pages).toHaveLength(1);
    expect(read.pages[0]).toMatchObject({
      documentId: opened.documentId,
      page: 1,
      text: ''
    });
    const rendered = await store.renderPage(opened.documentId, 1, 0.5);
    expect(rendered.bytes.byteLength).toBeGreaterThan(0);
  });

  it('deduplicates identical content while keeping the latest source identity explicit', async () => {
    const directory = await tempDir();
    const bytes = await textPdf(['Same content']);
    const firstPath = path.join(directory, 'copy-a.pdf');
    const secondPath = path.join(directory, 'copy-b.pdf');
    await writeFile(firstPath, bytes);
    await writeFile(secondPath, bytes);
    const store = engine();
    const first = await store.openFile(firstPath);
    const second = await store.openFile(secondPath);
    expect(second.documentId).toBe(first.documentId);
    expect(await store.listDocuments()).toHaveLength(1);

    await writeFile(firstPath, await textPdf(['Changed inactive source']));
    expect((await store.listDocuments())[0]?.changed).toBe(false);

    await writeFile(secondPath, await textPdf(['Changed active source']));
    expect((await store.listDocuments())[0]?.changed).toBe(true);
    await expect(store.readPages(first.documentId, 1)).rejects.toMatchObject({
      code: 'document_changed'
    });
  });

  it('detects replacement, rejects stale reads, then registers the reopened revision', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'replace.pdf');
    await writeFile(filePath, await textPdf(['Old revision']));
    const store = engine();
    const oldDocument = await store.openFile(filePath);
    expect((await store.readPages(oldDocument.documentId, 1)).pages[0]?.text).toBe('Old revision');

    await writeFile(filePath, await textPdf(['New revision']));
    await expect(store.readPages(oldDocument.documentId, 1)).rejects.toMatchObject({
      code: 'document_changed'
    });

    const newDocument = await store.openFile(filePath);
    expect(newDocument.documentId).not.toBe(oldDocument.documentId);
    expect((await store.readPages(newDocument.documentId, 1)).pages[0]?.text).toBe('New revision');
    const documents = await store.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.documentId).toBe(newDocument.documentId);
  });
});
