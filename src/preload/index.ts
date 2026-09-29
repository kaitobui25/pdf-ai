import { contextBridge, ipcRenderer } from 'electron';
import type { PdfAiApi, RuntimeInfo } from '../shared/api.js';

const api: PdfAiApi = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info') as Promise<RuntimeInfo>
};

contextBridge.exposeInMainWorld('pdfAi', api);

