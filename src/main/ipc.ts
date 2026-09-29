import { dialog, ipcMain } from 'electron';
import {
  APP_ID,
  APP_NAME,
  BRIDGE_ID,
  BRIDGE_PORTS,
  MCP_CONNECTOR_NAME
} from '../shared/constants.js';
import type { RuntimeInfo } from '../shared/api.js';
import type { PdfOpenResult, PdfSelectionUpdate } from '../shared/pdf.js';
import { PdfDocumentEngine } from './pdf-document-engine.js';
import { pdfOpenError } from './pdf-file.js';

export function registerIpc(engine: PdfDocumentEngine): void {
  ipcMain.handle('runtime:info', (): RuntimeInfo => ({
    appName: APP_NAME,
    appId: APP_ID,
    bridgeId: BRIDGE_ID,
    bridgePorts: BRIDGE_PORTS,
    mcpConnectorName: MCP_CONNECTOR_NAME
  }));
  ipcMain.handle('pdf:open', async (): Promise<PdfOpenResult> => {
    const selection = await dialog.showOpenDialog({
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) {
      return { ok: false, error: { code: 'cancelled', message: 'No PDF selected.' } };
    }
    try {
      return { ok: true, document: await engine.openFile(filePath) };
    } catch (error) {
      return { ok: false, error: pdfOpenError(error) };
    }
  });
  ipcMain.handle(
    'pdf:set-current-page',
    (_event, documentId: string, viewEpoch: number, seq: number, page: number): boolean => {
      return engine.setCurrentPage(documentId, viewEpoch, seq, page);
    }
  );
  ipcMain.handle(
    'pdf:set-selection',
    (
      _event,
      documentId: string,
      viewEpoch: number,
      seq: number,
      selection: PdfSelectionUpdate | null
    ): boolean => {
      return engine.setSelection(documentId, viewEpoch, seq, selection);
    }
  );
}
