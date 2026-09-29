import type { PdfAiBridgeClient, BridgeStorageArea } from './bridge-client.js';

export const PDF_AI_OWNED_CHATS_KEY: 'pdfAiOwnedChats';
export const PDF_AI_EVENT_OUTBOX_KEY: 'pdfAiEventOutbox';

export function conversationFromUrl(url: string): string | null;

export interface ChatAutomation {
  cancelCommand(command: unknown): Promise<{ status: 'ok' | 'failed'; error?: string }>;
  drainEvents(): Promise<unknown>;
  handleTabRemoved(tabId: number): Promise<void>;
  handleRuntimeMessage(message: unknown, sender: unknown): Promise<unknown>;
  processCommand(command: unknown): Promise<{ status: 'ok' | 'failed'; error?: string }>;
  restoreOwnedChats(): Promise<void>;
  status(): Promise<{ ownedChats: number; activeInputs: number; pendingEvents: number }>;
}

export function createChatAutomation(options: {
  chromeApi: any;
  bridgeClient: Pick<PdfAiBridgeClient, 'postEvents' | 'getDocumentChunk'>;
  localStorage: BridgeStorageArea;
  now?: () => number;
}): ChatAutomation;
