export interface OpenedPdf {
  documentId: string;
  name: string;
  bytes: Uint8Array;
  size: number;
  modifiedAt: string;
}

export interface PdfOpenError {
  code: 'cancelled' | 'invalid_pdf' | 'too_large' | 'changed' | 'io_error';
  message: string;
}

export type PdfOpenResult =
  | { ok: true; document: OpenedPdf }
  | { ok: false; error: PdfOpenError };

export interface PdfSearchHit {
  page: number;
  index: number;
  snippet: string;
}

