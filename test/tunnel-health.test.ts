import { describe, expect, it } from 'vitest';
import {
  parseClientStatus,
  parsePollHealth,
  readMetric,
  tunnelAuthenticationRejected,
  tunnelNetworkUnavailable
} from '../src/main/tunnel-health.js';

describe('PDF-AI tunnel health parsing', () => {
  it('sums labelled metrics and maps the last successful control-plane poll', () => {
    const metrics = [
      'commands_poll_last_successful_timestamp_seconds 123.5',
      'commands_poll_cycles_total 7',
      'commands_poll_errors_total{error_kind="network"} 2',
      'commands_poll_errors_total{error_kind="other"} 1'
    ].join('\n');
    expect(readMetric(metrics, 'commands_poll_errors_total')).toBe(3);
    expect(parsePollHealth(metrics)).toEqual({
      lastSuccessMs: 123_500,
      polls: 7,
      errors: 3
    });
  });

  it('reads only the main channel probe from tunnel-client status', () => {
    expect(parseClientStatus({
      version: '0.0.15',
      tunnel_metadata_error: '',
      channels: [
        { name: 'other', probe_status: 'failed' },
        { name: 'main', probe_status: 'ok' }
      ]
    })).toEqual({ version: '0.0.15', probe: 'ok', metadataError: null });
  });

  it('treats only control-plane 401/403 evidence as a credential rejection', () => {
    expect(tunnelAuthenticationRejected('local MCP probe failed', 'unexpected status 401', 401)).toBe(false);
    expect(tunnelAuthenticationRejected('random warning', '403 Forbidden')).toBe(false);
    expect(tunnelAuthenticationRejected('tunnel metadata fetch failed', 'unexpected status 401', 401)).toBe(true);
    expect(tunnelAuthenticationRejected('poll failed', 'controlplane client: 403 Forbidden')).toBe(true);
    expect(tunnelAuthenticationRejected('poll failed', 'unexpected status 503', 503)).toBe(false);
  });

  it('classifies network loss only when it belongs to a control-plane poll', () => {
    expect(tunnelNetworkUnavailable('poll failed: dial tcp: i/o timeout')).toBe(true);
    expect(tunnelNetworkUnavailable('local MCP probe failed: i/o timeout')).toBe(false);
  });
});
