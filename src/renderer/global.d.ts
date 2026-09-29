import type { PdfAiApi } from '../shared/api.js';

declare global {
  interface Window {
    pdfAi: PdfAiApi;
  }
}

export {};

