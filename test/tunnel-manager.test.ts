import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTunnelConfigStore } from '../src/main/tunnel-config.js';
import type { TunnelCredentialStore } from '../src/main/tunnel-credential.js';
import {
  TunnelManager,
  tunnelChildEnv,
  type TunnelChild,
  type TunnelManagerDependencies,
  type TunnelRuntimeResolver,
  type TunnelSpawnOptions
} from '../src/main/tunnel-manager.js';

const TUNNEL_ID = 'tunnel_0123456789abcdef0123456789abcdef';
const API_KEY = 'sk-test-phase-4-1-secret';
const MCP_URL = 'http://127.0.0.1:54321/mcp/pdf-ai/secret-runtime-path';

class TestCredentialStore implements TunnelCredentialStore {
  value: string | null = null;

  async status() {
    return { available: true, detail: null };
  }

  async has() {
    return this.value !== null;
  }

  async get() {
    return this.value;
  }

  async set(value: string) {
    this.value = value.trim();
  }
}

class FakeChild extends EventEmitter implements TunnelChild {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    this.emit('close');
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
    this.emit('close');
  }
}

interface SpawnRecord {
  executable: string;
  args: string[];
  options: TunnelSpawnOptions;
  child: FakeChild;
}

const managers = new Set<TunnelManager>();

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition.');
}

function runtime(): TunnelRuntimeResolver {
  return {
    ensure: async () => ({
      executable: 'C:\\PDF-AI\\runtime\\tunnel-client.exe',
      version: 'v0.0.15',
      source: 'verified-cache'
    })
  };
}

function createHarness(options: {
  mcpUrl?: string;
  probeReady?: TunnelManagerDependencies['probeReady'];
  terminateProcess?: TunnelManagerDependencies['terminateProcess'];
  now?: () => number;
} = {}) {
  const credential = new TestCredentialStore();
  const spawns: SpawnRecord[] = [];
  const now = options.now ?? (() => Date.now());
  const dependencies: Partial<TunnelManagerDependencies> = {
    spawnProcess: (executable, args, spawnOptions) => {
      const child = new FakeChild();
      spawns.push({ executable, args: [...args], options: spawnOptions, child });
      const index = args.indexOf('--health.url-file');
      const healthFile = index >= 0 ? args[index + 1] : undefined;
      if (!healthFile) throw new Error('Missing health.url argument in test spawn.');
      void writeFile(healthFile, 'http://127.0.0.1:45678\n');
      return child;
    },
    terminateProcess: options.terminateProcess ?? (async child => {
      const fake = child as FakeChild;
      if (fake.exitCode === null && fake.signalCode === null) fake.kill();
    }),
    probeReady: options.probeReady ?? (async () => true),
    readPollHealth: async () => ({ lastSuccessMs: now(), polls: 1, errors: 0 }),
    readClientStatus: async () => ({ version: '0.0.15', probe: 'ok', metadataError: null }),
    now,
    delay: ms => new Promise(resolve => setTimeout(resolve, ms))
  };
  const manager = new TunnelManager(
    options.mcpUrl ?? MCP_URL,
    new MemoryTunnelConfigStore(),
    credential,
    runtime(),
    dependencies,
    {
      readyTimeoutMs: 300,
      readyPollMs: 2,
      watchIntervalMs: 5,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20
    }
  );
  managers.add(manager);
  return { manager, credential, spawns };
}

afterEach(async () => {
  await Promise.all([...managers].map(manager => manager.stop().catch(() => undefined)));
  managers.clear();
});

describe('PDF-AI tunnel manager', () => {
  it('keeps the API key and secret MCP URL out of argv/status and passes only the current values in a scrubbed child environment', async () => {
    const { manager, spawns } = createHarness();
    const start = await manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    expect(JSON.stringify(start)).not.toContain(API_KEY);
    expect(JSON.stringify(start)).not.toContain('/mcp/pdf-ai/secret-runtime-path');

    await until(() => spawns.length === 1);
    const spawned = spawns[0]!;
    expect(spawned.args).toContain(TUNNEL_ID);
    expect(spawned.args.join(' ')).not.toContain(API_KEY);
    expect(spawned.args.join(' ')).not.toContain(MCP_URL);
    expect(spawned.options.env.CONTROL_PLANE_API_KEY).toBe(API_KEY);
    expect(spawned.options.env.MCP_SERVER_URL).toBe(`url=${MCP_URL},channel=main`);

    await until(async () => (await manager.getStatus()).state === 'connected');
    const connected = await manager.getStatus();
    expect(JSON.stringify(connected)).not.toContain(API_KEY);
    expect(JSON.stringify(connected)).not.toContain('/mcp/pdf-ai/secret-runtime-path');

    const scrubbed = tunnelChildEnv({
      Control_Plane_Api_Key: 'stale-other-app-key',
      mcp_server_url: 'url=http://stale.example,channel=main',
      MCP_DISCOVERY_EXTRA_HEADERS: 'x-secret: stale',
      PATH: 'C:\\Windows\\System32'
    }, API_KEY, MCP_URL);
    expect(scrubbed.Control_Plane_Api_Key).toBeUndefined();
    expect(scrubbed.mcp_server_url).toBeUndefined();
    expect(scrubbed.MCP_DISCOVERY_EXTRA_HEADERS).toBeUndefined();
    expect(scrubbed.CONTROL_PLANE_API_KEY).toBe(API_KEY);
    expect(scrubbed.MCP_SERVER_URL).toBe(`url=${MCP_URL},channel=main`);
  });

  it('restarts after an unexpected exit with bounded backoff and ignores the retired child afterward', async () => {
    const { manager, spawns } = createHarness();
    await manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    await until(async () => spawns.length === 1 && (await manager.getStatus()).state === 'connected');
    const first = spawns[0]!.child;
    first.exit(17);

    await until(() => spawns.length === 2);
    await until(async () => (await manager.getStatus()).state === 'connected');
    first.stdout.write(JSON.stringify({
      level: 'ERROR',
      msg: 'tunnel metadata fetch failed',
      error: '401 Unauthorized',
      status_code: 401
    }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 15));
    expect((await manager.getStatus()).state).toBe('connected');
    expect(spawns.length).toBe(2);

    await manager.disconnect();
    spawns[1]!.child.exit(9);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(spawns.length).toBe(2);
    expect((await manager.getStatus()).state).toBe('disconnected');
  });

  it('waits for persistent local unready state and retires the old process before replacement', async () => {
    let probeCalls = 0;
    let releaseRetirement!: () => void;
    const retirement = new Promise<void>(resolve => { releaseRetirement = resolve; });
    let terminateCalls = 0;
    const { manager, spawns } = createHarness({
      probeReady: async () => {
        probeCalls += 1;
        if (probeCalls === 1) return true;
        if (probeCalls === 2 || probeCalls === 3) return false;
        return true;
      },
      terminateProcess: async child => {
        terminateCalls += 1;
        if (terminateCalls === 1) await retirement;
        const fake = child as FakeChild;
        if (fake.exitCode === null && fake.signalCode === null) fake.kill();
      }
    });
    await manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    await until(() => terminateCalls === 1);
    expect(spawns.length).toBe(1);
    releaseRetirement();
    await until(() => spawns.length === 2);
    expect(spawns.length).toBe(2);
  });

  it('stops retrying on a real control-plane auth rejection but ignores local 401 text', async () => {
    const { manager, spawns } = createHarness();
    await manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    await until(async () => spawns.length === 1 && (await manager.getStatus()).state === 'connected');
    const child = spawns[0]!.child;

    child.stderr.write(JSON.stringify({
      level: 'WARN',
      msg: 'local MCP probe failed',
      error: 'unexpected status 401',
      status_code: 401
    }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await manager.getStatus()).state).toBe('connected');

    child.stderr.write(JSON.stringify({
      level: 'ERROR',
      msg: 'tunnel metadata fetch failed',
      error: 'unexpected status 401',
      status_code: 401
    }) + '\n');
    await until(async () => (await manager.getStatus()).state === 'auth-failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(spawns.length).toBe(1);
  });

  it('uses the fresh MCP URL supplied to each app lifecycle without a user-edited tunnel profile', async () => {
    const first = createHarness({ mcpUrl: 'http://127.0.0.1:51001/mcp/pdf-ai/first-secret' });
    await first.manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    await until(() => first.spawns.length === 1);
    expect(first.spawns[0]!.options.env.MCP_SERVER_URL).toBe(
      'url=http://127.0.0.1:51001/mcp/pdf-ai/first-secret,channel=main'
    );
    await first.manager.disconnect();

    const second = createHarness({ mcpUrl: 'http://127.0.0.1:51002/mcp/pdf-ai/second-secret' });
    await second.manager.connect({ tunnelId: TUNNEL_ID, apiKey: API_KEY });
    await until(() => second.spawns.length === 1);
    expect(second.spawns[0]!.options.env.MCP_SERVER_URL).toBe(
      'url=http://127.0.0.1:51002/mcp/pdf-ai/second-secret,channel=main'
    );
  });
});
