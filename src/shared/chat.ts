export type ChatScope = 'selection' | 'page' | 'document' | 'custom';

export type ChatSessionState = 'idle' | 'sending' | 'waiting' | 'complete' | 'uncertain' | 'error';

export type ChatPendingState = 'queued' | 'authorized' | 'sent' | 'uncertain';

export interface ChatPageReference {
  documentId: string;
  page: number;
  reference: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  inputId: string;
  conversationId: string | null;
  messageId: string | null;
  turnId: string | null;
  requestId: string | null;
  final: boolean;
  pageReferences: ChatPageReference[];
  originSeq: number;
  revisionSeq: number;
}

export interface ChatSessionSnapshot {
  sessionId: string;
  documentId: string;
  conversationId: string | null;
  state: ChatSessionState;
  pendingInputId: string | null;
  pendingState: ChatPendingState | null;
  error: string | null;
  messages: ChatMessage[];
  nextSeq: number;
  updatedAt: number;
}

export interface ChatSendInput {
  documentId: string;
  text: string;
  scope: ChatScope;
  attachDocument?: boolean;
}

export interface PdfDocumentChunk {
  documentId: string;
  name: string;
  mimeType: 'application/pdf';
  size: number;
  offset: number;
  nextOffset: number;
  done: boolean;
  base64: string;
}

export const CHAT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CHAT_CONVERSATION_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

export function chatOwnershipMarker(sessionId: string, inputId: string): string {
  return `[[PDF-AI:${sessionId}:${inputId}]]`;
}

export function stripChatOwnershipMarker(text: string): string {
  return text.replace(/^\[\[PDF-AI:[0-9a-f-]{36}:[0-9a-f-]{36}\]\]\s*/i, '').trimStart();
}

export function parsePdfPageReferences(text: string): ChatPageReference[] {
  const references: ChatPageReference[] = [];
  const seen = new Set<string>();
  const pattern = /pdf:\/\/([A-Za-z0-9_-]{8,128})\/page\/(\d{1,6})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && references.length < 64) {
    const page = Number.parseInt(match[2]!, 10);
    if (!Number.isSafeInteger(page) || page < 1) continue;
    const reference = match[0]!;
    if (seen.has(reference)) continue;
    seen.add(reference);
    references.push({ documentId: match[1]!, page, reference });
  }
  return references;
}
