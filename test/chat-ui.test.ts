import { describe, expect, it } from 'vitest';
import { canNavigateChatReference, chatStatusView, shouldApplyChatResult } from '../src/renderer/chat-ui.js';

describe('PDF-AI local chat UI helpers', () => {
  it('only activates page references for the exact current document and valid page range', () => {
    const reference = { documentId: 'pdf-abc12345', page: 3, reference: 'pdf://pdf-abc12345/page/3' };
    expect(canNavigateChatReference(reference, 'pdf-abc12345', 5)).toBe(true);
    expect(canNavigateChatReference(reference, 'pdf-other123', 5)).toBe(false);
    expect(canNavigateChatReference({ ...reference, page: 0 }, 'pdf-abc12345', 5)).toBe(false);
    expect(canNavigateChatReference({ ...reference, page: 99 }, 'pdf-abc12345', 5)).toBe(false);
  });

  it('rejects stale A-to-B-to-A async results by generation, not only document id', () => {
    expect(shouldApplyChatResult('pdf-a1234567', 1, 'pdf-a1234567', 3)).toBe(false);
    expect(shouldApplyChatResult('pdf-a1234567', 3, 'pdf-a1234567', 3)).toBe(true);
    expect(shouldApplyChatResult('pdf-a1234567', 3, 'pdf-b1234567', 3)).toBe(false);
  });

  it('surfaces uncertain delivery without offering an unsafe cancel', () => {
    expect(chatStatusView({
      sessionId: 's', documentId: 'd', conversationId: null, state: 'uncertain', pendingInputId: 'i',
      pendingState: 'uncertain', error: 'receipt missing', messages: [], nextSeq: 1, updatedAt: 1
    })).toEqual({ label: 'Delivery uncertain', busy: true, cancellable: false, error: true });
  });
});
