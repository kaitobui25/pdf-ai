export const PDF_AI_APP_ID: 'pdf-ai';
export const PDF_AI_BRIDGE_PROTOCOL: 1;
export const PDF_AI_BRIDGE_PORTS: readonly [8875, 8876, 8877, 8878, 8879];
export const PDF_AI_LOCAL_STATE_KEY: 'pdfAiBridgeConnection';
export const PDF_AI_ACK_OUTBOX_KEY: 'pdfAiBridgeAckOutbox';

export interface BridgeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
}

export interface BridgeResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T | null;
  error?: string | null;
  pending?: number;
  port?: number;
  token?: string;
}

export interface BridgeHealth {
  ok: boolean;
  connected: boolean;
  appId: 'pdf-ai';
  protocol: 1;
  extensionId: string;
  port: number | null;
  pendingAcks: number;
  status: unknown;
  error: string | null;
}

export interface PdfAiBridgeClient {
  ackCommand(body: Record<string, unknown>): Promise<BridgeResult>;
  discover(): Promise<{ port: number; greeting: unknown } | null>;
  drainAckOutbox(): Promise<BridgeResult>;
  getDocumentChunk(documentId: string, offset: number, limit?: number): Promise<BridgeResult>;
  getNextCommand(waitMs?: number): Promise<BridgeResult>;
  getStatus(): Promise<BridgeResult>;
  health(): Promise<BridgeHealth>;
  pair(): Promise<BridgeResult>;
  postEvents(events: unknown[]): Promise<BridgeResult>;
  reconnect(): Promise<BridgeHealth>;
}

export function createBridgeClient(options: {
  fetch: typeof fetch;
  localStorage: BridgeStorageArea;
  sessionStorage: BridgeStorageArea;
  extensionId: string;
  now?: () => number;
}): PdfAiBridgeClient;
