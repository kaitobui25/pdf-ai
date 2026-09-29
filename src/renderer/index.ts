import './styles.css';
import { PdfReader } from './pdf-reader.js';

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
      '<div class="empty-state"><div><p>Reader phases are active. ChatGPT automation is intentionally disabled until the later roadmap phases.</p></div></div>' +
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
let searchRequest = 0;
let openRequest = 0;
let pageStateSeq = 0;
let selectionStateSeq = 0;

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

required<HTMLButtonElement>('#search-button').addEventListener('click', () => void runSearch());
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') void runSearch();
});

void window.pdfAi.runtimeInfo().then(info => {
  const runtime = required<HTMLElement>('#runtime-status');
  runtime.textContent = info.bridgeId + ' · MCP ' + info.mcpConnectorName;
});

window.addEventListener('beforeunload', () => reader.destroy(), { once: true });
