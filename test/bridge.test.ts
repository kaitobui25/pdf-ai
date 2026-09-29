import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL
} from '../src/shared/constants.js';
import {
  MemoryBridgeStateStore,
  startBrowserBridge,
  type BrowserBridge
} from '../src/main/bridge.js';

const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_EXTENSION_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const running = new Set<BrowserBridge>();

class FailableBridgeStateStore extends MemoryBridgeStateStore {
  failNextSave = false;

  override async save(state: Parameters<MemoryBridgeStateStore['save']>[0]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('simulated bridge state write failure');
    }
    await super.save(state);
  }
}

function bridgeHeaders(
  token?: string,
  extensionId = EXTENSION_ID,
  protocol: number = BRIDGE_PROTOCOL,
  appId = 'pdf-ai'
): Record<string, string> {
  return {
    'x-pdf-ai-app-id': appId,
    'x-pdf-ai-protocol': String(protocol),
    'x-pdf-ai-extension-id': extensionId,
    ...(token ? { authorization: 'Bearer ' + token } : {})
  };
}

async function start(
  store = new MemoryBridgeStateStore(),
  options: Parameters<typeof startBrowserBridge>[1] = {}
) {
  const bridge = await startBrowserBridge(store, options);
  running.add(bridge);
  return { bridge, store };
}

async function pair(bridge: BrowserBridge, rotate = false, token?: string): Promise<string> {
  const response = await fetch(bridge.url + '/pair', {
    method: 'POST',
    headers: {
      ...bridgeHeaders(token),
      origin: 'chrome-extension://' + EXTENSION_ID,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      appId: 'pdf-ai',
      protocol: BRIDGE_PROTOCOL,
      extensionId: EXTENSION_ID,
      ...(rotate ? { rotate: true } : {})
    })
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  return body.token;
}

afterEach(async () => {
  await Promise.all([...running].map(bridge => bridge.stop().catch(() => undefined)));
  running.clear();
});

describe('PDF-AI browser bridge', () => {
  it('reports browser-extension pairing and recent activity separately from bridge listener health', async () => {
    let clock = 10_000;
    const { bridge } = await start(new MemoryBridgeStateStore(), { now: () => clock });
    expect(bridge.getStatus()).toMatchObject({
      paired: false,
      active: false,
      lastSeenAt: null,
      queuedCommands: 0,
      port: bridge.port
    });

    const token = await pair(bridge);
    expect(bridge.getStatus()).toMatchObject({ paired: true, active: true, lastSeenAt: clock });

    clock += 69_000;
    expect(bridge.getStatus().active).toBe(true);
    clock += 2_000;
    expect(bridge.getStatus().active).toBe(false);

    const status = await fetch(bridge.url + '/status', { headers: bridgeHeaders(token) });
    expect(status.status).toBe(200);
    expect(bridge.getStatus()).toMatchObject({ paired: true, active: true, lastSeenAt: clock });
  });

  it('binds only the dedicated port range and identifies pdf-ai on /hello', async () => {
    const { bridge } = await start();
    expect(BRIDGE_PORTS).toContain(bridge.port);
    expect(bridge.port).toBeGreaterThanOrEqual(8875);
    expect(bridge.port).toBeLessThanOrEqual(8879);

    const response = await fetch(bridge.url + '/hello', {
      headers: { origin: 'chrome-extension://' + EXTENSION_ID }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      appId: 'pdf-ai',
      bridgeId: 'pdf-ai',
      protocol: BRIDGE_PROTOCOL,
      port: bridge.port
    });
  });

  it('rejects wrong origins, app IDs and protocol versions', async () => {
    const { bridge } = await start();
    const badOrigin = await fetch(bridge.url + '/hello', {
      headers: { origin: 'https://example.com' }
    });
    expect(badOrigin.status).toBe(403);

    const wrongApp = await fetch(bridge.url + '/pair', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(undefined, EXTENSION_ID, BRIDGE_PROTOCOL, 'other-app'),
        origin: 'chrome-extension://' + EXTENSION_ID,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appId: 'other-app',
        protocol: BRIDGE_PROTOCOL,
        extensionId: EXTENSION_ID
      })
    });
    expect(wrongApp.status).toBe(409);

    const wrongProtocol = await fetch(bridge.url + '/pair', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(undefined, EXTENSION_ID, BRIDGE_PROTOCOL + 1),
        origin: 'chrome-extension://' + EXTENSION_ID,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appId: 'pdf-ai',
        protocol: BRIDGE_PROTOCOL + 1,
        extensionId: EXTENSION_ID
      })
    });
    expect(wrongProtocol.status).toBe(426);
  });

  it('allows a missing Origin on pairing but still binds the declared extension identity', async () => {
    const { bridge } = await start();
    const response = await fetch(bridge.url + '/pair', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appId: 'pdf-ai',
        protocol: BRIDGE_PROTOCOL,
        extensionId: EXTENSION_ID
      })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    const status = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders(body.token)
    });
    expect(status.status).toBe(200);
  });

  it('requires the paired extension and rejects missing, wrong and stale tokens', async () => {
    const { bridge } = await start();
    const firstToken = await pair(bridge);

    const missing = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders()
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders('wrong-token')
    });
    expect(wrong.status).toBe(401);

    const wrongExtension = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders(firstToken, OTHER_EXTENSION_ID)
    });
    expect(wrongExtension.status).toBe(403);

    const secondToken = await pair(bridge, true, firstToken);
    expect(secondToken).not.toBe(firstToken);

    const stale = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders(firstToken)
    });
    expect(stale.status).toBe(401);

    const current = await fetch(bridge.url + '/status', {
      headers: bridgeHeaders(secondToken)
    });
    expect(current.status).toBe(200);
  });

  it('moves to the next PDF-AI port when a candidate is occupied', async () => {
    const first = await start();
    const remaining = BRIDGE_PORTS.filter(port => port !== first.bridge.port);
    const second = await start(new MemoryBridgeStateStore(), {
      ports: [first.bridge.port, ...remaining]
    });
    expect(second.bridge.port).not.toBe(first.bridge.port);
    expect(BRIDGE_PORTS).toContain(second.bridge.port);
  });

  it('persists pairing and pending commands across a bridge restart', async () => {
    const store = new MemoryBridgeStateStore();
    const first = await start(store);
    const token = await pair(first.bridge);
    const command = await first.bridge.enqueueCommand('health_probe', { nonce: 7 });

    await first.bridge.stop();
    running.delete(first.bridge);
    const second = await start(store);

    const status = await fetch(second.bridge.url + '/status', {
      headers: bridgeHeaders(token)
    });
    expect(status.status).toBe(200);

    const next = await fetch(second.bridge.url + '/commands/next', {
      headers: bridgeHeaders(token)
    });
    await expect(next.json()).resolves.toMatchObject({
      command: { id: command.id, type: 'health_probe', payload: { nonce: 7 } }
    });
  });

  it('keeps command delivery at-least-once until a durable idempotent ACK arrives', async () => {
    const { bridge } = await start();
    const token = await pair(bridge);
    const command = await bridge.enqueueCommand('health_probe', { nonce: 9 });

    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await fetch(bridge.url + '/commands/next', {
        headers: bridgeHeaders(token)
      });
      await expect(next.json()).resolves.toMatchObject({
        command: { id: command.id, type: 'health_probe' }
      });
    }

    const ackBody = JSON.stringify({ id: command.id, status: 'ok' });
    const ack = await fetch(bridge.url + '/commands/ack', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(token),
        'content-type': 'application/json'
      },
      body: ackBody
    });
    expect(ack.status).toBe(200);
    const receipt = await ack.json();

    const replay = await fetch(bridge.url + '/commands/ack', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(token),
        'content-type': 'application/json'
      },
      body: ackBody
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);

    const empty = await fetch(bridge.url + '/commands/next', {
      headers: bridgeHeaders(token)
    });
    await expect(empty.json()).resolves.toMatchObject({ command: null });
  });

  it('does not publish command or ACK state until the durable save succeeds', async () => {
    const store = new FailableBridgeStateStore();
    const { bridge } = await start(store);
    const token = await pair(bridge);

    store.failNextSave = true;
    await expect(bridge.enqueueCommand('health_probe', { nonce: 11 }))
      .rejects.toThrow('simulated bridge state write failure');
    const afterFailedEnqueue = await fetch(bridge.url + '/commands/next', {
      headers: bridgeHeaders(token)
    });
    await expect(afterFailedEnqueue.json()).resolves.toMatchObject({ command: null });

    const command = await bridge.enqueueCommand('health_probe', { nonce: 12 });
    store.failNextSave = true;
    const failedAck = await fetch(bridge.url + '/commands/ack', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(token),
        'content-type': 'application/json'
      },
      body: JSON.stringify({ id: command.id, status: 'ok' })
    });
    expect(failedAck.status).toBe(500);

    const stillPending = await fetch(bridge.url + '/commands/next', {
      headers: bridgeHeaders(token)
    });
    await expect(stillPending.json()).resolves.toMatchObject({
      command: { id: command.id, type: 'health_probe' }
    });
  });

  it('enforces request body and rate limits', async () => {
    const rateLimited = await start(new MemoryBridgeStateStore(), { rateLimit: 2 });
    expect((await fetch(rateLimited.bridge.url + '/hello')).status).toBe(200);
    expect((await fetch(rateLimited.bridge.url + '/hello')).status).toBe(200);
    expect((await fetch(rateLimited.bridge.url + '/hello')).status).toBe(429);

    const { bridge } = await start();
    const oversized = await fetch(bridge.url + '/pair', {
      method: 'POST',
      headers: {
        ...bridgeHeaders(),
        origin: 'chrome-extension://' + EXTENSION_ID,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appId: 'pdf-ai',
        protocol: BRIDGE_PROTOCOL,
        extensionId: EXTENSION_ID,
        padding: 'x'.repeat(300 * 1024)
      })
    });
    expect(oversized.status).toBe(413);
  });

  it('long-polls for commands and exposes only protected bounded event/document routes', async () => {
    const eventBatches: unknown[][] = [];
    const { bridge } = await start(new MemoryBridgeStateStore(), {
      onEvents: async events => {
        eventBatches.push(events);
        return (events as Array<{ eventId?: unknown }>).map(event => ({
          eventId: String(event.eventId ?? ''),
          status: 'ok'
        }));
      },
      readDocumentChunk: async (documentId, offset, limit) => ({
        documentId,
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        size: 4,
        offset,
        nextOffset: Math.min(4, offset + limit),
        done: offset + limit >= 4,
        base64: 'JVBERg=='
      })
    });
    const token = await pair(bridge);

    const longPoll = fetch(bridge.url + '/commands/next?wait=1000', {
      headers: bridgeHeaders(token)
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const command = await bridge.enqueueCommand('chat_send', { hello: 'world' });
    const polled = await longPoll;
    await expect(polled.json()).resolves.toMatchObject({
      command: { id: command.id, type: 'chat_send' }
    });

    const events = await fetch(bridge.url + '/events', {
      method: 'POST',
      headers: { ...bridgeHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ eventId: 'event-12345678' }] })
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      receipts: [{ eventId: 'event-12345678', status: 'ok' }]
    });
    expect(eventBatches).toEqual([[{ eventId: 'event-12345678' }]]);

    const documentId = 'pdf-0123456789abcdef0123456789abcdef';
    const chunk = await fetch(bridge.url + `/documents/${documentId}/file?offset=0&limit=4`, {
      headers: bridgeHeaders(token)
    });
    expect(chunk.status).toBe(200);
    await expect(chunk.json()).resolves.toMatchObject({
      documentId,
      offset: 0,
      nextOffset: 4,
      done: true
    });

    expect((await fetch(bridge.url + '/events', {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ eventId: 'event-unauthorized' }] })
    })).status).toBe(401);
    expect((await fetch(bridge.url + `/documents/${documentId}/file?offset=0&limit=999999`, {
      headers: bridgeHeaders(token)
    })).status).toBe(400);
  });
});
