import { contextBridge, ipcRenderer } from 'electron';
import type { PdfAiApi, RuntimeInfo } from '../shared/api.js';
import type { PdfOpenResult, PdfSelectionUpdate } from '../shared/pdf.js';
import type { TunnelConnectInput, TunnelConnectionStatus } from '../shared/tunnel.js';
import type { ChatSendInput, ChatSessionSnapshot } from '../shared/chat.js';

const api: PdfAiApi = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info') as Promise<RuntimeInfo>,
  openPdf: () => ipcRenderer.invoke('pdf:open') as Promise<PdfOpenResult>,
  setCurrentPage: (documentId: string, viewEpoch: number, seq: number, page: number) =>
    ipcRenderer.invoke('pdf:set-current-page', documentId, viewEpoch, seq, page) as Promise<boolean>,
  setSelection: (
    documentId: string,
    viewEpoch: number,
    seq: number,
    selection: PdfSelectionUpdate | null
  ) => ipcRenderer.invoke(
    'pdf:set-selection',
    documentId,
    viewEpoch,
    seq,
    selection
  ) as Promise<boolean>,
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status') as Promise<TunnelConnectionStatus>,
  tunnelConnect: (input: TunnelConnectInput) =>
    ipcRenderer.invoke('tunnel:connect', input) as Promise<TunnelConnectionStatus>,
  tunnelDisconnect: () => ipcRenderer.invoke('tunnel:disconnect') as Promise<TunnelConnectionStatus>,
  chatSession: (documentId: string) =>
    ipcRenderer.invoke('chat:session', documentId) as Promise<ChatSessionSnapshot | null>,
  chatSend: (input: ChatSendInput) =>
    ipcRenderer.invoke('chat:send', input) as Promise<ChatSessionSnapshot>
};

contextBridge.exposeInMainWorld('pdfAi', api);
