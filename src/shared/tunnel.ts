export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

export type TunnelConnectionState =
  | 'disconnected'
  | 'preparing-runtime'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable'
  | 'disconnecting';

export interface TunnelConnectionStatus {
  state: TunnelConnectionState;
  detail: string;
  tunnelId: string;
  hasCredential: boolean;
  secureStorageAvailable: boolean;
  secureStorageDetail: string | null;
  runtimeVersion: string | null;
  retryInMs: number | null;
}

export interface TunnelConnectInput {
  tunnelId: string;
  /** Optional replacement credential. Empty means reuse the stored/in-memory credential. */
  apiKey?: string;
}
