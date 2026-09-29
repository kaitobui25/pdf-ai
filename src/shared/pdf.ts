export interface PdfSnapshot {
  documentId: string;
  name: string;
  bytes: Uint8Array;
  size: number;
  modifiedAt: string;
}

export interface OpenedPdf extends PdfSnapshot {
  viewEpoch: number;
}

export interface PdfOpenError {
  code: 'cancelled' | 'invalid_pdf' | 'too_large' | 'changed' | 'io_error';
  message: string;
}

export type PdfOpenResult =
  | { ok: true; document: OpenedPdf }
  | { ok: false; error: PdfOpenError };

export interface PdfNormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfSelectionUpdate {
  text: string;
  startPage: number;
  endPage: number;
  bounds?: PdfNormalizedRegion;
}

export interface PdfSelectionState extends PdfSelectionUpdate {
  documentId: string;
  revision: string;
  startReference: string;
  endReference: string;
}

export interface PdfPageReference {
  documentId: string;
  revision: string;
  page: number;
  pageCount: number;
  reference: string;
}

export interface PdfDocumentSummary {
  documentId: string;
  revision: string;
  name: string;
  size: number;
  modifiedAt: string;
  pageCount: number;
  currentPage: number;
  current: boolean;
  changed: boolean;
}

export interface PdfCurrentPage extends PdfPageReference {
  name: string;
}

export interface PdfSearchHit {
  page: number;
  index: number;
  snippet: string;
}

export interface PdfEngineSearchHit extends PdfSearchHit {
  documentId: string;
  revision: string;
  reference: string;
}

export interface PdfPageText extends PdfPageReference {
  text: string;
}

export interface PdfReadPagesResult {
  documentId: string;
  revision: string;
  name: string;
  pages: PdfPageText[];
  totalCharacters: number;
}

export interface PdfRenderedImage extends PdfPageReference {
  mimeType: 'image/png';
  width: number;
  height: number;
  scale: number;
  region?: PdfNormalizedRegion;
  bytes: Uint8Array;
}
