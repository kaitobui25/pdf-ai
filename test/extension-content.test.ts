import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
// @ts-expect-error jsdom has no declaration package installed in this local-only test harness.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

interface ContentHooks {
  conversationId(): string | null;
  ownershipMarkers(): Array<{ sessionId: string; inputId: string }>;
  messages(): Array<{ role: string; id: string; text: string; turnId?: string | null; node?: Element | null }>;
  composer(): unknown;
  sendButton(): unknown;
  responseComplete(message: { node?: Element | null }): boolean;
  composerFileName(button: Element): string | undefined;
  hasComposerAttachments(): boolean;
  fileUploadInput(): HTMLInputElement | null;
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
        <input type="file" accept="image/*">
        <input id="generic-upload" type="file">
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
      expect(api.fileUploadInput()?.id).toBe('generic-upload');
      expect(api.hasComposerAttachments()).toBe(false);

      const form = dom.window.document.querySelector('form')!;
      const tile = dom.window.document.createElement('div');
      tile.setAttribute('role', 'group');
      tile.setAttribute('aria-label', '11428195_EN.pdf');
      const defaultAction = dom.window.document.createElement('div');
      defaultAction.setAttribute('data-default-action', 'true');
      defaultAction.append(dom.window.document.createElement('button'));
      const remove = dom.window.document.createElement('button');
      remove.setAttribute('aria-label', 'Remove file: 11428195_EN.pdf');
      tile.append(defaultAction, remove);
      form.append(tile);
      expect(api.composerFileName(remove)).toBe('11428195_EN.pdf');
      expect(api.hasComposerAttachments()).toBe(true);
    } finally {
      window.__PDF_AI_CONTENT__?.stop?.();
      dom.window.close();
    }
  });

  it('reads assistant markdown from the current shell even when it has no assistant message attribute', async () => {
    const conversationId = '87654321-abcd-4abc-8abc-1234567890ab';
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const inputId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dom = new JSDOM(`<!doctype html><html><body>
      <main data-app-shell-main-surface>
        <div data-thread-find-target="conversation">
          <div data-turn-key="turn-live">
            <div data-content-search-unit-key="fallback-turn-0:0:user">
              <div data-user-message-bubble><div class="whitespace-pre-wrap">[[PDF-AI:${sessionId}:${inputId}]]\nQuestion</div></div>
            </div>
            <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"></div>
            <div><div class="markdown">Final answer from the current ChatGPT shell.</div></div>
          </div>
        </div>
      </main>
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
      const api = hooks as unknown as ContentHooks;
      expect(api.ownershipMarkers()).toEqual([{ sessionId, inputId }]);
      expect(api.messages().map(message => ({ role: message.role, text: message.text }))).toEqual([
        { role: 'user', text: `[[PDF-AI:${sessionId}:${inputId}]]\nQuestion` },
        { role: 'assistant', text: 'Final answer from the current ChatGPT shell.' }
      ]);
      expect(api.messages().map(message => message.turnId)).toEqual(['turn-live', 'turn-live']);
      const assistant = api.messages().find(message => message.role === 'assistant')!;
      expect(api.responseComplete(assistant)).toBe(false);
      const actions = dom.window.document.createElement('div');
      const regenerate = dom.window.document.createElement('button');
      regenerate.setAttribute('aria-label', 'Regenerate response');
      actions.append(regenerate);
      dom.window.document.querySelector('[data-turn-key="turn-live"]')!.append(actions);
      expect(api.responseComplete(assistant)).toBe(true);
    } finally {
      window.__PDF_AI_CONTENT__?.stop?.();
      dom.window.close();
    }
  });
});
