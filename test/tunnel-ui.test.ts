import { describe, expect, it } from 'vitest';
import { tunnelViewState } from '../src/renderer/tunnel-ui.js';

describe('PDF-AI tunnel status projection', () => {
  it('projects the normal connection lifecycle into user-facing labels', () => {
    expect(tunnelViewState('disconnected')).toEqual({ label: 'Not connected', running: false, error: false });
    expect(tunnelViewState('preparing-runtime')).toEqual({ label: 'Preparing', running: true, error: false });
    expect(tunnelViewState('connecting')).toEqual({ label: 'Connecting', running: true, error: false });
    expect(tunnelViewState('connected')).toEqual({ label: 'Connected', running: true, error: false });
    expect(tunnelViewState('offline')).toEqual({ label: 'Offline · retrying', running: true, error: false });
    expect(tunnelViewState('disconnecting')).toEqual({ label: 'Disconnecting', running: true, error: false });
  });

  it('keeps terminal setup failures actionable instead of looking connected', () => {
    expect(tunnelViewState('auth-failed')).toEqual({ label: 'Sign-in failed', running: false, error: true });
    expect(tunnelViewState('tunnel-unavailable')).toEqual({ label: 'Tunnel unavailable', running: false, error: true });
  });
});
