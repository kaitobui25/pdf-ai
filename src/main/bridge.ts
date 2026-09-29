import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  APP_ID,
  BRIDGE_ID,
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL,
  type BridgePort
} from '../shared/constants.js';

const BRIDGE_VERSION = '0.1.0';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_COMMANDS = 32;
const MAX_RECEIPTS = 64;
const MAX_COMMAND_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT = 240;
const RATE_WINDOW_MS = 60_000;

export interface BridgeCommand {
  id: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface BridgeReceipt {
  id: string;
  status: 'ok' | 'failed';
  error?: string;
  acknowledgedAt: number;
}

export interface BridgeCredential {
  token: string;
  extensionId: string;
}

export interface BridgeDurableState {
  credential: BridgeCredential | null;
  commands: BridgeCommand[];
  receipts: BridgeReceipt[];
  wakeGeneration: number;
}

export interface BridgeStateStore {
  load(): Promise<BridgeDurableState | null>;
  save(state: BridgeDurableState): Promise<void>;
}

export class MemoryBridgeStateStore implements BridgeStateStore {
  private state: BridgeDurableState | null = null;

  async load(): Promise<BridgeDurableState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: BridgeDurableState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class JsonBridgeStateStore implements BridgeStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BridgeDurableState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<BridgeDurableState>;
      if (!parsed || typeof parsed !== 'object') return null;
      const credential = parsed.credential &&
        typeof parsed.credential.token === 'string' &&
        typeof parsed.credential.extensionId === 'string'
        ? {
            token: parsed.credential.token,
            extensionId: parsed.credential.extensionId
          }
        : null;
      const commands = Array.isArray(parsed.commands)
        ? parsed.commands.filter(isBridgeCommand).slice(-MAX_COMMANDS)
        : [];
      const receipts = Array.isArray(parsed.receipts)
        ? parsed.receipts.filter(isBridgeReceipt).slice(-MAX_RECEIPTS)
        : [];
      const wakeGeneration = Number.isInteger(parsed.wakeGeneration) && (parsed.wakeGeneration ?? 0) >= 0
        ? parsed.wakeGeneration as number
        : 0;
      return { credential, commands, receipts, wakeGeneration };
    } catch {
      return null;
    }
  }

  async save(state: BridgeDurableState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp-' + randomBytes(6).toString('hex');
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export interface BrowserBridge {
  port: BridgePort;
  url: string;
  enqueueCommand(type: string, payload: unknown): Promise<BridgeCommand>;
  stop(): Promise<void>;
}

export interface BrowserBridgeOptions {
  ports?: readonly BridgePort[];
  rateLimit?: number;
  now?: () => number;
  onEvents?: (events: unknown[]) => Promise<unknown>;
  readDocumentChunk?: (documentId: string, offset: number, limit: number) => Promise<unknown>;
}

function emptyState(): BridgeDurableState {
  return {
    credential: null,
    commands: [],
    receipts: [],
    wakeGeneration: 0
  };
}

function isBridgeCommand(value: unknown): value is BridgeCommand {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BridgeCommand>;
  return typeof item.id === 'string' &&
    typeof item.type === 'string' &&
    Number.isFinite(item.createdAt);
}

function isBridgeReceipt(value: unknown): value is BridgeReceipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BridgeReceipt>;
  return typeof item.id === 'string' &&
    (item.status === 'ok' || item.status === 'failed') &&
    Number.isFinite(item.acknowledgedAt);
}

function json(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
    ...corsHeaders(req)
  });
  res.end(body);
}

function originOf(req: IncomingMessage): string | null {
  const raw = req.headers.origin;
  return typeof raw === 'string' ? raw : null;
}

function chromeExtensionOrigin(value: string | null): value is string {
  return value !== null && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
}

function extensionIdValid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = originOf(req);
  if (!chromeExtensionOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers':
      'authorization,content-type,x-pdf-ai-app-id,x-pdf-ai-protocol,x-pdf-ai-extension-id',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BridgeHttpError(413, 'payload_too_large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new BridgeHttpError(413, 'payload_too_large');
    chunks.push(bytes);
  }
  try {
    return total === 0 ? {} : JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new BridgeHttpError(400, 'invalid_json');
  }
}

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requestedProtocol(req: IncomingMessage): number | null {
  const raw = req.headers['x-pdf-ai-protocol'];
  if (typeof raw !== 'string') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : null;
}

function requestedApp(req: IncomingMessage): string | null {
  const raw = req.headers['x-pdf-ai-app-id'];
  return typeof raw === 'string' ? raw : null;
}

function requestedExtension(req: IncomingMessage): string | null {
  const raw = req.headers['x-pdf-ai-extension-id'];
  return typeof raw === 'string' ? raw : null;
}

function validatePortCandidates(ports: readonly BridgePort[]): readonly BridgePort[] {
  if (!ports.length || ports.some(port => !BRIDGE_PORTS.includes(port))) {
    throw new Error('Browser bridge ports must stay inside 8875-8879.');
  }
  return [...new Set(ports)];
}

async function listen(server: http.Server, port: BridgePort): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startBrowserBridge(
  store: BridgeStateStore,
  options: BrowserBridgeOptions = {}
): Promise<BrowserBridge> {
  const ports = validatePortCandidates(options.ports ?? BRIDGE_PORTS);
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  if (!Number.isInteger(rateLimit) || rateLimit < 1) throw new Error('Bridge rate limit is invalid.');
  let state = await store.load() ?? emptyState();
  let mutationQueue = Promise.resolve();
  let listeningPort: BridgePort | null = null;
  let stopping: Promise<void> | null = null;
  const requestTimes = new Map<string, number[]>();
  const commandWaiters = new Set<() => void>();

  const notifyCommandWaiters = (): void => {
    for (const wake of [...commandWaiters]) wake();
    commandWaiters.clear();
  };

  const waitForCommand = (generation: number, waitMs: number): Promise<void> => {
    if (state.commands.length || state.wakeGeneration !== generation || waitMs <= 0) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        commandWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      commandWaiters.add(finish);
    });
  };

  const mutateState = <T>(
    mutation: (current: BridgeDurableState) => { next: BridgeDurableState; result: T }
  ): Promise<T> => {
    const operation = mutationQueue.then(async () => {
      const { next, result } = mutation(state);
      await store.save(next);
      state = next;
      return result;
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const rateKey = (req: IncomingMessage): string =>
    originOf(req) ?? req.socket.remoteAddress ?? 'loopback';

  const admitted = (req: IncomingMessage): boolean => {
    const key = rateKey(req);
    const cutoff = now() - RATE_WINDOW_MS;
    const recent = (requestTimes.get(key) ?? []).filter(value => value > cutoff);
    if (recent.length >= rateLimit) {
      requestTimes.set(key, recent);
      return false;
    }
    recent.push(now());
    requestTimes.set(key, recent);
    return true;
  };

  const requireProtected = (req: IncomingMessage): BridgeCredential => {
    const credential = state.credential;
    if (!credential) throw new BridgeHttpError(401, 'not_paired');
    if (requestedApp(req) !== APP_ID) throw new BridgeHttpError(409, 'wrong_app');
    if (requestedProtocol(req) !== BRIDGE_PROTOCOL) throw new BridgeHttpError(426, 'wrong_protocol');
    if (requestedExtension(req) !== credential.extensionId) {
      throw new BridgeHttpError(403, 'wrong_extension');
    }
    const origin = originOf(req);
    if (origin !== null && origin !== 'chrome-extension://' + credential.extensionId) {
      throw new BridgeHttpError(403, 'wrong_origin');
    }
    const token = bearerToken(req);
    if (!token || !constantTimeEqual(token, credential.token)) {
      throw new BridgeHttpError(401, 'invalid_token');
    }
    return credential;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
        throw new BridgeHttpError(403, 'loopback_only');
      }
      if (!admitted(req)) throw new BridgeHttpError(429, 'rate_limited');
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = requestUrl.pathname;

      if (req.method === 'OPTIONS') {
        const origin = originOf(req);
        if (!chromeExtensionOrigin(origin)) throw new BridgeHttpError(403, 'wrong_origin');
        res.writeHead(204, { connection: 'close', ...corsHeaders(req) });
        res.end();
        return;
      }

      if (route === '/hello' && req.method === 'GET') {
        const origin = originOf(req);
        if (origin !== null && !chromeExtensionOrigin(origin)) {
          throw new BridgeHttpError(403, 'wrong_origin');
        }
        json(req, res, 200, {
          appId: APP_ID,
          bridgeId: BRIDGE_ID,
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          port: listeningPort
        });
        return;
      }

      if (route === '/pair' && req.method === 'POST') {
        if (requestedApp(req) !== APP_ID) throw new BridgeHttpError(409, 'wrong_app');
        if (requestedProtocol(req) !== BRIDGE_PROTOCOL) throw new BridgeHttpError(426, 'wrong_protocol');
        const body = await readJsonBody(req) as {
          appId?: unknown;
          protocol?: unknown;
          extensionId?: unknown;
          rotate?: unknown;
        };
        if (body.appId !== APP_ID) throw new BridgeHttpError(409, 'wrong_app');
        if (body.protocol !== BRIDGE_PROTOCOL) throw new BridgeHttpError(426, 'wrong_protocol');
        if (!extensionIdValid(body.extensionId)) throw new BridgeHttpError(400, 'invalid_extension_id');
        const origin = originOf(req);
        if (origin !== null && origin !== 'chrome-extension://' + body.extensionId) {
          throw new BridgeHttpError(403, 'wrong_origin');
        }
        if (state.credential && state.credential.extensionId !== body.extensionId) {
          throw new BridgeHttpError(409, 'already_paired');
        }
        if (body.rotate === true && state.credential) {
          requireProtected(req);
          await mutateState(current => ({
            next: {
              ...structuredClone(current),
              credential: {
                extensionId: body.extensionId as string,
                token: randomBytes(32).toString('base64url')
              }
            },
            result: undefined
          }));
        } else if (!state.credential) {
          await mutateState(current => ({
            next: {
              ...structuredClone(current),
              credential: {
                extensionId: body.extensionId as string,
                token: randomBytes(32).toString('base64url')
              }
            },
            result: undefined
          }));
        }
        const credential = state.credential;
        if (!credential) throw new BridgeHttpError(500, 'pairing_not_persisted');
        json(req, res, 200, {
          appId: APP_ID,
          protocol: BRIDGE_PROTOCOL,
          token: credential.token
        });
        return;
      }

      requireProtected(req);
      if (route === '/status' && req.method === 'GET') {
        json(req, res, 200, {
          ok: true,
          appId: APP_ID,
          protocol: BRIDGE_PROTOCOL,
          port: listeningPort,
          pendingCommands: state.commands.length,
          wakeGeneration: state.wakeGeneration
        });
        return;
      }

      if (route === '/commands/next' && req.method === 'GET') {
        const waitRaw = Number.parseInt(requestUrl.searchParams.get('wait') ?? '0', 10);
        const waitMs = Number.isFinite(waitRaw) ? Math.max(0, Math.min(25_000, waitRaw)) : 0;
        if (!state.commands.length && waitMs > 0) {
          await waitForCommand(state.wakeGeneration, waitMs);
        }
        json(req, res, 200, {
          command: state.commands[0] ?? null,
          wakeGeneration: state.wakeGeneration
        });
        return;
      }

      if (route === '/events' && req.method === 'POST') {
        if (!options.onEvents) throw new BridgeHttpError(503, 'events_unavailable');
        const body = await readJsonBody(req) as { events?: unknown };
        if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 64) {
          throw new BridgeHttpError(400, 'invalid_event_batch');
        }
        const receipts = await options.onEvents(body.events);
        json(req, res, 200, { receipts });
        return;
      }

      const documentRoute = /^\/documents\/([^/]+)\/file$/.exec(route);
      if (documentRoute && req.method === 'GET') {
        if (!options.readDocumentChunk) throw new BridgeHttpError(503, 'document_bytes_unavailable');
        let documentId: string;
        try {
          documentId = decodeURIComponent(documentRoute[1]!);
        } catch {
          throw new BridgeHttpError(400, 'invalid_document_id');
        }
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(documentId)) {
          throw new BridgeHttpError(400, 'invalid_document_id');
        }
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') ?? '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? String(256 * 1024), 10);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1024) {
          throw new BridgeHttpError(400, 'invalid_document_range');
        }
        try {
          json(req, res, 200, await options.readDocumentChunk(documentId, offset, limit));
        } catch {
          throw new BridgeHttpError(409, 'document_unavailable');
        }
        return;
      }

      if (route === '/commands/ack' && req.method === 'POST') {
        const body = await readJsonBody(req) as {
          id?: unknown;
          status?: unknown;
          error?: unknown;
        };
        if (typeof body.id !== 'string' || !/^[a-f0-9]{24}$/.test(body.id)) {
          throw new BridgeHttpError(400, 'invalid_command_id');
        }
        if (body.status !== 'ok' && body.status !== 'failed') {
          throw new BridgeHttpError(400, 'invalid_command_status');
        }
        if (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 1000)) {
          throw new BridgeHttpError(400, 'invalid_command_error');
        }
        const prior = state.receipts.find(receipt => receipt.id === body.id);
        if (prior) {
          json(req, res, 200, { receipt: prior });
          return;
        }
        const receipt = await mutateState(current => {
          const existing = current.receipts.find(candidate => candidate.id === body.id);
          if (existing) return { next: current, result: existing };
          const index = current.commands.findIndex(command => command.id === body.id);
          if (index < 0) throw new BridgeHttpError(404, 'command_not_found');
          const next = structuredClone(current);
          next.commands.splice(index, 1);
          const created: BridgeReceipt = {
            id: body.id as string,
            status: body.status as 'ok' | 'failed',
            ...(body.error ? { error: body.error as string } : {}),
            acknowledgedAt: now()
          };
          next.receipts.push(created);
          if (next.receipts.length > MAX_RECEIPTS) {
            next.receipts.splice(0, next.receipts.length - MAX_RECEIPTS);
          }
          return { next, result: created };
        });
        json(req, res, 200, { receipt });
        return;
      }

      throw new BridgeHttpError(404, 'not_found');
    })().catch(error => {
      if (res.writableEnded) return;
      const handled = error instanceof BridgeHttpError
        ? error
        : new BridgeHttpError(500, 'internal_error');
      json(req, res, handled.status, { error: handled.code });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  for (const candidate of ports) {
    if (await listen(server, candidate)) {
      listeningPort = candidate;
      break;
    }
  }
  if (listeningPort === null) {
    server.close();
    throw new Error('All PDF-AI browser bridge ports 8875-8879 are in use.');
  }

  return {
    port: listeningPort,
    url: 'http://127.0.0.1:' + listeningPort,
    enqueueCommand: async (type: string, payload: unknown): Promise<BridgeCommand> => {
      if (!/^[a-z0-9_]{1,64}$/.test(type)) throw new Error('Bridge command type is invalid.');
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        throw new Error('Bridge command payload must be JSON serializable.');
      }
      if (serialized === undefined) {
        throw new Error('Bridge command payload must be a JSON value.');
      }
      if (Buffer.byteLength(serialized) > MAX_COMMAND_PAYLOAD_BYTES) {
        throw new Error('Bridge command payload is too large.');
      }
      const command: BridgeCommand = {
        id: randomBytes(12).toString('hex'),
        type,
        payload,
        createdAt: now()
      };
      const published = await mutateState(current => {
        if (current.commands.length >= MAX_COMMANDS) throw new Error('Bridge command queue is full.');
        const next = structuredClone(current);
        next.commands.push(command);
        next.wakeGeneration++;
        return { next, result: command };
      });
      notifyCommandWaiters();
      return published;
    },
    stop: () => {
      if (stopping) return stopping;
      stopping = (async () => {
        notifyCommandWaiters();
        await mutationQueue;
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      })();
      return stopping;
    }
  };
}
