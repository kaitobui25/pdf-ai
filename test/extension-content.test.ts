import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
// @ts-expect-error jsdom has no declaration package installed in this local-only test harness.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

interface ContentHooks {
  conversationId(): string | null;
  ownershipMarkers(): Array<{ sessionId: string; inputId: string }>;
  messages(): Array<{ role: string; id: string; text: string }>;
  composer(): unknown;
  sendButton(): unknown;
}

describe('PDF-AI ChatGPT content script', () => {
  it('reads exact ownership markers and concrete conversation identity without using unrelated page text', async () => {
    const conversationId = '12345678-abcd-4abc-8abc-1234567890ab';
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const inputId = '22222222-2222-4222-8222-222222222222';
    const dom = new JSDOM(`<!doctype html><html><body>
      <section data-message-author-role="user" data-message-id="user-1" data-turn-id="turn-user">
        <div class="whitespace-pre-wrap">[[PDF-AI:${sessionId}:${inputId}]]\nQuestion</div>
      </section>
      <section data-message-author-role="assistant" data-message-id="assistant-1" data-turn-id="turn-assistant">
        <div class="markdown">Answer text</div>
      </section>
      <div>[[PDF-AI:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444]] unrelated</div>
      <form data-chatgpt-composer>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button type="button" data-testid="send-button">Send</button>
      </form>
    </body></html>`, {
      url: `https://chatgpt.com/c/${conversationId}`,
      runScripts: 'dangerously'
    });
    const window = dom.window as unknown as Record<string, any>;
    Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
    let hooks: ContentHooks | null = null;
    window.__PDF_AI_CONTENT_TEST_HOOK__ = (value: ContentHooks) => { hooks = value; };
    window.chrome = {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: async () => ({ ok: false })
      }
    };
    const source = await readFile(path.join(process.cwd(), 'extension', 'content.js'), 'utf8');
    window.eval(source);
    try {
      expect(hooks).not.toBeNull();
      const api = hooks as unknown as ContentHooks;
      expect(api.conversationId()).toBe(conversationId);
      expect(api.ownershipMarkers()).toEqual([{ sessionId, inputId }]);
      expect(api.messages().map((message: { role: string; id: string; text: string }) => ({
        role: message.role, id: message.id, text: message.text
      }))).toEqual([
        { role: 'user', id: 'user-1', text: `[[PDF-AI:${sessionId}:${inputId}]]\nQuestion` },
        { role: 'assistant', id: 'assistant-1', text: 'Answer text' }
      ]);
      expect(api.composer()).not.toBeNull();
      expect(api.sendButton()).not.toBeNull();
    } finally {
      window.__PDF_AI_CONTENT__?.stop?.();
      dom.window.close();
    }
  });
});
