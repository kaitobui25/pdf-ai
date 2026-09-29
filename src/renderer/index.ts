import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');

root.innerHTML =
  '<div class="shell">' +
    '<section class="pdf-pane">' +
      '<header class="pane-header"><strong>PDF</strong><span id="runtime-status">Starting…</span></header>' +
      '<div class="empty-state"><div><h1>PDF-AI</h1><p>PDF reader setup is ready. Reader controls arrive in Phase 1.</p></div></div>' +
    '</section>' +
    '<aside class="chat-pane">' +
      '<header class="pane-header"><strong>AI Chat</strong></header>' +
      '<div class="empty-state"><p>ChatGPT integration is intentionally inactive during the local reader phases.</p></div>' +
    '</aside>' +
  '</div>';

void window.pdfAi.runtimeInfo().then(info => {
  const status = document.querySelector<HTMLElement>('#runtime-status');
  if (status) status.textContent = info.bridgeId + ' · MCP ' + info.mcpConnectorName;
});

