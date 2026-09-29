import { afterEach, describe, expect, it } from 'vitest';
import {
  PDF_AI_ACK_OUTBOX_KEY,
  createBridgeClient,
  type BridgeStorageArea
} from '../extension/bridge-client.js';
import {
  MemoryBridgeStateStore,
  startBrowserBridge,
  type BrowserBridge
} from '../src/main/bridge.js';

const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const running = new Set<BrowserBridge>();

class MemoryStorage implements BridgeStorageArea {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values[key] };
  }

  async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(values));
  }

  async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

function extensionFetch(
  loseFirstAckResponse: { value: boolean }
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const response = await fetch(input, { ...init, headers });
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/commands/ack' && loseFirstAckResponse.value) {
      loseFirstAckResponse.value = false;
      await response.arrayBuffer();
      throw new Error('simulated lost ACK response after server commit');
    }
    return response;
  };
}

afterEach(async () => {
  await Promise.all([...running].map(bridge => bridge.stop().catch(() => undefined)));
  running.clear();
});

describe('PDF-AI app and MV3 bridge client integration', () => {
  it('pairs, delivers a command, and recovers a lost ACK after service-worker restart', async () => {
    const bridge = await startBrowserBridge(new MemoryBridgeStateStore());
    running.add(bridge);
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const loseFirstAckResponse = { value: true };
    const fetchImpl = extensionFetch(loseFirstAckResponse);

    const firstWorker = createBridgeClient({
      fetch: fetchImpl,
      localStorage,
      sessionStorage,
      extensionId: EXTENSION_ID
    });

    const health = await firstWorker.health();
    expect(health).toMatchObject({
      connected: true,
      appId: 'pdf-ai',
      protocol: 1,
      port: bridge.port
    });

    const command = await bridge.enqueueCommand('health_probe', { nonce: 17 });
    const next = await firstWorker.getNextCommand();
    expect(next).toMatchObject({
      ok: true,
      data: {
        command: {
          id: command.id,
          type: 'health_probe',
          payload: { nonce: 17 }
        }
      }
    });

    const firstAck = await firstWorker.ackCommand({ id: command.id, status: 'ok' });
    expect(firstAck).toMatchObject({ ok: false, pending: 1, status: 0 });
    expect(sessionStorage.values[PDF_AI_ACK_OUTBOX_KEY]).toMatchObject([
      { id: command.id, body: { id: command.id, status: 'ok' } }
    ]);

    const restartedWorker = createBridgeClient({
      fetch: fetchImpl,
      localStorage,
      sessionStorage,
      extensionId: EXTENSION_ID
    });
    expect(await restartedWorker.drainAckOutbox()).toMatchObject({ ok: true, pending: 0 });
    expect(sessionStorage.values[PDF_AI_ACK_OUTBOX_KEY]).toEqual([]);

    const afterAck = await restartedWorker.getNextCommand();
    expect(afterAck).toMatchObject({ ok: true, data: { command: null } });
  });
});
