import './styles.css';
import type { TunnelConnectionStatus } from '../shared/tunnel.js';
import type { BrowserBridgeStatus } from '../shared/api.js';
import type { ChatSessionSnapshot } from '../shared/chat.js';
import { PdfReader } from './pdf-reader.js';
import { canNavigateChatReference, chatStatusView, shouldApplyChatResult } from './chat-ui.js';
import { tunnelViewState } from './tunnel-ui.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');

root.innerHTML =
  '<div class="shell">' +
    '<section class="pdf-pane">' +
      '<header class="reader-toolbar">' +
        '<button id="open-pdf" type="button" class="primary">Open PDF</button>' +
        '<span class="divider"></span>' +
        '<button id="previous-page" type="button" title="Previous page">‹</button>' +
        '<input id="page-number" class="page-number" inputmode="numeric" value="1" aria-label="Page number">' +
        '<span id="page-count" class="page-count">/ 0</span>' +
        '<button id="next-page" type="button" title="Next page">›</button>' +
        '<span class="divider"></span>' +
        '<button id="zoom-out" type="button" title="Zoom out">−</button>' +
        '<button id="fit-width" type="button">Fit width</button>' +
        '<button id="zoom-in" type="button" title="Zoom in">+</button>' +
        '<span class="toolbar-spacer"></span>' +
        '<input id="pdf-search" class="search-input" type="search" placeholder="Search PDF" aria-label="Search PDF">' +
        '<button id="search-button" type="button">Search</button>' +
      '</header>' +
      '<div class="reader-body">' +
        '<aside class="reader-sidebar">' +
          '<div class="sidebar-tabs">' +
            '<button type="button" data-sidebar="outline" class="is-active">Outline</button>' +
            '<button type="button" data-sidebar="thumbnails">Pages</button>' +
            '<button type="button" data-sidebar="search">Search</button>' +
          '</div>' +
          '<div id="outline-panel" class="sidebar-panel"></div>' +
          '<div id="thumbnail-panel" class="sidebar-panel" hidden></div>' +
          '<div id="search-panel" class="sidebar-panel" hidden><p class="sidebar-empty">Search results appear here.</p></div>' +
        '</aside>' +
        '<div id="pdf-viewport" class="pdf-viewport">' +
          '<div id="reader-empty" class="reader-empty"><div><h1>PDF-AI</h1><p>Open a local PDF to start reading.</p></div></div>' +
          '<div id="pdf-pages" class="pdf-pages"></div>' +
        '</div>' +
      '</div>' +
      '<footer class="reader-statusbar">' +
        '<span id="reader-status">Ready</span>' +
        '<span id="selection-status">No selection</span>' +
      '</footer>' +
    '</section>' +
    '<aside class="chat-pane">' +
      '<header class="pane-header"><strong>AI Chat</strong><span id="runtime-status">Starting…</span></header>' +
      '<div class="chat-content">' +
        '<section class="connection-card" aria-labelledby="connection-title">' +
          '<div class="connection-heading">' +
            '<div><strong id="connection-title">PDF AI connection</strong><p>OpenAI Secure MCP Tunnel</p></div>' +
            '<button id="tunnel-settings-toggle" class="connection-settings-toggle" type="button" aria-expanded="false" aria-controls="tunnel-settings">Show settings</button>' +
          '</div>' +
          '<span id="tunnel-state" class="connection-state" data-state="disconnected">Not connected</span>' +
          '<div id="tunnel-settings" class="tunnel-settings" hidden>' +
            '<label class="connection-field"><span>Tunnel ID</span><input id="tunnel-id" type="text" autocomplete="off" spellcheck="false" placeholder="tunnel_…"></label>' +
            '<label class="connection-field"><span>Restricted API key</span><input id="tunnel-key" type="password" autocomplete="off" spellcheck="false" placeholder="Enter key"></label>' +
            '<p id="credential-hint" class="connection-hint">The key never leaves the Electron main process except as tunnel-client environment data.</p>' +
            '<div class="connection-actions">' +
              '<button id="tunnel-connect" type="button" class="primary">Connect</button>' +
              '<button id="tunnel-disconnect" type="button" hidden>Disconnect</button>' +
            '</div>' +
          '</div>' +
          '<p id="tunnel-detail" class="connection-detail">Loading connection state…</p>' +
          '<p id="tunnel-runtime" class="connection-diagnostic"></p>' +
        '</section>' +
        '<section class="chat-workspace" aria-labelledby="chat-session-title">' +
          '<div class="chat-session-heading">' +
            '<div><strong id="chat-session-title">Document chat</strong><p id="chat-session-meta">Open a PDF to start a session.</p></div>' +
            '<span id="chat-state" class="chat-state" data-state="idle">No session</span>' +
          '</div>' +
          '<p id="browser-extension-status" class="chat-bridge-status">Browser extension: checking…</p>' +
          '<div id="chat-timeline" class="chat-timeline" aria-live="polite">' +
            '<p class="chat-empty">Open a PDF, then ask ChatGPT about that document.</p>' +
          '</div>' +
          '<div class="chat-composer">' +
            '<textarea id="chat-input" rows="3" maxlength="20000" placeholder="Ask about this PDF…"></textarea>' +
            '<div class="chat-composer-options">' +
              '<span id="chat-progress">Ready</span>' +
            '</div>' +
            '<div class="chat-composer-actions">' +
              '<button id="chat-cancel" type="button" hidden>Cancel pending</button>' +
              '<button id="chat-send" type="button" class="primary">Send</button>' +
            '</div>' +
            '<p id="chat-error" class="chat-error" hidden></p>' +
          '</div>' +
        '</section>' +
      '</div>' +
    '</aside>' +
  '</div>';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing element ' + selector);
  return element;
}

const viewport = required<HTMLElement>('#pdf-viewport');
const pages = required<HTMLElement>('#pdf-pages');
const outline = required<HTMLElement>('#outline-panel');
const thumbnails = required<HTMLElement>('#thumbnail-panel');
const searchPanel = required<HTMLElement>('#search-panel');
const pageInput = required<HTMLInputElement>('#page-number');
const pageCount = required<HTMLElement>('#page-count');
const status = required<HTMLElement>('#reader-status');
const selectionStatus = required<HTMLElement>('#selection-status');
const empty = required<HTMLElement>('#reader-empty');
const searchInput = required<HTMLInputElement>('#pdf-search');
const tunnelIdInput = required<HTMLInputElement>('#tunnel-id');
const tunnelKeyInput = required<HTMLInputElement>('#tunnel-key');
const tunnelSettings = required<HTMLElement>('#tunnel-settings');
const tunnelSettingsToggle = required<HTMLButtonElement>('#tunnel-settings-toggle');
const tunnelConnectButton = required<HTMLButtonElement>('#tunnel-connect');
const tunnelDisconnectButton = required<HTMLButtonElement>('#tunnel-disconnect');
const tunnelState = required<HTMLElement>('#tunnel-state');
const tunnelDetail = required<HTMLElement>('#tunnel-detail');
const tunnelRuntime = required<HTMLElement>('#tunnel-runtime');
const credentialHint = required<HTMLElement>('#credential-hint');
const chatState = required<HTMLElement>('#chat-state');
const chatSessionMeta = required<HTMLElement>('#chat-session-meta');
const chatTimeline = required<HTMLElement>('#chat-timeline');
const chatInput = required<HTMLTextAreaElement>('#chat-input');
const chatSendButton = required<HTMLButtonElement>('#chat-send');
const chatCancelButton = required<HTMLButtonElement>('#chat-cancel');
const chatProgress = required<HTMLElement>('#chat-progress');
const chatError = required<HTMLElement>('#chat-error');
const browserExtensionStatus = required<HTMLElement>('#browser-extension-status');
let searchRequest = 0;
let openRequest = 0;
let pageStateSeq = 0;
let selectionStateSeq = 0;
let tunnelSetupInitialized = false;
let tunnelActionBusy = false;
let tunnelPollBusy = false;
let chatDocumentId: string | null = null;
let chatGeneration = 0;
let chatPollRequest = 0;
let chatActionBusy = false;
let currentChatSession: ChatSessionSnapshot | null = null;
let renderedChatKey = '';
let chatRecoveryNotice: string | null = null;
let browserBridgePollBusy = false;
let browserBridgeState: BrowserBridgeStatus | null = null;

const reader = new PdfReader(
  { viewport, pages, outline, thumbnails },
  {
    onDocumentChanged: (opened, count) => {
      searchRequest++;
      pageStateSeq = 0;
      selectionStateSeq = 0;
      pageCount.textContent = '/ ' + count;
      pageInput.value = count ? '1' : '0';
      empty.hidden = opened !== null;
      document.title = opened ? opened.name + ' — PDF-AI' : 'PDF-AI';
      searchPanel.innerHTML = '<p class="sidebar-empty">Search results appear here.</p>';
      chatDocumentId = opened?.documentId ?? null;
      chatGeneration++;
      currentChatSession = null;
      renderedChatKey = '';
      renderChatSession(null);
      void refreshChatSession();
    },
    onPageChanged: (page, count) => {
      pageInput.value = String(page);
      pageCount.textContent = '/ ' + count;
      const documentId = reader.documentId;
      const viewEpoch = reader.viewEpoch;
      if (documentId && viewEpoch !== null) {
        const seq = ++pageStateSeq;
        void window.pdfAi.setCurrentPage(documentId, viewEpoch, seq, page).catch(error => {
          status.textContent = error instanceof Error ? error.message : 'Could not update current page.';
          status.classList.add('is-error');
        });
      }
    },
    onSelectionChanged: selection => {
      const documentId = reader.documentId;
      const viewEpoch = reader.viewEpoch;
      if (documentId && viewEpoch !== null) {
        const seq = ++selectionStateSeq;
        void window.pdfAi.setSelection(documentId, viewEpoch, seq, selection).catch(error => {
          status.textContent = error instanceof Error ? error.message : 'Could not update selection.';
          status.classList.add('is-error');
        });
      }
      if (!selection) {
        selectionStatus.textContent = 'No selection';
        return;
      }
      const clipped = selection.text.length > 80 ? selection.text.slice(0, 77) + '…' : selection.text;
      const pages = selection.startPage === selection.endPage
        ? 'p.' + selection.startPage
        : 'pp.' + selection.startPage + '–' + selection.endPage;
      selectionStatus.textContent = pages + ' · ' + clipped;
    },
    onStatus: (message, error) => {
      status.textContent = message;
      status.classList.toggle('is-error', error === true);
    }
  }
);

const showSidebar = (name: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sidebar]')) {
    button.classList.toggle('is-active', button.dataset.sidebar === name);
  }
  outline.hidden = name !== 'outline';
  thumbnails.hidden = name !== 'thumbnails';
  searchPanel.hidden = name !== 'search';
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sidebar]')) {
  button.addEventListener('click', () => showSidebar(button.dataset.sidebar ?? 'outline'));
}

required<HTMLButtonElement>('#open-pdf').addEventListener('click', async () => {
  const request = ++openRequest;
  status.textContent = 'Choose a PDF…';
  const result = await window.pdfAi.openPdf();
  if (request !== openRequest) return;
  if (!result.ok) {
    if (result.error.code !== 'cancelled') {
      status.textContent = result.error.message;
      status.classList.add('is-error');
    } else {
      status.textContent = 'Ready';
    }
    return;
  }
  try {
    await reader.open(result.document);
    if (request !== openRequest) return;
  } catch {
    if (request !== openRequest) return;
    empty.hidden = false;
  }
});

required<HTMLButtonElement>('#previous-page').addEventListener('click', () => reader.previousPage());
required<HTMLButtonElement>('#next-page').addEventListener('click', () => reader.nextPage());
required<HTMLButtonElement>('#zoom-out').addEventListener('click', () => reader.zoomOut());
required<HTMLButtonElement>('#zoom-in').addEventListener('click', () => reader.zoomIn());
required<HTMLButtonElement>('#fit-width').addEventListener('click', () => reader.fitToWidth());

const goToTypedPage = (): void => {
  const value = Number.parseInt(pageInput.value, 10);
  if (Number.isInteger(value)) reader.goToPage(value);
};
pageInput.addEventListener('change', goToTypedPage);
pageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    goToTypedPage();
    pageInput.blur();
  }
});

const runSearch = async (): Promise<void> => {
  const request = ++searchRequest;
  const documentId = reader.documentId;
  const query = searchInput.value.trim();
  showSidebar('search');
  if (!query) {
    searchPanel.innerHTML = '<p class="sidebar-empty">Enter text to search.</p>';
    return;
  }
  searchPanel.innerHTML = '<p class="sidebar-empty">Searching…</p>';
  let hits;
  try {
    hits = await reader.search(query);
  } catch (error) {
    if (request !== searchRequest || reader.documentId !== documentId) return;
    searchPanel.innerHTML = '<p class="sidebar-empty">Search failed.</p>';
    status.textContent = error instanceof Error ? error.message : 'Search failed.';
    status.classList.add('is-error');
    return;
  }
  if (request !== searchRequest || reader.documentId !== documentId) return;
  searchPanel.replaceChildren();
  if (!hits.length) {
    searchPanel.innerHTML = '<p class="sidebar-empty">No matches.</p>';
    return;
  }
  const header = document.createElement('p');
  header.className = 'search-summary';
  header.textContent = hits.length + (hits.length === 200 ? '+ matches' : ' matches');
  searchPanel.append(header);
  for (const hit of hits) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    const page = document.createElement('strong');
    page.textContent = 'Page ' + hit.page;
    const snippet = document.createElement('span');
    snippet.textContent = hit.snippet;
    button.append(page, snippet);
    button.addEventListener('click', () => reader.goToPage(hit.page));
    searchPanel.append(button);
  }
};

const chatSessionKey = (session: ChatSessionSnapshot | null): string => session
  ? `${session.sessionId}:${session.updatedAt}:${session.state}:${session.pendingState ?? ''}:${session.nextSeq}`
  : `none:${chatDocumentId ?? ''}:${chatGeneration}`;

const renderChatSession = (session: ChatSessionSnapshot | null): void => {
  const view = chatStatusView(session);
  chatState.textContent = chatDocumentId ? view.label : 'No session';
  chatState.dataset.state = session?.state ?? 'idle';
  chatSessionMeta.textContent = !chatDocumentId
    ? 'Open a PDF to start a session.'
    : session
      ? `Session ${session.sessionId.slice(0, 8)} · ${session.conversationId ? `Chat ${session.conversationId.slice(0, 8)}` : 'new ChatGPT conversation'}`
      : 'No messages yet for this PDF.';
  chatProgress.textContent = session?.state === 'uncertain'
    ? 'Delivery is uncertain. PDF-AI will not resend automatically.'
    : browserBridgeState?.active === false
      ? 'Browser extension not connected.'
      : view.busy ? view.label + '…' : 'Ready';
  const bridgeError = browserBridgeState?.active === false
    ? browserBridgeState.paired
      ? 'PDF-AI browser extension is paired but not active. Reload the PDF-AI Bridge extension in Chrome.'
      : 'PDF-AI browser extension is not connected. Load the unpacked PDF-AI Bridge extension in Chrome.'
    : null;
  const visibleError = session?.error ?? chatRecoveryNotice ?? bridgeError;
  chatError.hidden = !visibleError;
  chatError.textContent = visibleError ?? '';

  const hasDocument = chatDocumentId !== null;
  const sendBlocked = !hasDocument || view.busy || chatActionBusy || browserBridgeState?.active !== true;
  chatSendButton.disabled = sendBlocked;
  chatInput.disabled = !hasDocument || chatActionBusy;
  chatCancelButton.hidden = !view.cancellable;
  chatCancelButton.disabled = chatActionBusy || !view.cancellable;

  const key = chatSessionKey(session);
  if (key === renderedChatKey) return;
  renderedChatKey = key;
  const nearBottom = chatTimeline.scrollHeight - chatTimeline.scrollTop - chatTimeline.clientHeight < 56;
  chatTimeline.replaceChildren();
  if (!session?.messages.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'chat-empty';
    emptyMessage.textContent = hasDocument
      ? 'Ask ChatGPT about this document.'
      : 'Open a PDF, then ask ChatGPT about that document.';
    chatTimeline.append(emptyMessage);
    return;
  }
  const messages = [...session.messages].sort((a, b) => a.originSeq - b.originSeq);
  for (const message of messages) {
    const article = document.createElement('article');
    article.className = `chat-message is-${message.role}`;
    article.dataset.messageId = message.id;
    const heading = document.createElement('div');
    heading.className = 'chat-message-heading';
    const role = document.createElement('strong');
    role.textContent = message.role === 'user' ? 'You' : 'Assistant';
    const stateLabel = document.createElement('span');
    stateLabel.textContent = message.role === 'assistant' && !message.final ? 'Responding…' : '';
    heading.append(role, stateLabel);
    const body = document.createElement('p');
    body.textContent = message.text;
    article.append(heading, body);
    if (message.pageReferences.length) {
      const references = document.createElement('div');
      references.className = 'chat-page-references';
      for (const reference of message.pageReferences) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Page ${reference.page}`;
        button.title = reference.reference;
        button.disabled = !canNavigateChatReference(reference, reader.documentId, reader.pageCount);
        button.addEventListener('click', () => {
          if (canNavigateChatReference(reference, reader.documentId, reader.pageCount)) {
            reader.goToPage(reference.page);
          }
        });
        references.append(button);
      }
      article.append(references);
    }
    chatTimeline.append(article);
  }
  if (nearBottom) chatTimeline.scrollTop = chatTimeline.scrollHeight;
};

const renderBrowserBridgeStatus = (next: BrowserBridgeStatus): void => {
  browserBridgeState = next;
  browserExtensionStatus.textContent = next.active
    ? `Browser extension connected · bridge ${next.port}`
    : next.paired
      ? 'Browser extension paired but inactive'
      : 'Browser extension not connected';
  browserExtensionStatus.classList.toggle('is-error', !next.active);
  renderChatSession(currentChatSession);
};

const refreshBrowserBridgeStatus = async (): Promise<void> => {
  if (browserBridgePollBusy) return;
  browserBridgePollBusy = true;
  try {
    renderBrowserBridgeStatus(await window.pdfAi.browserBridgeStatus());
  } catch {
    browserExtensionStatus.textContent = 'Browser extension status unavailable';
    browserExtensionStatus.classList.add('is-error');
  } finally {
    browserBridgePollBusy = false;
  }
};

const refreshChatSession = async (): Promise<void> => {
  const documentId = chatDocumentId;
  const generation = chatGeneration;
  const request = ++chatPollRequest;
  if (!documentId) {
    currentChatSession = null;
    renderChatSession(null);
    return;
  }
  try {
    const next = await window.pdfAi.chatSession(documentId);
    if (request !== chatPollRequest || !shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    currentChatSession = next;
    renderChatSession(next);
  } catch (error) {
    if (!shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    chatError.hidden = false;
    chatError.textContent = error instanceof Error ? error.message : 'Could not load the local chat session.';
  }
};

const sendChat = async (): Promise<void> => {
  const documentId = chatDocumentId;
  if (!documentId || chatActionBusy) return;
  const generation = chatGeneration;
  const typed = chatInput.value.trim();
  const text = typed;
  if (!text) {
    chatError.hidden = false;
    chatError.textContent = 'Enter a question first.';
    return;
  }
  chatActionBusy = true;
  chatError.hidden = true;
  renderChatSession(currentChatSession);
  try {
    const next = await window.pdfAi.chatSend({
      documentId,
      text,
      scope: 'document',
      attachDocument: false
    });
    if (!shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    if (typed && chatInput.value.trim() === typed) chatInput.value = '';
    currentChatSession = next;
    renderedChatKey = '';
    renderChatSession(next);
  } catch (error) {
    if (!shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    chatError.hidden = false;
    chatError.textContent = error instanceof Error ? error.message : 'Could not send the question.';
  } finally {
    chatActionBusy = false;
    if (shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) {
      renderChatSession(currentChatSession);
      void refreshChatSession();
    }
  }
};

chatSendButton.addEventListener('click', () => void sendChat());
chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendChat();
  }
});
chatCancelButton.addEventListener('click', async () => {
  const documentId = chatDocumentId;
  if (!documentId || chatActionBusy) return;
  const generation = chatGeneration;
  chatActionBusy = true;
  renderChatSession(currentChatSession);
  try {
    const next = await window.pdfAi.chatCancel(documentId);
    if (!shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    currentChatSession = next;
    renderedChatKey = '';
    renderChatSession(next);
  } catch (error) {
    if (!shouldApplyChatResult(documentId, generation, chatDocumentId, chatGeneration)) return;
    chatError.hidden = false;
    chatError.textContent = error instanceof Error ? error.message : 'Could not cancel the pending input.';
  } finally {
    chatActionBusy = false;
    void refreshChatSession();
  }
});

required<HTMLButtonElement>('#search-button').addEventListener('click', () => void runSearch());
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') void runSearch();
});

const renderTunnelStatus = (next: TunnelConnectionStatus): void => {
  if (!tunnelSetupInitialized) {
    tunnelIdInput.value = next.tunnelId;
    tunnelSetupInitialized = true;
  }
  const view = tunnelViewState(next.state);
  tunnelState.textContent = view.label;
  tunnelState.dataset.state = next.state;
  tunnelDetail.textContent = next.detail;
  tunnelDetail.classList.toggle('is-error', view.error);
  tunnelConnectButton.hidden = view.running;
  tunnelDisconnectButton.hidden = !view.running;
  tunnelConnectButton.disabled = tunnelActionBusy;
  tunnelDisconnectButton.disabled = tunnelActionBusy || next.state === 'disconnecting';
  tunnelIdInput.disabled = view.running || tunnelActionBusy;
  tunnelKeyInput.disabled = view.running || tunnelActionBusy;
  tunnelKeyInput.placeholder = next.hasCredential ? 'Stored securely — leave blank to reuse' : 'Enter restricted API key';
  credentialHint.textContent = next.secureStorageAvailable
    ? 'Credential storage: protected by the operating system. The key is never returned to this page.'
    : (next.secureStorageDetail ?? 'Secure storage unavailable; a newly entered key is kept in memory only.');
  tunnelRuntime.textContent = next.runtimeVersion
    ? `Tunnel runtime ${next.runtimeVersion}${next.retryInMs === null ? '' : ` · retry in ${Math.ceil(next.retryInMs / 1000)}s`}`
    : (next.retryInMs === null ? '' : `Retry in ${Math.ceil(next.retryInMs / 1000)}s`);
};

const refreshTunnelStatus = async (): Promise<void> => {
  if (tunnelPollBusy) return;
  tunnelPollBusy = true;
  try {
    renderTunnelStatus(await window.pdfAi.tunnelStatus());
  } catch (error) {
    tunnelDetail.textContent = error instanceof Error ? error.message : 'Could not read tunnel status.';
    tunnelDetail.classList.add('is-error');
  } finally {
    tunnelPollBusy = false;
  }
};

tunnelConnectButton.addEventListener('click', async () => {
  if (tunnelActionBusy) return;
  tunnelActionBusy = true;
  const submittedKey = tunnelKeyInput.value;
  tunnelConnectButton.disabled = true;
  try {
    const next = await window.pdfAi.tunnelConnect({
      tunnelId: tunnelIdInput.value.trim(),
      ...(submittedKey ? { apiKey: submittedKey } : {})
    });
    if (tunnelKeyInput.value === submittedKey) tunnelKeyInput.value = '';
    renderTunnelStatus(next);
  } catch (error) {
    tunnelDetail.textContent = error instanceof Error ? error.message : 'Could not start the tunnel.';
    tunnelDetail.classList.add('is-error');
  } finally {
    tunnelActionBusy = false;
    void refreshTunnelStatus();
  }
});

tunnelDisconnectButton.addEventListener('click', async () => {
  if (tunnelActionBusy) return;
  tunnelActionBusy = true;
  tunnelDisconnectButton.disabled = true;
  try {
    renderTunnelStatus(await window.pdfAi.tunnelDisconnect());
  } catch (error) {
    tunnelDetail.textContent = error instanceof Error ? error.message : 'Could not disconnect the tunnel.';
    tunnelDetail.classList.add('is-error');
  } finally {
    tunnelActionBusy = false;
    void refreshTunnelStatus();
  }
});

tunnelKeyInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') tunnelConnectButton.click();
});

tunnelSettingsToggle.addEventListener('click', () => {
  const expanded = tunnelSettings.hidden;
  tunnelSettings.hidden = !expanded;
  tunnelSettingsToggle.setAttribute('aria-expanded', String(expanded));
  tunnelSettingsToggle.textContent = expanded ? 'Hide settings' : 'Show settings';
});

void window.pdfAi.runtimeInfo().then(info => {
  const runtime = required<HTMLElement>('#runtime-status');
  runtime.textContent = info.bridgeId + ' · MCP ' + info.mcpConnectorName;
});

void window.pdfAi.chatSystemStatus().then(next => {
  chatRecoveryNotice = next.recoveryNotice;
  renderChatSession(currentChatSession);
}).catch(() => undefined);

void refreshTunnelStatus();
const tunnelPollTimer = window.setInterval(() => void refreshTunnelStatus(), 1_000);
void refreshBrowserBridgeStatus();
const browserBridgePollTimer = window.setInterval(() => void refreshBrowserBridgeStatus(), 1_000);
void refreshChatSession();
const chatPollTimer = window.setInterval(() => void refreshChatSession(), 1_000);

window.addEventListener('beforeunload', () => {
  window.clearInterval(tunnelPollTimer);
  window.clearInterval(browserBridgePollTimer);
  window.clearInterval(chatPollTimer);
  reader.destroy();
}, { once: true });
