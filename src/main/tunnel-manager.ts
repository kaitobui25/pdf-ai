import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TunnelConnectInput, TunnelConnectionStatus } from '../shared/tunnel.js';
import { TUNNEL_ID_PATTERN } from '../shared/tunnel.js';
import type { TunnelConfigStore } from './tunnel-config.js';
import type { TunnelCredentialStore } from './tunnel-credential.js';
import {
  POLL_FRESH_MS,
  probeTunnelReady,
  readTunnelClientStatus,
  readTunnelPollHealth,
  tunnelAuthenticationRejected,
  tunnelNetworkUnavailable,
  type TunnelClientStatus,
  type TunnelPollHealth
} from './tunnel-health.js';
import type { TunnelRuntime } from './tunnel-runtime.js';

const execFileAsync = promisify(execFile);

export interface TunnelChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface TunnelSpawnOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export interface TunnelManagerDependencies {
  spawnProcess(executable: string, args: string[], options: TunnelSpawnOptions): TunnelChild;
  terminateProcess(child: TunnelChild): Promise<void>;
  probeReady(baseUrl: string): Promise<boolean>;
  readPollHealth(baseUrl: string): Promise<TunnelPollHealth | null>;
  readClientStatus(baseUrl: string): Promise<TunnelClientStatus | null>;
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface TunnelRuntimeResolver {
  ensure(explicitPath?: string): Promise<TunnelRuntime>;
}

export interface TunnelManagerTiming {
  readyTimeoutMs: number;
  readyPollMs: number;
  watchIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

interface ActiveRun {
  child: TunnelChild;
  generation: number;
  healthDirectory: string;
  healthFile: string;
  healthBase: string | null;
  consecutiveUnready: number;
}

const DEFAULT_TIMING: TunnelManagerTiming = {
  readyTimeoutMs: 60_000,
  readyPollMs: 1_000,
  watchIntervalMs: 15_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000
};

function defaultSpawn(executable: string, args: string[], options: TunnelSpawnOptions): TunnelChild {
  return spawn(executable, args, options) as ChildProcess as TunnelChild;
}

async function defaultTerminate(child: TunnelChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', resolve));
  if (process.platform === 'win32' && child.pid !== undefined) {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {
      try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
  }
  await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 3_000))]);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function tunnelChildEnv(
  base: NodeJS.ProcessEnv,
  apiKey: string,
  localMcpUrl: string
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  const blocked = new Set([
    'CONTROL_PLANE_API_KEY',
    'MCP_SERVER_URL',
    'MCP_DISCOVERY_EXTRA_HEADERS'
  ]);
  for (const [name, value] of Object.entries(base)) {
    if (!blocked.has(name.toUpperCase())) clean[name] = value;
  }
  clean.CONTROL_PLANE_API_KEY = apiKey;
  clean.MCP_SERVER_URL = `url=${localMcpUrl},channel=main`;
  return clean;
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let carry = '';
  return chunk => {
    carry += chunk.toString();
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      if (line) onLine(line);
      newline = carry.indexOf('\n');
    }
    if (carry.length > 16_384) carry = '';
  };
}

interface TunnelLogEvent {
  message: string;
  error: string;
  statusCode: unknown;
  combined: string;
}

function tunnelLogEvent(line: string): TunnelLogEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const message = typeof event['msg'] === 'string' ? event['msg'] : '';
    const error = typeof event['error'] === 'string' ? event['error'] : '';
    const status = typeof event['status_code'] === 'number' ? String(event['status_code']) : '';
    return {
      message,
      error,
      statusCode: event['status_code'],
      combined: [message, error, status].filter(Boolean).join(': ').slice(0, 600)
    };
  } catch {
    return { message: '', error: line.slice(0, 600), statusCode: undefined, combined: line.slice(0, 600) };
  }
}

export class TunnelManager {
  private readonly dependencies: TunnelManagerDependencies;
  private readonly timing: TunnelManagerTiming;
  private status: TunnelConnectionStatus = {
    state: 'disconnected',
    detail: 'Not connected.',
    tunnelId: '',
    hasCredential: false,
    secureStorageAvailable: false,
    secureStorageDetail: null,
    runtimeVersion: null,
    retryInMs: null
  };
  private initialized = false;
  private connectionIntent = false;
  private generation = 0;
  private attempts = 0;
  private active: ActiveRun | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly localMcpUrl: string,
    private readonly configStore: TunnelConfigStore,
    private readonly credentialStore: TunnelCredentialStore,
    private readonly runtimeProvider: TunnelRuntimeResolver,
    dependencies: Partial<TunnelManagerDependencies> = {},
    timing: Partial<TunnelManagerTiming> = {}
  ) {
    this.dependencies = {
      spawnProcess: dependencies.spawnProcess ?? defaultSpawn,
      terminateProcess: dependencies.terminateProcess ?? defaultTerminate,
      probeReady: dependencies.probeReady ?? probeTunnelReady,
      readPollHealth: dependencies.readPollHealth ?? readTunnelPollHealth,
      readClientStatus: dependencies.readClientStatus ?? readTunnelClientStatus,
      now: dependencies.now ?? Date.now,
      delay: dependencies.delay ?? defaultDelay
    };
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const [config, storage, hasCredential] = await Promise.all([
      this.configStore.load(),
      this.credentialStore.status(),
      this.credentialStore.has()
    ]);
    this.status = {
      ...this.status,
      tunnelId: config.tunnelId,
      hasCredential,
      secureStorageAvailable: storage.available,
      secureStorageDetail: storage.detail
    };
    this.initialized = true;
  }

  async getStatus(): Promise<TunnelConnectionStatus> {
    await this.initialize();
    return { ...this.status };
  }

  async connect(input: TunnelConnectInput): Promise<TunnelConnectionStatus> {
    await this.initialize();
    const tunnelId = input.tunnelId.trim();
    if (!TUNNEL_ID_PATTERN.test(tunnelId)) {
      throw new Error('Tunnel ID must look like tunnel_ followed by 32 lowercase hex characters.');
    }
    if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
      await this.credentialStore.set(input.apiKey);
    }
    const credential = await this.credentialStore.get();
    if (!credential) throw new Error('Enter the restricted OpenAI tunnel API key.');
    await this.configStore.save({ tunnelId });
    const storage = await this.credentialStore.status();

    this.generation += 1;
    const generation = this.generation;
    this.connectionIntent = true;
    this.attempts = 0;
    this.clearReconnectTimer();
    const previous = this.active;
    this.active = null;
    if (previous) await this.retire(previous);
    this.status = {
      ...this.status,
      state: 'preparing-runtime',
      detail: 'Preparing the verified tunnel runtime…',
      tunnelId,
      hasCredential: true,
      secureStorageAvailable: storage.available,
      secureStorageDetail: storage.detail,
      retryInMs: null
    };
    this.startLaunch(generation, tunnelId);
    return { ...this.status };
  }

  async disconnect(): Promise<TunnelConnectionStatus> {
    await this.initialize();
    this.connectionIntent = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.status = { ...this.status, state: 'disconnecting', detail: 'Disconnecting…', retryInMs: null };
    const active = this.active;
    this.active = null;
    if (active) await this.retire(active);
    this.status = { ...this.status, state: 'disconnected', detail: 'Not connected.', retryInMs: null };
    return { ...this.status };
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }

  private async launch(generation: number, tunnelId: string): Promise<void> {
    let runtime: TunnelRuntime;
    try {
      runtime = await this.runtimeProvider.ensure(process.env.PDF_AI_TUNNEL_CLIENT_PATH);
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return;
      this.connectionIntent = false;
      this.status = {
        ...this.status,
        state: 'tunnel-unavailable',
        detail: error instanceof Error ? error.message : 'The verified tunnel runtime could not be prepared.',
        retryInMs: null
      };
      return;
    }
    if (!this.isCurrentGeneration(generation)) return;

    const credential = await this.credentialStore.get();
    if (!this.isCurrentGeneration(generation)) return;
    if (!credential) {
      this.connectionIntent = false;
      this.status = {
        ...this.status,
        state: 'tunnel-unavailable',
        detail: 'The tunnel credential became unavailable. Enter it again and reconnect.',
        retryInMs: null
      };
      return;
    }
    const healthDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-ai-tunnel-'));
    if (!this.isCurrentGeneration(generation)) {
      await fs.rm(healthDirectory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    const healthFile = path.join(healthDirectory, 'health.url');
    const args = [
      'run',
      '--control-plane.tunnel-id', tunnelId,
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', healthFile,
      '--log.format', 'json',
      '--log.level', 'info'
    ];
    const env = tunnelChildEnv(process.env, credential, this.localMcpUrl);

    this.status = {
      ...this.status,
      state: 'connecting',
      detail: 'Starting the PDF AI secure tunnel…',
      runtimeVersion: runtime.version,
      retryInMs: null
    };

    let child: TunnelChild;
    try {
      child = this.dependencies.spawnProcess(runtime.executable, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      await fs.rm(healthDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.scheduleReconnect(generation, error instanceof Error ? error.message : 'Could not start tunnel-client.');
      return;
    }

    const run: ActiveRun = {
      child,
      generation,
      healthDirectory,
      healthFile,
      healthBase: null,
      consecutiveUnready: 0
    };
    this.active = run;
    const onLine = lineReader(line => this.handleLine(run, line));
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('error', error => {
      if (!this.isActive(run)) return;
      void this.replaceRun(run, `Could not start tunnel-client: ${error.message}`);
    });
    child.on('exit', code => {
      if (!this.isActive(run)) return;
      this.active = null;
      void fs.rm(run.healthDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.scheduleReconnect(run.generation, `Tunnel client stopped unexpectedly${code === null ? '' : ` (exit ${code})`}.`);
    });
    void this.waitUntilReady(run);
  }

  private handleLine(run: ActiveRun, rawLine: string): void {
    if (!this.isActive(run)) return;
    const event = tunnelLogEvent(rawLine);
    if (tunnelAuthenticationRejected(event.message, event.error, event.statusCode)) {
      this.connectionIntent = false;
      this.clearReconnectTimer();
      this.status = {
        ...this.status,
        state: 'auth-failed',
        detail: 'OpenAI rejected the tunnel credential. Enter a valid restricted key and connect again.',
        retryInMs: null
      };
      this.active = null;
      void this.retire(run);
      return;
    }
    if (tunnelNetworkUnavailable(event.combined)) {
      this.status = {
        ...this.status,
        state: 'offline',
        detail: 'This PC cannot currently reach OpenAI. The tunnel client is still running and will keep retrying.',
        retryInMs: null
      };
    }
  }

  private async waitUntilReady(run: ActiveRun): Promise<void> {
    const deadline = this.dependencies.now() + this.timing.readyTimeoutMs;
    while (this.isActive(run) && this.dependencies.now() < deadline) {
      const base = await this.readHealthBase(run.healthFile);
      if (!this.isActive(run)) return;
      if (base && await this.dependencies.probeReady(base)) {
        if (!this.isActive(run)) return;
        run.healthBase = base;
        this.attempts = 0;
        await this.refreshHealth(run);
        if (this.isActive(run)) void this.watch(run);
        return;
      }
      await this.dependencies.delay(this.timing.readyPollMs);
    }
    if (this.isActive(run)) await this.replaceRun(run, 'The tunnel client did not become ready in time.');
  }

  private async watch(run: ActiveRun): Promise<void> {
    while (this.isActive(run)) {
      await this.dependencies.delay(this.timing.watchIntervalMs);
      if (!this.isActive(run) || !run.healthBase) return;
      const ready = await this.dependencies.probeReady(run.healthBase);
      if (!this.isActive(run)) return;
      if (!ready) {
        run.consecutiveUnready += 1;
        if (run.consecutiveUnready >= 2) {
          await this.replaceRun(run, 'The tunnel client stopped passing its local readiness check.');
          return;
        }
        continue;
      }
      run.consecutiveUnready = 0;
      await this.refreshHealth(run);
    }
  }

  private async refreshHealth(run: ActiveRun): Promise<void> {
    if (!run.healthBase || !this.isActive(run)) return;
    const [poll, client] = await Promise.all([
      this.dependencies.readPollHealth(run.healthBase),
      this.dependencies.readClientStatus(run.healthBase)
    ]);
    if (!this.isActive(run)) return;
    if (client?.metadataError && tunnelAuthenticationRejected('tunnel metadata fetch failed', client.metadataError)) {
      this.handleLine(run, JSON.stringify({
        msg: 'tunnel metadata fetch failed',
        error: client.metadataError
      }));
      return;
    }
    const lastSuccess = poll?.lastSuccessMs ?? null;
    if (lastSuccess !== null && this.dependencies.now() - lastSuccess <= POLL_FRESH_MS) {
      this.status = {
        ...this.status,
        state: 'connected',
        detail: 'Connected. ChatGPT can reach the PDF AI MCP connector through the secure tunnel.',
        runtimeVersion: client?.version ?? this.status.runtimeVersion,
        retryInMs: null
      };
      return;
    }
    if (poll && ((poll.errors ?? 0) > 0 || lastSuccess !== null)) {
      this.status = {
        ...this.status,
        state: 'offline',
        detail: 'The tunnel is locally ready but has not completed a recent OpenAI control-plane poll. It will keep retrying.',
        runtimeVersion: client?.version ?? this.status.runtimeVersion,
        retryInMs: null
      };
      return;
    }
    this.status = {
      ...this.status,
      state: 'connecting',
      detail: 'Tunnel client is locally ready; waiting for the first verified OpenAI poll…',
      runtimeVersion: client?.version ?? this.status.runtimeVersion,
      retryInMs: null
    };
  }

  private async replaceRun(run: ActiveRun, reason: string): Promise<void> {
    if (!this.isActive(run)) return;
    this.active = null;
    await this.retire(run);
    this.scheduleReconnect(run.generation, reason);
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (!this.isCurrentGeneration(generation) || !this.connectionIntent || this.reconnectTimer) return;
    this.attempts += 1;
    const delayMs = Math.min(
      this.timing.reconnectMaxMs,
      this.timing.reconnectBaseMs * Math.pow(2, Math.min(this.attempts - 1, 8))
    );
    this.status = {
      ...this.status,
      state: 'offline',
      detail: `${reason} Retrying automatically…`,
      retryInMs: delayMs
    };
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrentGeneration(generation) || !this.connectionIntent) return;
      this.status = {
        ...this.status,
        state: 'preparing-runtime',
        detail: 'Reconnecting the PDF AI secure tunnel…',
        retryInMs: null
      };
      this.startLaunch(generation, this.status.tunnelId);
    }, delayMs);
  }

  private startLaunch(generation: number, tunnelId: string): void {
    void this.launch(generation, tunnelId).catch(error => {
      if (!this.isCurrentGeneration(generation)) return;
      this.connectionIntent = false;
      this.status = {
        ...this.status,
        state: 'tunnel-unavailable',
        detail: error instanceof Error ? error.message : 'The tunnel could not be started.',
        retryInMs: null
      };
    });
  }

  private async retire(run: ActiveRun): Promise<void> {
    await this.dependencies.terminateProcess(run.child).catch(() => undefined);
    await fs.rm(run.healthDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async readHealthBase(filePath: string): Promise<string | null> {
    try {
      const value = (await fs.readFile(filePath, 'utf8')).trim().replace(/\/$/, '');
      return /^http:\/\/127\.0\.0\.1:\d+$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.generation === generation && this.connectionIntent;
  }

  private isActive(run: ActiveRun): boolean {
    return this.active === run && this.isCurrentGeneration(run.generation);
  }
}
