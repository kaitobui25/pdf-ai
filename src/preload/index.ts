import { contextBridge, ipcRenderer } from 'electron';
import type { PdfAiApi, RuntimeInfo } from '../shared/api.js';
import type { PdfOpenResult } from '../shared/pdf.js';

const api: PdfAiApi = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info') as Promise<RuntimeInfo>,
  openPdf: () => ipcRenderer.invoke('pdf:open') as Promise<PdfOpenResult>
};

contextBridge.exposeInMainWorld('pdfAi', api);
