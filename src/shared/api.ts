import type { PdfOpenResult, PdfSelectionUpdate } from './pdf.js';

export interface RuntimeInfo {
  appName: string;
  appId: string;
  bridgeId: string;
  bridgePorts: readonly number[];
  mcpConnectorName: string;
}

export interface PdfAiApi {
  runtimeInfo(): Promise<RuntimeInfo>;
  openPdf(): Promise<PdfOpenResult>;
  setCurrentPage(documentId: string, viewEpoch: number, seq: number, page: number): Promise<boolean>;
  setSelection(
    documentId: string,
    viewEpoch: number,
    seq: number,
    selection: PdfSelectionUpdate | null
  ): Promise<boolean>;
}
