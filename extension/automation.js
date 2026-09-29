export const PDF_AI_OWNED_CHATS_KEY = 'pdfAiOwnedChats';
export const PDF_AI_EVENT_OUTBOX_KEY = 'pdfAiEventOutbox';

const CHAT_URL = 'https://chatgpt.com/';
const MAX_EVENT_OUTBOX = 100;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_ABANDONED_INPUTS = 128;
const CONTENT_READY_TIMEOUT_MS = 30_000;

function conversationFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)) return null;
    const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isChatUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function readStorage(area, key) {
  const value = await area.get(key);
  return value && typeof value === 'object' ? value[key] : undefined;
}

async function writeStorage(area, key, value) {
  await area.set({ [key]: value });
}

function validCommand(command) {
  const payload = command?.payload;
  return command && typeof command.id === 'string' && command.type === 'chat_send' &&
    payload && typeof payload === 'object' &&
    typeof payload.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.sessionId) &&
    typeof payload.documentId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(payload.documentId) &&
    typeof payload.inputId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.inputId) &&
    typeof payload.prompt === 'string' && payload.prompt.length > 0 && payload.prompt.length <= 100_000 &&
    (payload.conversationId === null || payload.conversationId === undefined ||
      (typeof payload.conversationId === 'string' && /^[0-9a-f-]{8,64}$/i.test(payload.conversationId)));
}

function eventSize(events) {
  try { return new TextEncoder().encode(JSON.stringify(events)).byteLength; } catch { return Number.POSITIVE_INFINITY; }
}

function eventForFailure(payload, error, now) {
  return {
    eventId: crypto.randomUUID(),
    kind: 'input_failed',
    sessionId: payload.sessionId,
    documentId: payload.documentId,
    inputId: payload.inputId,
    conversationId: payload.conversationId ?? null,
    error: String(error || 'browser_automation_failed').slice(0, 1000),
    time: now()
  };
}

export function createChatAutomation({ chromeApi, bridgeClient, localStorage, now = () => Date.now() }) {
  if (!chromeApi?.tabs || !chromeApi?.runtime) throw new TypeError('Chrome tabs/runtime APIs are required.');
  if (!bridgeClient?.postEvents || !bridgeClient?.getDocumentChunk) throw new TypeError('Bridge event/file APIs are required.');
  if (!localStorage?.get || !localStorage?.set) throw new TypeError('localStorage is required.');

  let loaded = false;
  let loading = null;
  let owned = {};
  let eventOutbox = [];
  let writeQueue = Promise.resolve();
  let drainFlight = null;

  function load() {
    if (loaded) return Promise.resolve();
    if (!loading) loading = (async () => {
      const [storedOwned, storedEvents] = await Promise.all([
        readStorage(localStorage, PDF_AI_OWNED_CHATS_KEY),
        readStorage(localStorage, PDF_AI_EVENT_OUTBOX_KEY)
      ]);
      owned = storedOwned && typeof storedOwned === 'object' && !Array.isArray(storedOwned)
        ? { ...storedOwned }
        : {};
      eventOutbox = Array.isArray(storedEvents) ? storedEvents.slice(-MAX_EVENT_OUTBOX) : [];
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }

  function persist() {
    const snapshotOwned = structuredClone(owned);
    const snapshotEvents = structuredClone(eventOutbox);
    const write = writeQueue.then(() => Promise.all([
      writeStorage(localStorage, PDF_AI_OWNED_CHATS_KEY, snapshotOwned),
      writeStorage(localStorage, PDF_AI_EVENT_OUTBOX_KEY, snapshotEvents)
    ]));
    writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async function queueEvents(events) {
    await load();
    if (!Array.isArray(events) || !events.length) return;
    const next = [...eventOutbox];
    for (const event of events) {
      if (!event || typeof event !== 'object' || typeof event.eventId !== 'string') continue;
      if (next.some(row => row.eventId === event.eventId)) continue;
      next.push(structuredClone(event));
    }
    while (next.length > MAX_EVENT_OUTBOX || eventSize(next) > MAX_EVENT_BYTES) next.shift();
    eventOutbox = next;
    await persist();
  }

  async function drainEvents() {
    await load();
    if (drainFlight) return drainFlight;
    drainFlight = (async () => {
      while (eventOutbox.length) {
        const batch = eventOutbox.slice(0, 20);
        const result = await bridgeClient.postEvents(batch);
        if (!result?.ok) return { ok: false, pending: eventOutbox.length, error: result?.error || 'event_delivery_failed' };
        const receipts = Array.isArray(result.data?.receipts) ? result.data.receipts : [];
        if (!receipts.length) return { ok: false, pending: eventOutbox.length, error: 'missing_event_receipts' };
        const terminal = new Set(receipts.filter(row => row && (row.status === 'ok' || row.status === 'failed'))
          .map(row => row.eventId));
        if (!terminal.size) return { ok: false, pending: eventOutbox.length, error: 'invalid_event_receipts' };
        for (const receipt of receipts) {
          if (receipt?.status !== 'ok') continue;
          const delivered = batch.find(event => event.eventId === receipt.eventId);
          if (delivered?.kind === 'assistant_message' && delivered.final === true) {
            const binding = owned[delivered.sessionId];
            if (binding?.pendingInputId === delivered.inputId) {
              binding.pendingInputId = null;
              binding.commandId = null;
              binding.authorizedInputId = null;
              binding.updatedAt = now();
            }
          }
        }
        eventOutbox = eventOutbox.filter(event => !terminal.has(event.eventId));
        await persist();
      }
      return { ok: true, pending: 0 };
    })().finally(() => { drainFlight = null; });
    return drainFlight;
  }

  async function tabById(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try {
      const tab = await chromeApi.tabs.get(tabId);
      return tab && isChatUrl(tab.url) ? tab : null;
    } catch {
      return null;
    }
  }

  async function matchingConversationTab(conversationId) {
    if (!conversationId) return null;
    const tabs = await chromeApi.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    const matches = tabs.filter(tab => conversationFromUrl(tab.url) === conversationId);
    return matches.length === 1 ? matches[0] : null;
  }

  async function ensureTab(binding) {
    let tab = await tabById(binding.tabId);
    if (tab) {
      const actual = conversationFromUrl(tab.url);
      if (binding.conversationId ? actual === binding.conversationId : actual === null) return tab;
    }
    if (binding.conversationId) tab = await matchingConversationTab(binding.conversationId);
    if (!tab) {
      tab = await chromeApi.tabs.create({
        url: binding.conversationId ? `${CHAT_URL}c/${binding.conversationId}` : CHAT_URL,
        active: false
      });
    }
    if (!Number.isInteger(tab?.id)) throw new Error('chat_tab_unavailable');
    if (binding.tabId !== tab.id) {
      binding.tabDocumentId = null;
      binding.documentToken = null;
    }
    binding.tabId = tab.id;
    binding.updatedAt = now();
    await persist();
    return tab;
  }

  async function abandonPending(binding, inputId) {
    if (binding.pendingInputId !== inputId) return;
    const abandonedInputIds = Array.isArray(binding.abandonedInputIds)
      ? binding.abandonedInputIds.filter(id => typeof id === 'string')
      : [];
    if (!abandonedInputIds.includes(inputId)) abandonedInputIds.push(inputId);
    binding.abandonedInputIds = abandonedInputIds.slice(-MAX_ABANDONED_INPUTS);
    binding.pendingInputId = null;
    binding.commandId = null;
    binding.authorizedInputId = null;
    binding.tabDocumentId = null;
    binding.documentToken = null;
    binding.tabId = null;
    binding.updatedAt = now();
    await queueEvents([{
      eventId: crypto.randomUUID(),
      kind: 'input_abandoned',
      sessionId: binding.sessionId,
      documentId: binding.documentId,
      inputId,
      conversationId: binding.conversationId ?? null,
      error: 'The ChatGPT tab was closed while this input was still pending.',
      time: now()
    }]);
    void drainEvents();
  }

  async function handleTabRemoved(tabId) {
    await load();
    for (const binding of Object.values(owned)) {
      if (binding.tabId !== tabId) continue;
      if (binding.pendingInputId) {
        await abandonPending(binding, binding.pendingInputId);
      } else {
        binding.tabId = null;
        binding.tabDocumentId = null;
        binding.documentToken = null;
        binding.updatedAt = now();
        await persist();
      }
    }
  }

  async function waitForRegisteredDocument(binding, tabId, timeoutMs = CONTENT_READY_TIMEOUT_MS) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (binding.tabId === tabId && typeof binding.tabDocumentId === 'string' && binding.tabDocumentId &&
          typeof binding.documentToken === 'string' && binding.documentToken) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function sendToContent(tabId, message, timeoutMs = CONTENT_READY_TIMEOUT_MS) {
    const deadline = now() + timeoutMs;
    let lastError = 'content_script_unavailable';
    while (now() < deadline) {
      try {
        const reply = await chromeApi.tabs.sendMessage(tabId, message);
        if (reply) return reply;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(lastError);
  }

  async function failCommand(payload, reason) {
    const binding = owned[payload.sessionId];
    const authorized = binding?.authorizedInputId === payload.inputId;
    // A proven pre-Send failure is terminal for this input. Release only the
    // exact pending claim, while keeping the tab/conversation binding reusable.
    // Once Send was authorized, retain custody and report uncertainty instead.
    if (!authorized && binding?.pendingInputId === payload.inputId) {
      binding.pendingInputId = null;
      binding.commandId = null;
      binding.authorizedInputId = null;
      binding.updatedAt = now();
    }
    const event = authorized
      ? {
          eventId: crypto.randomUUID(),
          kind: 'send_uncertain',
          sessionId: payload.sessionId,
          documentId: payload.documentId,
          inputId: payload.inputId,
          conversationId: binding.conversationId ?? payload.conversationId ?? null,
          error: String(reason || 'send_state_uncertain').slice(0, 1000),
          time: now()
        }
      : eventForFailure(payload, reason, now);
    await queueEvents([event]);
    void drainEvents();
    return authorized
      ? { status: 'ok', error: 'send_state_uncertain' }
      : { status: 'failed', error: String(reason || 'browser_automation_failed').slice(0, 1000) };
  }

  async function processCommand(command) {
    await load();
    if (!validCommand(command)) return { status: 'failed', error: 'invalid_chat_send_command' };
    const payload = command.payload;
    let binding = owned[payload.sessionId];
    if (binding && binding.documentId !== payload.documentId) return failCommand(payload, 'session_document_mismatch');
    if (binding?.conversationId && payload.conversationId && binding.conversationId !== payload.conversationId) {
      return failCommand(payload, 'conversation_ownership_mismatch');
    }
    if (Array.isArray(binding?.abandonedInputIds) && binding.abandonedInputIds.includes(payload.inputId)) {
      return { status: 'failed', error: 'input_abandoned' };
    }
    if (binding?.pendingInputId && binding.pendingInputId !== payload.inputId) {
      // The app will not issue a second input while its durable session still has
      // a pending one. Therefore a newer command is authoritative proof that an
      // old un-authorized browser claim is stale (including claims persisted by
      // older extension versions after a pre-Send failure). An authorized claim
      // remains ambiguous and must keep blocking automatic replacement.
      if (binding.authorizedInputId === binding.pendingInputId) {
        return failCommand(payload, 'owned_chat_busy');
      }
      binding.pendingInputId = null;
      binding.commandId = null;
      binding.authorizedInputId = null;
      binding.updatedAt = now();
    }
    if (!binding) {
      binding = {
        sessionId: payload.sessionId,
        documentId: payload.documentId,
        conversationId: payload.conversationId ?? null,
        tabId: null,
        pendingInputId: payload.inputId,
        authorizedInputId: null,
        commandId: command.id,
        updatedAt: now()
      };
      owned[payload.sessionId] = binding;
    } else {
      binding.pendingInputId = payload.inputId;
      binding.commandId = command.id;
      if (!binding.conversationId && payload.conversationId) binding.conversationId = payload.conversationId;
      binding.updatedAt = now();
    }
    await persist();

    if (binding.authorizedInputId === payload.inputId) {
      if (binding.conversationId && Number.isInteger(binding.tabId)) {
        void sendToContent(binding.tabId, {
          type: 'pdf-ai:resume',
          sessionId: binding.sessionId,
          documentId: binding.documentId,
          inputId: binding.pendingInputId,
          conversationId: binding.conversationId
        }, 5_000).catch(() => undefined);
      }
      return { status: 'ok', error: 'send_already_authorized' };
    }

    try {
      const tab = await ensureTab(binding);
      if (payload.attachDocument === true && !await waitForRegisteredDocument(binding, tab.id)) {
        return failCommand(payload, 'chat_document_not_registered');
      }
      const reply = await sendToContent(tab.id, {
        type: 'pdf-ai:send',
        command: { id: command.id, ...payload }
      });
      if (reply?.ok !== true || !Array.isArray(reply.events)) {
        return failCommand(payload, reply?.error || 'content_send_failed');
      }
      const conversationId = reply.conversationId ?? null;
      if (!conversationId || !/^[0-9a-f-]{8,64}$/i.test(conversationId)) {
        return failCommand(payload, 'conversation_not_established');
      }
      if (binding.conversationId && binding.conversationId !== conversationId) {
        return failCommand(payload, 'conversation_changed_during_send');
      }
      binding.conversationId = conversationId;
      binding.tabId = tab.id;
      binding.updatedAt = now();
      await queueEvents(reply.events);
      await persist();
      void drainEvents();
      return { status: 'ok' };
    } catch (error) {
      return failCommand(payload, error instanceof Error ? error.message : String(error));
    }
  }

  function bindingForSender(sender, message) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || sender?.frameId !== 0 || typeof sender?.documentId !== 'string' || !sender.documentId) return null;
    const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : null;
    const exact = binding => binding.tabId === tabId && binding.tabDocumentId === sender.documentId &&
      typeof message?.documentToken === 'string' && message.documentToken === binding.documentToken;
    if (sessionId && owned[sessionId] && exact(owned[sessionId])) return owned[sessionId];
    const matches = Object.values(owned).filter(exact);
    return matches.length === 1 ? matches[0] : null;
  }

  async function handlePageReady(message, sender) {
    await load();
    if (!Number.isInteger(sender?.tab?.id) || sender?.frameId !== 0 || typeof sender?.documentId !== 'string' ||
        !sender.documentId || typeof message?.documentToken !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.documentToken)) {
      return { ok: false, error: 'untrusted_document' };
    }
    const senderUrl = typeof sender.url === 'string' ? sender.url : sender.tab.url;
    if (!isChatUrl(senderUrl)) return { ok: false, error: 'untrusted_tab' };
    const conversationId = conversationFromUrl(senderUrl);
    if ((message.conversationId ?? null) !== conversationId) return { ok: false, error: 'route_identity_mismatch' };
    const markers = Array.isArray(message.markers) ? message.markers.slice(0, 20) : [];
    let candidates = Object.values(owned).filter(binding => binding.tabId === sender.tab.id);
    if (!candidates.length && conversationId) {
      candidates = Object.values(owned).filter(binding => binding.conversationId === conversationId);
    }
    if (!candidates.length) {
      const markerSessions = new Set(markers.map(marker => marker?.sessionId).filter(Boolean));
      candidates = Object.values(owned).filter(binding => markerSessions.has(binding.sessionId));
    }
    if (candidates.length !== 1) return { ok: false, owned: false };
    const binding = candidates[0];
    if (binding.conversationId && conversationId && binding.conversationId !== conversationId) {
      return { ok: false, owned: false, error: 'conversation_ownership_mismatch' };
    }
    if (!binding.conversationId && conversationId) binding.conversationId = conversationId;
    binding.tabId = sender.tab.id;
    binding.tabDocumentId = sender.documentId;
    binding.documentToken = message.documentToken;
    binding.updatedAt = now();
    await persist();
    if (binding.pendingInputId && binding.conversationId) {
      void sendToContent(sender.tab.id, {
        type: 'pdf-ai:resume',
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        inputId: binding.pendingInputId,
        conversationId: binding.conversationId
      }, 5_000).catch(() => undefined);
    }
    return { ok: true, owned: true, sessionId: binding.sessionId, documentId: binding.documentId };
  }

  async function handleRuntimeMessage(message, sender) {
    await load();
    if (!message || typeof message !== 'object') return null;
    if (message.type === 'pdf-ai:page-ready') return handlePageReady(message, sender);

    const binding = bindingForSender(sender, message);
    if (!binding || !isChatUrl(sender?.tab?.url)) return { ok: false, error: 'unowned_chat_tab' };
    if (message.type === 'pdf-ai:file-chunk') {
      if (message.documentId !== binding.documentId || message.inputId !== binding.pendingInputId) {
        return { ok: false, error: 'file_request_ownership_mismatch' };
      }
      return bridgeClient.getDocumentChunk(message.documentId, message.offset, message.limit);
    }
    if (message.type === 'pdf-ai:authorize-send') {
      if (message.inputId !== binding.pendingInputId || message.documentId !== binding.documentId ||
          message.sessionId !== binding.sessionId) {
        return { ok: false, error: 'send_authorization_ownership_mismatch' };
      }
      const routeConversation = conversationFromUrl(typeof sender.url === 'string' ? sender.url : sender.tab.url);
      const requestedConversation = message.conversationId ?? null;
      if (requestedConversation !== routeConversation) return { ok: false, error: 'send_authorization_route_mismatch' };
      if (binding.conversationId && requestedConversation && binding.conversationId !== requestedConversation) {
        return { ok: false, error: 'send_authorization_conversation_mismatch' };
      }
      if (binding.authorizedInputId && binding.authorizedInputId !== message.inputId) {
        return { ok: false, error: 'another_input_already_authorized' };
      }
      binding.authorizedInputId = message.inputId;
      binding.updatedAt = now();
      await queueEvents([{
        eventId: crypto.randomUUID(),
        kind: 'send_authorized',
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        inputId: binding.pendingInputId,
        conversationId: requestedConversation,
        time: now()
      }]);
      await persist();
      void drainEvents();
      return { ok: true };
    }
    if (message.type === 'pdf-ai:observation') {
      const event = message.event;
      if (!event || event.sessionId !== binding.sessionId || event.documentId !== binding.documentId ||
          event.inputId !== binding.pendingInputId) {
        return { ok: false, error: 'observation_ownership_mismatch' };
      }
      if (binding.conversationId && event.conversationId !== binding.conversationId) {
        return { ok: false, error: 'observation_conversation_mismatch' };
      }
      await queueEvents([event]);
      const delivered = await drainEvents();
      return { ok: true, delivered };
    }
    return null;
  }

  async function restoreOwnedChats() {
    await load();
    const pending = Object.values(owned).filter(binding => binding.pendingInputId && binding.conversationId);
    for (const binding of pending) {
      const inputId = binding.pendingInputId;
      try {
        let tab = await tabById(binding.tabId);
        if (!tab || conversationFromUrl(tab.url) !== binding.conversationId) {
          tab = await matchingConversationTab(binding.conversationId);
        }
        if (binding.pendingInputId !== inputId) continue;
        if (!tab) {
          await abandonPending(binding, inputId);
          continue;
        }
        if (binding.tabId !== tab.id) {
          binding.tabId = tab.id;
          binding.tabDocumentId = null;
          binding.documentToken = null;
          binding.updatedAt = now();
          await persist();
        }
        await sendToContent(tab.id, {
          type: 'pdf-ai:resume',
          sessionId: binding.sessionId,
          documentId: binding.documentId,
          inputId,
          conversationId: binding.conversationId
        }, 10_000);
      } catch {
        // Existing tabs may become ready later; maintenance can resume them without creating a replacement.
      }
    }
    void drainEvents();
  }

  async function cancelCommand(command) {
    await load();
    const payload = command?.payload;
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.documentId !== 'string' ||
        typeof payload.inputId !== 'string') return { status: 'failed', error: 'invalid_chat_cancel_command' };
    const binding = owned[payload.sessionId];
    if (!binding || binding.documentId !== payload.documentId || binding.pendingInputId !== payload.inputId) {
      return { status: 'failed', error: 'cancel_ownership_mismatch' };
    }
    if (binding.authorizedInputId === payload.inputId) {
      return { status: 'failed', error: 'send_already_authorized' };
    }
    const cancelled = {
      eventId: crypto.randomUUID(),
      kind: 'input_cancelled',
      sessionId: binding.sessionId,
      documentId: binding.documentId,
      inputId: binding.pendingInputId,
      conversationId: binding.conversationId ?? null,
      time: now()
    };
    binding.pendingInputId = null;
    binding.commandId = null;
    binding.updatedAt = now();
    await queueEvents([cancelled]);
    await persist();
    void drainEvents();
    return { status: 'ok' };
  }

  async function status() {
    await load();
    const bindings = Object.values(owned);
    return {
      ownedChats: bindings.length,
      activeInputs: bindings.filter(binding => binding.pendingInputId).length,
      pendingEvents: eventOutbox.length
    };
  }

  chromeApi.tabs.onRemoved?.addListener(tabId => handleTabRemoved(tabId));

  return {
    cancelCommand,
    drainEvents,
    handleTabRemoved,
    handleRuntimeMessage,
    processCommand,
    restoreOwnedChats,
    status
  };
}

export { conversationFromUrl };
