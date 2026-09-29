import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PDF_BYTES } from '../src/shared/constants.js';
import { loadPdfSnapshot } from '../src/main/pdf-file.js';

const temporary = new Set<string>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-test-'));
  temporary.add(directory);
  return directory;
}

async function samplePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText('Alpha needle on page one', { x: 72, y: 700, size: 18, font });
  const second = pdf.addPage([612, 792]);
  second.drawText('Beta needle on page two', { x: 72, y: 700, size: 18, font });
  return pdf.save();
}

afterEach(async () => {
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PDF file snapshots', () => {
  it('opens a real PDF and gives identical content a stable document id', async () => {
    const directory = await tempDir();
    const bytes = await samplePdf();
    const firstPath = path.join(directory, 'one.pdf');
    const secondPath = path.join(directory, 'copy.pdf');
    await writeFile(firstPath, bytes);
    await writeFile(secondPath, bytes);

    const first = await loadPdfSnapshot(firstPath);
    const second = await loadPdfSnapshot(secondPath);

    expect(first.documentId).toMatch(/^pdf-[a-f0-9]{32}$/);
    expect(second.documentId).toBe(first.documentId);
    expect(first.name).toBe('one.pdf');
    expect(first.size).toBe(bytes.length);
  });

  it('parses text and renders a page from an opened PDF', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'render.pdf');
    await writeFile(filePath, await samplePdf());
    const snapshot = await loadPdfSnapshot(filePath);
    const loading = getDocument({ data: snapshot.bytes.slice(), useSystemFonts: true });
    const pdf = await loading.promise;
    try {
      expect(pdf.numPages).toBe(2);
      const first = await pdf.getPage(1);
      const text = await first.getTextContent();
      expect(text.items.some(item => 'str' in item && item.str.includes('Alpha needle'))).toBe(true);

      const viewport = first.getViewport({ scale: 0.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await first.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport
      }).promise;
      expect(canvas.width).toBeGreaterThan(100);
      expect(canvas.height).toBeGreaterThan(100);
    } finally {
      await loading.destroy();
    }
  });

  it('rejects a misleading .pdf file', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'broken.pdf');
    await writeFile(filePath, Buffer.from('not a pdf'));
    await expect(loadPdfSnapshot(filePath)).rejects.toMatchObject({ code: 'invalid_pdf' });
  });

  it('rejects oversized PDFs before allocating their contents', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'huge.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.7\n'));
    await truncate(filePath, MAX_PDF_BYTES + 1);
    await expect(loadPdfSnapshot(filePath)).rejects.toMatchObject({ code: 'too_large' });
  });
});

