import type { PdfOpenResult } from './pdf.js';

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
}
