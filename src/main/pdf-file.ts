import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, stat as statPath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PDF_BYTES } from '../shared/constants.js';
import type { PdfOpenError, PdfSnapshot } from '../shared/pdf.js';

export interface PdfFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PdfFileSnapshot {
  document: PdfSnapshot;
  filePath: string;
  identity: PdfFileIdentity;
}

function identityOf(stat: Stats): PdfFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

export function samePdfFileIdentity(left: PdfFileIdentity, right: PdfFileIdentity): boolean {
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

export async function loadPdfSnapshotRecord(filePath: string): Promise<PdfFileSnapshot> {
  const resolvedPath = path.resolve(filePath);
  const handle = await open(resolvedPath, 'r');
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
    const atPath = identityOf(await statPath(resolvedPath));
    if (!samePdfFileIdentity(expected, after) || !samePdfFileIdentity(expected, atPath)) {
      throw problem('changed', 'The PDF changed while it was being read.');
    }
    if (!pdfHeaderPresent(bytes)) throw problem('invalid_pdf', 'The selected file does not contain a PDF header.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      document: {
        documentId: 'pdf-' + digest.slice(0, 32),
        name: path.basename(resolvedPath),
        bytes,
        size: after.size,
        modifiedAt: new Date(after.mtimeMs).toISOString()
      },
      filePath: resolvedPath,
      identity: after
    };
  } finally {
    await handle.close();
  }
}

export async function loadPdfSnapshot(filePath: string): Promise<PdfSnapshot> {
  return (await loadPdfSnapshotRecord(filePath)).document;
}

export async function pdfFileIdentityMatches(
  filePath: string,
  expected: PdfFileIdentity
): Promise<boolean> {
  try {
    const current = identityOf(await statPath(filePath));
    return samePdfFileIdentity(expected, current);
  } catch {
    return false;
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
