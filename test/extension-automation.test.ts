import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PDF_AI_EVENT_OUTBOX_KEY,
  PDF_AI_OWNED_CHATS_KEY,
  conversationFromUrl,
  createChatAutomation
} from '../extension/automation.js';

class MemoryStorage {
  readonly values: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> { return { [key]: this.values[key] }; }
  async set(values: Record<string, unknown>): Promise<void> { Object.assign(this.values, structuredClone(values)); }
}

function event(kind: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    kind,
    sessionId: payload.sessionId,
    documentId: payload.documentId,
    inputId: payload.inputId,
    conversationId: '12345678-abcd-4abc-8abc-1234567890ab',
    time: Date.now(),
    ...extra
  };
}

describe('PDF-AI ChatGPT ownership automation', () => {
  it('parses only concrete ChatGPT conversation routes', () => {
    expect(conversationFromUrl('https://chatgpt.com/c/12345678-abcd')).toBe('12345678-abcd');
    expect(conversationFromUrl('https://chatgpt.com/g/project/c/12345678-abcd')).toBe('12345678-abcd');
    expect(conversationFromUrl('https://chatgpt.com/share/c/12345678-abcd')).toBeNull();
    expect(conversationFromUrl('https://example.com/c/12345678-abcd')).toBeNull();
  });

  it('ignores an unrelated active tab, creates an owned chat, and reuses only its exact conversation', async () => {
    const storage = new MemoryStorage();
    const tabs: Array<{ id: number; url: string; active?: boolean }> = [
      { id: 1, url: 'https://chatgpt.com/c/deadbeef-dead-beef-dead-beefdeadbeef', active: true }
    ];
    let nextTab = 2;
    const sentTo: number[] = [];
    const posted: unknown[][] = [];
    const chromeApi = {
      runtime: {},
      tabs: {
        get: async (id: number) => {
          const tab = tabs.find(candidate => candidate.id === id);
          if (!tab) throw new Error('missing tab');
          return tab;
        },
        query: async () => tabs.filter(tab => tab.url.startsWith('https://chatgpt.com/')),
        create: async ({ url, active }: { url: string; active: boolean }) => {
          const tab = { id: nextTab++, url, active };
          tabs.push(tab);
          return tab;
        },
        sendMessage: async (id: number, message: { command?: Record<string, unknown> }) => {
          sentTo.push(id);
          const payload = message.command!;
          const conversationId = '12345678-abcd-4abc-8abc-1234567890ab';
          const tab = tabs.find(candidate => candidate.id === id)!;
          tab.url = `https://chatgpt.com/c/${conversationId}`;
          return {
            ok: true,
            conversationId,
            events: [
              event('chat_owned', payload),
              event('input_sent', payload, { messageId: `user-${payload.inputId}` }),
              event('assistant_message', payload, {
                messageId: `assistant-${payload.inputId}`,
                text: 'done',
                final: true
              })
            ]
          };
        }
      }
    };
    const bridgeClient = {
      postEvents: async (events: unknown[]) => {
        posted.push(events);
        return {
          ok: true,
          data: { receipts: (events as Array<{ eventId: string }>).map(row => ({ eventId: row.eventId, status: 'ok' })) }
        };
      },
      getDocumentChunk: async () => ({ ok: false, error: 'unused' })
    };
    const automation = createChatAutomation({ chromeApi, bridgeClient, localStorage: storage });
    const sessionId = randomUUID();
    const documentId = 'pdf-0123456789abcdef0123456789abcdef';
    const firstInput = randomUUID();
    const first = await automation.processCommand({
      id: '0123456789abcdef01234567',
      type: 'chat_send',
      payload: {
        sessionId,
        documentId,
        inputId: firstInput,
        conversationId: null,
        prompt: 'first',
        attachDocument: false,
        document: { documentId, name: 'paper.pdf', size: 100 }
      }
    });
    expect(first).toEqual({ status: 'ok' });
    expect(sentTo).toEqual([2]);
    expect(tabs[0]?.id).toBe(1);
    expect(tabs[0]?.active).toBe(true);
    expect(tabs[1]?.active).toBe(false);
    await automation.drainEvents();

    const secondInput = randomUUID();
    const second = await automation.processCommand({
      id: '89abcdef0123456789abcdef',
      type: 'chat_send',
      payload: {
        sessionId,
        documentId,
        inputId: secondInput,
        conversationId: '12345678-abcd-4abc-8abc-1234567890ab',
        prompt: 'second',
        attachDocument: false,
        document: { documentId, name: 'paper.pdf', size: 100 }
      }
    });
    expect(second).toEqual({ status: 'ok' });
    expect(sentTo).toEqual([2, 2]);
    await automation.drainEvents();
    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(storage.values[PDF_AI_OWNED_CHATS_KEY]).toMatchObject({
      [sessionId]: { documentId, tabId: 2, conversationId: '12345678-abcd-4abc-8abc-1234567890ab' }
    });
    expect(storage.values[PDF_AI_EVENT_OUTBOX_KEY]).toEqual([]);
  });

  it('rejects messages from a retired Chrome document after a same-tab reload', async () => {
    const storage = new MemoryStorage();
    const sessionId = randomUUID();
    const inputId = randomUUID();
    const documentId = 'pdf-0123456789abcdef0123456789abcdef';
    const conversationId = '12345678-abcd-4abc-8abc-1234567890ab';
    storage.values[PDF_AI_OWNED_CHATS_KEY] = {
      [sessionId]: {
        sessionId,
        documentId,
        conversationId,
        tabId: 7,
        pendingInputId: inputId,
        commandId: '0123456789abcdef01234567',
        updatedAt: Date.now()
      }
    };
    const chunks: unknown[] = [];
    const bridgeClient = {
      postEvents: async () => ({ ok: true, data: { receipts: [] } }),
      getDocumentChunk: async (...args: unknown[]) => {
        chunks.push(args);
        return { ok: true, data: { documentId, offset: 0, nextOffset: 1, done: true, base64: 'AA==' } };
      }
    };
    const chromeApi = {
      runtime: {},
      tabs: {
        get: async () => ({ id: 7, url: `https://chatgpt.com/c/${conversationId}` }),
        query: async () => [],
        create: async () => { throw new Error('not used'); },
        sendMessage: async () => ({ ok: true })
      }
    };
    const automation = createChatAutomation({ chromeApi, bridgeClient, localStorage: storage });
    const documentToken = randomUUID();
    const ready = await automation.handleRuntimeMessage({
      type: 'pdf-ai:page-ready',
      documentToken,
      conversationId,
      markers: [{ sessionId, inputId }]
    }, {
      frameId: 0,
      documentId: 'chrome-document-new',
      url: `https://chatgpt.com/c/${conversationId}`,
      tab: { id: 7, url: `https://chatgpt.com/c/${conversationId}` }
    });
    expect(ready).toMatchObject({ ok: true, owned: true, sessionId });

    const retired = await automation.handleRuntimeMessage({
      type: 'pdf-ai:file-chunk',
      documentToken,
      sessionId,
      documentId,
      inputId,
      offset: 0,
      limit: 1
    }, {
      frameId: 0,
      documentId: 'chrome-document-old',
      url: `https://chatgpt.com/c/${conversationId}`,
      tab: { id: 7, url: `https://chatgpt.com/c/${conversationId}` }
    });
    expect(retired).toMatchObject({ ok: false, error: 'unowned_chat_tab' });
    expect(chunks).toHaveLength(0);

    const current = await automation.handleRuntimeMessage({
      type: 'pdf-ai:file-chunk',
      documentToken,
      sessionId,
      documentId,
      inputId,
      offset: 0,
      limit: 1
    }, {
      frameId: 0,
      documentId: 'chrome-document-new',
      url: `https://chatgpt.com/c/${conversationId}`,
      tab: { id: 7, url: `https://chatgpt.com/c/${conversationId}` }
    });
    expect(current).toMatchObject({ ok: true });
    expect(chunks).toHaveLength(1);
  });

  it('persists send authorization and never re-dispatches the same input after restart/redelivery', async () => {
    const storage = new MemoryStorage();
    const sessionId = randomUUID();
    const inputId = randomUUID();
    const documentId = 'pdf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const conversationId = '55555555-abcd-4abc-8abc-1234567890ab';
    const posted: Array<Array<Record<string, unknown>>> = [];
    const sent: string[] = [];
    const bridgeClient = {
      postEvents: async (events: Array<Record<string, unknown>>) => {
        posted.push(events);
        return { ok: true, data: { receipts: events.map(row => ({ eventId: row.eventId, status: 'ok' })) } };
      },
      getDocumentChunk: async () => ({ ok: false, error: 'unused' })
    };
    const chromeApi = {
      runtime: {},
      tabs: {
        get: async () => ({ id: 9, url: `https://chatgpt.com/c/${conversationId}` }),
        query: async () => [],
        create: async () => { throw new Error('not used'); },
        sendMessage: async (_id: number, message: { type: string }) => { sent.push(message.type); return { ok: true }; }
      }
    };
    storage.values[PDF_AI_OWNED_CHATS_KEY] = {
      [sessionId]: {
        sessionId, documentId, conversationId, tabId: 9, tabDocumentId: 'doc-9',
        documentToken: '11111111-1111-4111-8111-111111111111', pendingInputId: inputId,
        authorizedInputId: null, commandId: '0123456789abcdef01234567', updatedAt: Date.now()
      }
    };
    const automation = createChatAutomation({ chromeApi, bridgeClient, localStorage: storage });
    const authorize = await automation.handleRuntimeMessage({
      type: 'pdf-ai:authorize-send', documentToken: '11111111-1111-4111-8111-111111111111',
      sessionId, documentId, inputId, conversationId
    }, {
      frameId: 0, documentId: 'doc-9', url: `https://chatgpt.com/c/${conversationId}`,
      tab: { id: 9, url: `https://chatgpt.com/c/${conversationId}` }
    });
    expect(authorize).toMatchObject({ ok: true });
    await automation.drainEvents();
    expect(storage.values[PDF_AI_OWNED_CHATS_KEY]).toMatchObject({
      [sessionId]: { authorizedInputId: inputId }
    });
    expect(posted.flat().some(row => row.kind === 'send_authorized')).toBe(true);

    const restarted = createChatAutomation({ chromeApi, bridgeClient, localStorage: storage });
    const replay = await restarted.processCommand({
      id: '0123456789abcdef01234567', type: 'chat_send',
      payload: {
        sessionId, documentId, inputId, conversationId, prompt: 'must not send twice', attachDocument: false,
        document: { documentId, name: 'paper.pdf', size: 10 }
      }
    });
    expect(replay).toMatchObject({ status: 'ok', error: 'send_already_authorized' });
    expect(sent).not.toContain('pdf-ai:send');
    expect(sent).toContain('pdf-ai:resume');
  });
});
