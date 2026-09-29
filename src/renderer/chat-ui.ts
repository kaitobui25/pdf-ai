import type { ChatPageReference, ChatSessionSnapshot } from '../shared/chat.js';

export interface ChatStatusView {
  label: string;
  busy: boolean;
  cancellable: boolean;
  error: boolean;
}

export function chatStatusView(session: ChatSessionSnapshot | null): ChatStatusView {
  if (!session) return { label: 'No session', busy: false, cancellable: false, error: false };
  switch (session.state) {
    case 'idle': return { label: 'Ready', busy: false, cancellable: false, error: false };
    case 'sending': return {
      label: session.pendingState === 'authorized' ? 'Sending · authorized' : 'Sending',
      busy: true,
      cancellable: session.pendingState === 'queued',
      error: false
    };
    case 'waiting': return { label: 'Waiting for ChatGPT', busy: true, cancellable: false, error: false };
    case 'complete': return { label: 'Complete', busy: false, cancellable: false, error: false };
    case 'uncertain': return { label: 'Delivery uncertain', busy: true, cancellable: false, error: true };
    case 'error': return { label: 'Error', busy: false, cancellable: false, error: true };
  }
}

export function canNavigateChatReference(
  reference: ChatPageReference,
  documentId: string | null,
  pageCount: number
): boolean {
  return documentId !== null
    && reference.documentId === documentId
    && Number.isSafeInteger(reference.page)
    && reference.page >= 1
    && reference.page <= pageCount;
}

export function shouldApplyChatResult(
  requestedDocumentId: string,
  requestedGeneration: number,
  currentDocumentId: string | null,
  currentGeneration: number
): boolean {
  return requestedDocumentId === currentDocumentId && requestedGeneration === currentGeneration;
}
