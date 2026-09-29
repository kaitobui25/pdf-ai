(() => {
  'use strict';

  const VERSION = 1;
  const incumbent = globalThis.__PDF_AI_CONTENT__;
  if (incumbent?.version >= VERSION && incumbent.alive?.()) return;
  incumbent?.stop?.();

  let running = true;
  let active = null;
  let lastPath = location.pathname;
  let scanTimer = null;
  let finalTimer = null;
  let observer = null;
  const documentToken = crypto.randomUUID();

  const MARKER = /\[\[PDF-AI:([0-9a-f-]{36}):([0-9a-f-]{36})\]\]/i;
  const CHAT_ID = /^[0-9a-f-]{8,64}$/i;

  function safe(fn, fallback = null) {
    try { return fn(); } catch { return fallback; }
  }

  function conversationId() {
    const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(location.pathname);
    return match ? match[1] : null;
  }

  function markerOf(text) {
    const match = MARKER.exec(String(text || ''));
    return match ? { sessionId: match[1], inputId: match[2] } : null;
  }

  function turnId(node) {
    const turn = node?.closest?.('[data-turn-id], [data-turn-key], [data-chatgpt-search-unit-key]');
    return turn?.getAttribute?.('data-turn-id') || turn?.getAttribute?.('data-turn-key') ||
      turn?.getAttribute?.('data-chatgpt-search-unit-key') || null;
  }

  function requestId(node) {
    const holder = node?.closest?.('[data-request-id]') || node?.querySelector?.('[data-request-id]');
    const value = holder?.getAttribute?.('data-request-id');
    return value && value.length <= 256 ? value : null;
  }

  function messageId(node, index) {
    const direct = node?.getAttribute?.('data-message-id') ||
      node?.getAttribute?.('data-chatgpt-selection-message-id') ||
      node?.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      node?.querySelector?.('[data-chatgpt-selection-message-id]')?.getAttribute?.('data-chatgpt-selection-message-id');
    return direct || `${turnId(node) || 'turn'}:${index}`;
  }

  function cleanText(node, role) {
    if (!node) return '';
    if (role === 'user') {
      const parts = [...node.querySelectorAll?.('.whitespace-pre-wrap, [data-user-message-bubble]') || []]
        .filter(part => !part.parentElement?.closest?.('.whitespace-pre-wrap'))
        .map(part => (part.textContent || '').trim()).filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
    if (role === 'assistant') {
      const parts = [...node.querySelectorAll?.('.markdown, [data-markdown-text-style="assistant-message"]') || []]
        .filter(part => !part.closest?.('[data-interrupted]'))
        .map(part => (part.textContent || '').trim()).filter(Boolean);
      if (parts.length) return parts.join('\n\n');
    }
    const clone = safe(() => node.cloneNode(true), null);
    if (clone?.querySelectorAll) {
      for (const control of clone.querySelectorAll('button, [role="button"], [aria-hidden="true"]')) control.remove();
      return (clone.textContent || '').replace(/\u00a0/g, ' ').trim().slice(0, 128_000);
    }
    return (node.textContent || '').replace(/\u00a0/g, ' ').trim().slice(0, 128_000);
  }

  function roleOf(node) {
    const explicit = node.getAttribute?.('data-message-author-role');
    if (explicit === 'user' || explicit === 'assistant') return explicit;
    const key = node.getAttribute?.('data-content-search-unit-key') || node.getAttribute?.('data-chatgpt-search-unit-key') || '';
    const match = /:(user|assistant)$/.exec(key);
    return match?.[1] || null;
  }

  function messages() {
    const candidates = [...document.querySelectorAll(
      '[data-message-author-role="user"], [data-message-author-role="assistant"], ' +
      '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"], ' +
      '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]'
    )];
    const unique = candidates.filter(node => !candidates.some(other => other !== node && other.contains?.(node) && roleOf(other) === roleOf(node)));
    const seen = new Set();
    const result = [];
    for (let index = 0; index < unique.length; index++) {
      const node = unique[index];
      const role = roleOf(node);
      if (!role) continue;
      const id = messageId(node, index);
      const key = `${role}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id,
        role,
        text: cleanText(node, role),
        turnId: turnId(node),
        requestId: requestId(node),
        node
      });
    }
    return result;
  }

  function ownershipMarkers() {
    const result = [];
    const seen = new Set();
    for (const message of messages()) {
      if (message.role !== 'user') continue;
      const marker = markerOf(message.text);
      if (!marker) continue;
      const key = `${marker.sessionId}:${marker.inputId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(marker);
      if (result.length >= 20) break;
    }
    return result;
  }

  function composer() {
    return document.querySelector('#prompt-textarea') ||
      [...document.querySelectorAll('form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')]
        .find(node => node.isConnected && node.getAttribute('aria-disabled') !== 'true') || null;
  }

  function composerHost() {
    const box = composer();
    return box?.closest?.('form[data-chatgpt-composer], form') || box?.parentElement || null;
  }

  function stopButton() {
    return document.querySelector(
      'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
      'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]'
    );
  }

  function sendButton() {
    const host = composerHost();
    if (!host) return null;
    const explicit = host.querySelector(
      'button[data-testid="send-button"], button[aria-label^="Send" i], button[type="submit"]'
    );
    if (explicit) return explicit;
    const primary = [...host.querySelectorAll('button[class*="size-token-button-composer"][class*="bg-composer-primary"]')]
      .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    return primary.length === 1 ? primary[0] : null;
  }

  function sendEnabled(button) {
    return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }

  function composerText(box = composer()) {
    if (!box) return '';
    return (typeof box.innerText === 'string' ? box.innerText : box.textContent || '').trim();
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function setComposerText(value) {
    const box = composer();
    if (!box || !box.isConnected || box.getAttribute('contenteditable') === 'false' || composerText(box)) return false;
    box.focus();
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value) === true;
    } catch {
      inserted = false;
    }
    if (!inserted && !composerText(box)) {
      box.textContent = value;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    return box.isConnected && composer() === box && compactText(composerText(box)) === compactText(value);
  }

  function waitFor(predicate, timeoutMs, intervalMs = 100) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const value = safe(predicate, null);
        if (value) return resolve(value);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  async function runtimeMessage(message) {
    try { return await chrome.runtime.sendMessage(message); } catch { return null; }
  }

  function decodeBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function attachmentPresent(name) {
    const host = composerHost();
    if (!host) return false;
    return [...host.querySelectorAll('[aria-label], img[alt]')].some(node =>
      node.getAttribute('aria-label') === name || node.getAttribute('alt') === name ||
      (node.getAttribute('aria-label') || '').endsWith(`: ${name}`)
    );
  }

  async function loadDocumentFile(command) {
    const parts = [];
    let offset = 0;
    let expectedSize = null;
    let name = command.document?.name || 'document.pdf';
    while (true) {
      const reply = await runtimeMessage({
        type: 'pdf-ai:file-chunk',
        documentToken,
        sessionId: command.sessionId,
        documentId: command.documentId,
        inputId: command.inputId,
        offset,
        limit: 256 * 1024
      });
      if (!reply?.ok || !reply.data || reply.data.documentId !== command.documentId || reply.data.offset !== offset ||
          typeof reply.data.base64 !== 'string') throw new Error(reply?.error || 'document_chunk_failed');
      if (expectedSize === null) expectedSize = reply.data.size;
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 128 * 1024 * 1024 || reply.data.size !== expectedSize) {
        throw new Error('document_size_mismatch');
      }
      name = typeof reply.data.name === 'string' && reply.data.name ? reply.data.name : name;
      parts.push(decodeBase64(reply.data.base64));
      offset = reply.data.nextOffset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > expectedSize) throw new Error('document_offset_mismatch');
      if (reply.data.done === true) break;
    }
    if (offset !== expectedSize) throw new Error('document_incomplete');
    return new File(parts, name, { type: 'application/pdf' });
  }

  async function uploadDocument(command) {
    const host = composerHost();
    if (!host || attachmentPresent(command.document?.name || '')) return false;
    const inputs = [...host.querySelectorAll('input[type="file"]')].filter(input => {
      if (input.disabled) return false;
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      return !accept || accept.includes('pdf') || accept.includes('application/') || accept.includes('*/*');
    });
    if (inputs.length !== 1) return false;
    const file = await loadDocumentFile(command);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    return Boolean(await waitFor(() => attachmentPresent(file.name) && sendEnabled(sendButton()), 120_000, 200));
  }

  function eventBase(command, kind, conversation = conversationId()) {
    return {
      eventId: crypto.randomUUID(),
      kind,
      sessionId: command.sessionId,
      documentId: command.documentId,
      inputId: command.inputId,
      conversationId: conversation,
      time: Date.now()
    };
  }

  function exactUserFor(command) {
    return messages().find(message => message.role === 'user' && markerOf(message.text)?.sessionId === command.sessionId &&
      markerOf(message.text)?.inputId === command.inputId) || null;
  }

  async function submit(command) {
    const expectedConversation = command.conversationId || null;
    const currentConversation = conversationId();
    if (expectedConversation && currentConversation !== expectedConversation) return { ok: false, error: 'wrong_conversation' };

    const existing = exactUserFor(command);
    if (existing) {
      const conversation = conversationId();
      if (!conversation) return { ok: false, error: 'owned_message_without_conversation' };
      lastPath = location.pathname;
      active = { ...command, conversationId: conversation, userMessageId: existing.id, userTurnId: existing.turnId,
        lastAssistantId: null, lastText: '', lastChangedAt: Date.now(), finalSent: false };
      scheduleScan(0);
      return {
        ok: true,
        conversationId: conversation,
        events: [
          { ...eventBase(command, 'chat_owned', conversation) },
          { ...eventBase(command, 'input_sent', conversation), messageId: existing.id, turnId: existing.turnId,
            requestId: existing.requestId }
        ]
      };
    }

    if (stopButton()) return { ok: false, error: 'chat_is_generating' };
    const box = await waitFor(() => composer(), 30_000, 100);
    if (!box) return { ok: false, error: 'composer_unavailable' };
    if (composerText(box)) return { ok: false, error: 'composer_has_user_draft' };

    const events = [];
    if (command.attachDocument === true) {
      if (!await uploadDocument(command)) return { ok: false, error: 'pdf_upload_failed' };
      events.push({ ...eventBase(command, 'attachment_uploaded', conversationId()) });
    }
    if (!setComposerText(command.prompt)) return { ok: false, error: 'composer_insert_failed' };
    const button = await waitFor(() => sendEnabled(sendButton()) ? sendButton() : null, 30_000, 100);
    if (!button || compactText(composerText()) !== compactText(command.prompt)) return { ok: false, error: 'send_not_ready' };
    try { button.click(); } catch { return { ok: false, error: 'send_click_failed' }; }

    const sent = await waitFor(() => exactUserFor(command), 30_000, 100);
    if (!sent) return { ok: false, error: 'sent_user_message_not_observed' };
    const conversation = await waitFor(() => conversationId(), 15_000, 100);
    if (!conversation || !CHAT_ID.test(conversation)) return { ok: false, error: 'conversation_id_not_observed' };
    if (expectedConversation && conversation !== expectedConversation) return { ok: false, error: 'conversation_changed_during_send' };

    lastPath = location.pathname;
    events.push({ ...eventBase(command, 'chat_owned', conversation) });
    events.push({ ...eventBase(command, 'input_sent', conversation), messageId: sent.id, turnId: sent.turnId,
      requestId: sent.requestId });
    active = { ...command, conversationId: conversation, userMessageId: sent.id, userTurnId: sent.turnId,
      lastAssistantId: null, lastText: '', lastChangedAt: Date.now(), finalSent: false };
    scheduleScan(0);
    return { ok: true, conversationId: conversation, events };
  }

  function assistantAfterActive() {
    if (!active) return null;
    const all = messages();
    const userIndex = all.findIndex(message => message.role === 'user' && message.id === active.userMessageId);
    if (userIndex < 0) return null;
    const after = all.slice(userIndex + 1).filter(message => message.role === 'assistant' && message.text);
    return after.length ? after[after.length - 1] : null;
  }

  async function emitAssistant(message, final) {
    if (!active || active.finalSent) return;
    const event = {
      ...eventBase(active, 'assistant_message', active.conversationId),
      messageId: message.id,
      turnId: message.turnId,
      requestId: message.requestId,
      text: message.text.slice(0, 128_000),
      final
    };
    const reply = await runtimeMessage({
      type: 'pdf-ai:observation',
      documentToken,
      sessionId: active.sessionId,
      event
    });
    if (reply?.ok && final) {
      active.finalSent = true;
      active = null;
    }
  }

  function scanActive() {
    scanTimer = null;
    if (!running || !active) return;
    if (conversationId() !== active.conversationId) return;
    const assistant = assistantAfterActive();
    if (!assistant) return;
    const changed = assistant.id !== active.lastAssistantId || assistant.text !== active.lastText;
    if (changed) {
      active.lastAssistantId = assistant.id;
      active.lastText = assistant.text;
      active.lastChangedAt = Date.now();
      void emitAssistant(assistant, false);
    }
    clearTimeout(finalTimer);
    if (!stopButton()) {
      const wait = Math.max(0, 1500 - (Date.now() - active.lastChangedAt));
      finalTimer = setTimeout(() => {
        if (!active || stopButton() || conversationId() !== active.conversationId) return;
        const current = assistantAfterActive();
        if (!current || current.id !== active.lastAssistantId || current.text !== active.lastText) return scheduleScan(0);
        void emitAssistant(current, true);
      }, wait);
    }
  }

  function scheduleScan(delay = 100) {
    if (!running || !active || scanTimer !== null) return;
    scanTimer = setTimeout(scanActive, delay);
  }

  async function resume(message) {
    if (!message || conversationId() !== message.conversationId) return { ok: false, error: 'wrong_conversation' };
    const command = { sessionId: message.sessionId, documentId: message.documentId, inputId: message.inputId,
      conversationId: message.conversationId };
    const user = exactUserFor(command);
    if (!user) return { ok: false, error: 'ownership_marker_not_found' };
    lastPath = location.pathname;
    active = { ...command, userMessageId: user.id, userTurnId: user.turnId,
      lastAssistantId: null, lastText: '', lastChangedAt: Date.now(), finalSent: false };
    scheduleScan(0);
    return { ok: true };
  }

  function pageReady() {
    if (!running) return;
    void runtimeMessage({
      type: 'pdf-ai:page-ready',
      documentToken,
      conversationId: conversationId(),
      markers: ownershipMarkers()
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!running || !message || typeof message !== 'object') return false;
    let work;
    if (message.type === 'pdf-ai:send') work = submit(message.command);
    else if (message.type === 'pdf-ai:resume') work = resume(message);
    else if (message.type === 'pdf-ai:identify') work = Promise.resolve({
      ok: true, conversationId: conversationId(), markers: ownershipMarkers()
    });
    else return false;
    void Promise.resolve(work).then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
    return true;
  });

  observer = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      active = null;
      pageReady();
    }
    scheduleScan(100);
  });
  if (document.documentElement) observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  });

  const routeTimer = setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      active = null;
      pageReady();
    }
    scheduleScan(0);
  }, 1000);

  const handle = {
    version: VERSION,
    alive: () => running,
    stop: () => {
      running = false;
      observer?.disconnect();
      clearInterval(routeTimer);
      clearTimeout(scanTimer);
      clearTimeout(finalTimer);
      active = null;
    }
  };
  globalThis.__PDF_AI_CONTENT__ = handle;

  if (typeof globalThis.__PDF_AI_CONTENT_TEST_HOOK__ === 'function') {
    globalThis.__PDF_AI_CONTENT_TEST_HOOK__({ conversationId, markerOf, messages, ownershipMarkers, composer, sendButton });
  }

  pageReady();
})();
