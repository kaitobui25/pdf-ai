import type { TunnelConnectionStatus } from '../shared/tunnel.js';

export const TUNNEL_STATE_LABEL: Record<TunnelConnectionStatus['state'], string> = {
  disconnected: 'Not connected',
  'preparing-runtime': 'Preparing',
  connecting: 'Connecting',
  connected: 'Connected',
  offline: 'Offline · retrying',
  'auth-failed': 'Sign-in failed',
  'tunnel-unavailable': 'Tunnel unavailable',
  disconnecting: 'Disconnecting'
};

export interface TunnelViewState {
  label: string;
  running: boolean;
  error: boolean;
}

export function tunnelViewState(state: TunnelConnectionStatus['state']): TunnelViewState {
  return {
    label: TUNNEL_STATE_LABEL[state],
    running: state === 'preparing-runtime'
      || state === 'connecting'
      || state === 'connected'
      || state === 'offline'
      || state === 'disconnecting',
    error: state === 'auth-failed' || state === 'tunnel-unavailable'
  };
}
