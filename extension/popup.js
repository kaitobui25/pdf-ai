const status = document.querySelector('#status');
const reconnect = document.querySelector('#reconnect');

function render(result) {
  if (!status) return;
  if (!result?.connected) {
    status.textContent = `Disconnected\n${result?.error || 'PDF-AI is not reachable on ports 8875–8879.'}`;
    return;
  }
  status.textContent = `Connected to PDF-AI\nPort ${result.port}\nProtocol ${result.protocol}\nPending ACKs ${result.pendingAcks}`;
}

async function request(type) {
  try {
    render(await chrome.runtime.sendMessage({ type }));
  } catch (error) {
    render({ connected: false, error: error instanceof Error ? error.message : String(error) });
  }
}

reconnect?.addEventListener('click', () => {
  void request('pdf-ai:bridge-reconnect');
});

void request('pdf-ai:bridge-status');
