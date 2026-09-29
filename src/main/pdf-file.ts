import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PDF_BYTES } from '../shared/constants.js';
import type { OpenedPdf, PdfOpenError } from '../shared/pdf.js';

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function identityOf(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function pdfHeaderPresent(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(1024, bytes.length)));
  return prefix.includes(Buffer.from('%PDF-'));
}

function problem(code: PdfOpenError['code'], message: string): PdfOpenError {
  return { code, message };
}

export async function loadPdfSnapshot(filePath: string): Promise<OpenedPdf> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw problem('invalid_pdf', 'Choose a regular PDF file.');
    if (before.size <= 0) throw problem('invalid_pdf', 'The selected PDF is empty.');
    if (before.size > MAX_PDF_BYTES) {
      throw problem('too_large', 'PDF files must be 128 MB or smaller for local reading.');
    }
    const expected = identityOf(before);
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (chunk.bytesRead <= 0) throw problem('changed', 'The PDF changed while it was being read.');
      offset += chunk.bytesRead;
    }
    const after = identityOf(await handle.stat());
    if (!sameIdentity(expected, after)) throw problem('changed', 'The PDF changed while it was being read.');
    if (!pdfHeaderPresent(bytes)) throw problem('invalid_pdf', 'The selected file does not contain a PDF header.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      documentId: 'pdf-' + digest.slice(0, 32),
      name: path.basename(filePath),
      bytes,
      size: after.size,
      modifiedAt: new Date(after.mtimeMs).toISOString()
    };
  } finally {
    await handle.close();
  }
}

export function pdfOpenError(error: unknown): PdfOpenError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if ((candidate.code === 'invalid_pdf' || candidate.code === 'too_large' || candidate.code === 'changed') &&
        typeof candidate.message === 'string') {
      return { code: candidate.code, message: candidate.message };
    }
  }
  const message = error instanceof Error ? error.message : 'Could not open the selected PDF.';
  return { code: 'io_error', message };
}
