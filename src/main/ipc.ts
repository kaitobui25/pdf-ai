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
import type { TunnelConnectInput, TunnelConnectionStatus } from '../shared/tunnel.js';
import type { ChatSendInput, ChatSessionSnapshot } from '../shared/chat.js';
import { z } from 'zod';
import { PdfDocumentEngine } from './pdf-document-engine.js';
import { pdfOpenError } from './pdf-file.js';
import { TunnelManager } from './tunnel-manager.js';
import { ChatSessionManager } from './chat-session-manager.js';

const tunnelConnectSchema = z.object({
  tunnelId: z.string().min(1).max(80),
  apiKey: z.string().max(512).optional()
}).strict();

const documentIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const chatSendSchema = z.object({
  documentId: documentIdSchema,
  text: z.string().min(1).max(20_000),
  scope: z.enum(['selection', 'page', 'document', 'custom']),
  attachDocument: z.boolean().optional()
}).strict();

export function registerIpc(
  engine: PdfDocumentEngine,
  tunnelManager: TunnelManager,
  chatManager: ChatSessionManager
): void {
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
  ipcMain.handle('tunnel:status', (): Promise<TunnelConnectionStatus> => tunnelManager.getStatus());
  ipcMain.handle('tunnel:connect', (_event, input: unknown): Promise<TunnelConnectionStatus> => {
    const parsed = tunnelConnectSchema.parse(input) as TunnelConnectInput;
    return tunnelManager.connect(parsed);
  });
  ipcMain.handle('tunnel:disconnect', (): Promise<TunnelConnectionStatus> => tunnelManager.disconnect());
  ipcMain.handle('chat:session', (_event, documentId: unknown): Promise<ChatSessionSnapshot | null> =>
    chatManager.getSession(documentIdSchema.parse(documentId)));
  ipcMain.handle('chat:send', (_event, input: unknown): Promise<ChatSessionSnapshot> =>
    chatManager.send(chatSendSchema.parse(input) as ChatSendInput));
  ipcMain.handle('chat:cancel', (_event, documentId: unknown): Promise<ChatSessionSnapshot> =>
    chatManager.cancel(documentIdSchema.parse(documentId)));
}
