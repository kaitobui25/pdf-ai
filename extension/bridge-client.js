export const PDF_AI_APP_ID = 'pdf-ai';
export const PDF_AI_BRIDGE_PROTOCOL = 1;
export const PDF_AI_BRIDGE_PORTS = Object.freeze([8875, 8876, 8877, 8878, 8879]);

export const PDF_AI_LOCAL_STATE_KEY = 'pdfAiBridgeConnection';
export const PDF_AI_ACK_OUTBOX_KEY = 'pdfAiBridgeAckOutbox';

const MAX_ACK_OUTBOX = 100;

function isBridgePort(value) {
  return Number.isInteger(value) && PDF_AI_BRIDGE_PORTS.includes(value);
}

function bridgeUrl(port, path) {
  if (!isBridgePort(port)) throw new Error('Invalid PDF-AI bridge port.');
  return `http://127.0.0.1:${port}${path}`;
}

function identityHeaders(extensionId) {
  return {
    'x-pdf-ai-app-id': PDF_AI_APP_ID,
    'x-pdf-ai-protocol': String(PDF_AI_BRIDGE_PROTOCOL),
    'x-pdf-ai-extension-id': extensionId
  };
}

async function readStorage(area, key) {
  const values = await area.get(key);
  return values && typeof values === 'object' ? values[key] : undefined;
}

async function writeStorage(area, key, value) {
  await area.set({ [key]: value });
}

async function removeStorage(area, key) {
  if (typeof area.remove === 'function') await area.remove(key);
  else await area.set({ [key]: undefined });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function networkFailure(error) {
  return {
    ok: false,
    status: 0,
    data: null,
    error: error instanceof Error ? error.message : String(error)
  };
}

function terminalAckStatus(status) {
  return status >= 400 && status < 500 && ![401, 408, 426, 429].includes(status);
}

/**
 * Pure bridge client. Chrome APIs are injected so the transport can be tested without a
 * service worker and recreated against the same storage to simulate MV3 suspension/restart.
 */
export function createBridgeClient({
  fetch: fetchImpl,
  localStorage,
  sessionStorage,
  extensionId,
  now = () => Date.now()
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  if (!localStorage?.get || !localStorage?.set) throw new TypeError('localStorage is required.');
  if (!sessionStorage?.get || !sessionStorage?.set) throw new TypeError('sessionStorage is required.');
  if (typeof extensionId !== 'string' || !extensionId) throw new TypeError('extensionId is required.');

  let pairing = null;

  async function fetchJson(port, path, init = {}) {
    try {
      const response = await fetchImpl(bridgeUrl(port, path), init);
      const data = await readJson(response);
      return {
        ok: response.ok,
        status: response.status,
        data,
        error: response.ok ? null : (data?.error ?? `HTTP ${response.status}`)
      };
    } catch (error) {
      return networkFailure(error);
    }
  }

  async function readConnection() {
    const stored = await readStorage(localStorage, PDF_AI_LOCAL_STATE_KEY);
    if (!stored || typeof stored !== 'object' || !isBridgePort(stored.port)) return null;
    return {
      port: stored.port,
      token: typeof stored.token === 'string' && stored.token ? stored.token : null
    };
  }

  async function saveConnection(connection) {
    await writeStorage(localStorage, PDF_AI_LOCAL_STATE_KEY, connection);
  }

  async function clearConnection() {
    await removeStorage(localStorage, PDF_AI_LOCAL_STATE_KEY);
  }

  async function hello(port) {
    const result = await fetchJson(port, '/hello', {
      method: 'GET',
      cache: 'no-store',
      headers: identityHeaders(extensionId)
    });
    if (!result.ok) return null;
    if (result.data?.appId !== PDF_AI_APP_ID || result.data?.protocol !== PDF_AI_BRIDGE_PROTOCOL) return null;
    return result.data;
  }

  async function discover() {
    const stored = await readConnection();
    const candidates = stored
      ? [stored.port, ...PDF_AI_BRIDGE_PORTS.filter(port => port !== stored.port)]
      : [...PDF_AI_BRIDGE_PORTS];
    for (const port of candidates) {
      const greeting = await hello(port);
      if (!greeting) continue;
      return { port, greeting };
    }
    return null;
  }

  async function pairOnce() {
    const found = await discover();
    if (!found) return { ok: false, status: 0, data: null, error: 'pdf_ai_app_not_found' };
    const result = await fetchJson(found.port, '/pair', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...identityHeaders(extensionId),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appId: PDF_AI_APP_ID,
        protocol: PDF_AI_BRIDGE_PROTOCOL,
        extensionId
      })
    });
    const token = result.data?.token;
    if (!result.ok || typeof token !== 'string' || !token) return result;
    await saveConnection({ port: found.port, token });
    return { ...result, port: found.port, token };
  }

  function pair() {
    if (pairing) return pairing;
    pairing = pairOnce().finally(() => {
      pairing = null;
    });
    return pairing;
  }

  async function protectedRequest(path, init = {}, retried = false) {
    let connection = await readConnection();
    if (!connection?.token) {
      const paired = await pair();
      if (!paired.ok) return paired;
      connection = { port: paired.port, token: paired.token };
    }
    const headers = {
      ...identityHeaders(extensionId),
      authorization: `Bearer ${connection.token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    };
    const result = await fetchJson(connection.port, path, {
      ...init,
      cache: 'no-store',
      headers
    });
    if (result.status === 401 && !retried) {
      await clearConnection();
      const paired = await pair();
      if (!paired.ok) return paired;
      return protectedRequest(path, init, true);
    }
    if (result.status === 0) await clearConnection();
    return result;
  }

  async function getStatus() {
    return protectedRequest('/status', { method: 'GET' });
  }

  async function getNextCommand(waitMs = 0) {
    const bounded = Number.isFinite(waitMs) ? Math.max(0, Math.min(25_000, Math.floor(waitMs))) : 0;
    const suffix = bounded ? `?wait=${bounded}` : '';
    return protectedRequest('/commands/next' + suffix, { method: 'GET' });
  }

  async function postEvents(events) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 64) {
      return { ok: false, status: 0, data: null, error: 'invalid_event_batch' };
    }
    return protectedRequest('/events', {
      method: 'POST',
      body: JSON.stringify({ events })
    });
  }

  async function getDocumentChunk(documentId, offset, limit = 256 * 1024) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(documentId)) {
      return { ok: false, status: 0, data: null, error: 'invalid_document_id' };
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1024) {
      return { ok: false, status: 0, data: null, error: 'invalid_document_range' };
    }
    return protectedRequest(`/documents/${encodeURIComponent(documentId)}/file?offset=${offset}&limit=${limit}`, {
      method: 'GET'
    });
  }

  async function readAckOutbox() {
    const stored = await readStorage(sessionStorage, PDF_AI_ACK_OUTBOX_KEY);
    return Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.id === 'string') : [];
  }

  async function writeAckOutbox(entries) {
    await writeStorage(sessionStorage, PDF_AI_ACK_OUTBOX_KEY, entries.slice(-MAX_ACK_OUTBOX));
  }

  async function drainAckOutbox() {
    let outbox = await readAckOutbox();
    for (const entry of [...outbox]) {
      const result = await protectedRequest('/commands/ack', {
        method: 'POST',
        body: JSON.stringify(entry.body)
      });
      if (!result.ok && !terminalAckStatus(result.status)) {
        return { ok: false, pending: outbox.length, error: result.error, status: result.status };
      }
      outbox = outbox.filter(candidate => candidate.id !== entry.id);
      await writeAckOutbox(outbox);
    }
    return { ok: true, pending: 0 };
  }

  async function ackCommand(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, pending: (await readAckOutbox()).length, error: 'invalid_ack' };
    }
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id || id.length > 128) {
      return { ok: false, pending: (await readAckOutbox()).length, error: 'invalid_ack_id' };
    }
    const current = await readAckOutbox();
    const retained = current.filter(entry => entry.id !== id);
    if (retained.length >= MAX_ACK_OUTBOX) {
      return { ok: false, pending: current.length, error: 'ack_outbox_full' };
    }
    await writeAckOutbox([...retained, { id, body: { ...body, id }, queuedAt: now() }]);
    return drainAckOutbox();
  }

  async function health() {
    const status = await getStatus();
    const connection = await readConnection();
    const pendingAcks = (await readAckOutbox()).length;
    return {
      ok: status.ok,
      connected: status.ok,
      appId: PDF_AI_APP_ID,
      protocol: PDF_AI_BRIDGE_PROTOCOL,
      extensionId,
      port: connection?.port ?? null,
      pendingAcks,
      status: status.data,
      error: status.ok ? null : status.error
    };
  }

  async function reconnect() {
    await clearConnection();
    const paired = await pair();
    if (!paired.ok) return health();
    await drainAckOutbox();
    return health();
  }

  return {
    ackCommand,
    discover,
    drainAckOutbox,
    getDocumentChunk,
    getNextCommand,
    getStatus,
    health,
    pair,
    postEvents,
    reconnect
  };
}
