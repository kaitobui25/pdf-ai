import { contextBridge, ipcRenderer } from 'electron';
import type { PdfAiApi, RuntimeInfo } from '../shared/api.js';
import type { PdfOpenResult, PdfSelectionUpdate } from '../shared/pdf.js';

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
  ) as Promise<boolean>
};

contextBridge.exposeInMainWorld('pdfAi', api);
