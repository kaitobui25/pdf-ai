import { describe, expect, it } from 'vitest';
import {
  PDF_AI_ACK_OUTBOX_KEY,
  PDF_AI_BRIDGE_PORTS,
  PDF_AI_LOCAL_STATE_KEY,
  createBridgeClient
} from '../extension/bridge-client.js';

const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class MemoryStorage {
  readonly values: Record<string, unknown>;

  constructor(seed: Record<string, unknown> = {}) {
    this.values = structuredClone(seed);
  }

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('PDF-AI extension bridge client', () => {
  it('scans only 8875-8879, validates hello identity/protocol, and uses the proposed route contract', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extensionId = EXTENSION_ID;

    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      calls.push({ url: href, init });
      const parsed = new URL(href);
      const port = Number(parsed.port);

      if (parsed.pathname === '/hello') {
        if (port === 8875) return jsonResponse(200, { appId: 'chat-on-steroids', protocol: 1 });
        if (port === 8876) return jsonResponse(200, { appId: 'pdf-ai', protocol: 2 });
        if (port === 8877) return jsonResponse(200, { appId: 'pdf-ai', protocol: 1 });
        return jsonResponse(404, { error: 'not_found' });
      }
      if (parsed.pathname === '/pair') {
        expect(header(init, 'x-pdf-ai-app-id')).toBe('pdf-ai');
        expect(header(init, 'x-pdf-ai-protocol')).toBe('1');
        expect(header(init, 'x-pdf-ai-extension-id')).toBe(extensionId);
        expect(JSON.parse(String(init?.body))).toEqual({ appId: 'pdf-ai', protocol: 1, extensionId });
        return jsonResponse(200, { token: 'bridge-token' });
      }
      if (parsed.pathname === '/status') return jsonResponse(200, { ready: true });
      if (parsed.pathname === '/commands/next') return jsonResponse(200, { command: null });
      if (parsed.pathname === '/commands/ack') return jsonResponse(200, { ok: true });
      return jsonResponse(404, { error: 'not_found' });
    };

    const client = createBridgeClient({
      fetch: fetchMock,
      localStorage: local,
      sessionStorage: session,
      extensionId
    });

    expect(await client.getStatus()).toMatchObject({ ok: true, data: { ready: true } });
    expect(await client.getNextCommand()).toMatchObject({ ok: true, data: { command: null } });
    expect(await client.ackCommand({ id: '0123456789abcdef01234567', status: 'ok' })).toMatchObject({ ok: true, pending: 0 });

    const touchedPorts = calls.map(call => Number(new URL(call.url).port));
    expect(touchedPorts.every(port => PDF_AI_BRIDGE_PORTS.includes(port as (typeof PDF_AI_BRIDGE_PORTS)[number]))).toBe(true);
    expect(touchedPorts).not.toContain(8765);
    expect(calls.filter(call => new URL(call.url).pathname === '/hello').slice(0, 3).map(call => Number(new URL(call.url).port)))
      .toEqual([8875, 8876, 8877]);

    const protectedCalls = calls.filter(call => ['/status', '/commands/next', '/commands/ack'].includes(new URL(call.url).pathname));
    for (const call of protectedCalls) {
      expect(header(call.init, 'authorization')).toBe('Bearer bridge-token');
      expect(header(call.init, 'x-pdf-ai-app-id')).toBe('pdf-ai');
      expect(header(call.init, 'x-pdf-ai-protocol')).toBe('1');
      expect(header(call.init, 'x-pdf-ai-extension-id')).toBe(extensionId);
    }
    expect(local.values[PDF_AI_LOCAL_STATE_KEY]).toEqual({ port: 8877, token: 'bridge-token' });
  });

  it('persists an ACK before transport and retries it after a simulated service-worker restart', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    let ackAttempts = 0;
    let pairAttempts = 0;

    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/hello') {
        return Number(parsed.port) === 8875
          ? jsonResponse(200, { appId: 'pdf-ai', protocol: 1 })
          : jsonResponse(404, { error: 'not_found' });
      }
      if (parsed.pathname === '/pair') {
        pairAttempts++;
        return jsonResponse(200, { token: `token-${pairAttempts}` });
      }
      if (parsed.pathname === '/commands/ack') {
        ackAttempts++;
        expect(JSON.parse(String(init?.body))).toEqual({ id: '89abcdef0123456789abcdef', status: 'ok' });
        if (ackAttempts === 1) throw new Error('simulated lost ACK response');
        return jsonResponse(200, { ok: true, final: true });
      }
      if (parsed.pathname === '/status') return jsonResponse(200, { ready: true });
      return jsonResponse(404, { error: 'not_found' });
    };

    const firstWorker = createBridgeClient({
      fetch: fetchMock,
      localStorage: local,
      sessionStorage: session,
      extensionId: EXTENSION_ID
    });
    const firstAck = await firstWorker.ackCommand({ id: '89abcdef0123456789abcdef', status: 'ok' });
    expect(firstAck).toMatchObject({ ok: false, pending: 1, status: 0 });
    expect(session.values[PDF_AI_ACK_OUTBOX_KEY]).toMatchObject([
      { id: '89abcdef0123456789abcdef', body: { id: '89abcdef0123456789abcdef', status: 'ok' } }
    ]);

    const restartedWorker = createBridgeClient({
      fetch: fetchMock,
      localStorage: local,
      sessionStorage: session,
      extensionId: EXTENSION_ID
    });
    expect(await restartedWorker.drainAckOutbox()).toEqual({ ok: true, pending: 0 });
    expect(session.values[PDF_AI_ACK_OUTBOX_KEY]).toEqual([]);
    expect(ackAttempts).toBe(2);
    expect(pairAttempts).toBe(2);
  });

});
