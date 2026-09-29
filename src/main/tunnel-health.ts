export const POLL_FRESH_MS = 95_000;

export interface TunnelPollHealth {
  lastSuccessMs: number | null;
  polls: number | null;
  errors: number | null;
}

export interface TunnelClientStatus {
  version: string | null;
  probe: string | null;
  metadataError: string | null;
}

export function readMetric(text: string, name: string): number | null {
  let total: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(name)) continue;
    const rest = trimmed.slice(name.length);
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '{') continue;
    const sample = rest.replace(/^\{[^}]*\}/, '').trim().split(/\s+/)[0];
    if (!sample) continue;
    const value = Number(sample);
    if (!Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

export function parsePollHealth(metrics: string): TunnelPollHealth {
  const seconds = readMetric(metrics, 'commands_poll_last_successful_timestamp_seconds');
  return {
    lastSuccessMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    polls: readMetric(metrics, 'commands_poll_cycles_total'),
    errors: readMetric(metrics, 'commands_poll_errors_total')
  };
}

export function parseClientStatus(raw: unknown): TunnelClientStatus {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const channels = Array.isArray(object['channels']) ? object['channels'] : [];
  const main = channels.find(value => (
    value !== null
    && typeof value === 'object'
    && (value as Record<string, unknown>)['name'] === 'main'
  )) as Record<string, unknown> | undefined;
  const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
  return {
    version: text(object['version']),
    probe: text(main?.['probe_status']),
    metadataError: text(object['tunnel_metadata_error'])
  };
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal, headers: { accept: '*/*' } });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTunnelReady(baseUrl: string, timeoutMs = 3_000): Promise<boolean> {
  return (await fetchText(`${baseUrl}/readyz`, timeoutMs)) !== null;
}

export async function readTunnelPollHealth(baseUrl: string, timeoutMs = 3_000): Promise<TunnelPollHealth | null> {
  const metrics = await fetchText(`${baseUrl}/metrics`, timeoutMs);
  if (metrics === null || readMetric(metrics, 'commands_poll_last_successful_timestamp_seconds') === null) return null;
  return parsePollHealth(metrics);
}

export async function readTunnelClientStatus(baseUrl: string, timeoutMs = 3_000): Promise<TunnelClientStatus | null> {
  const response = await fetchText(`${baseUrl}/api/status`, timeoutMs);
  if (response === null) return null;
  try {
    return parseClientStatus(JSON.parse(response));
  } catch {
    return null;
  }
}

export function tunnelAuthenticationRejected(
  message: string,
  error = '',
  statusCode?: unknown
): boolean {
  const controlPlane = /^(?:poll failed(?:;\s*backing off)?|tunnel metadata fetch failed)$/i.test(message)
    || /\bcontrolplane (?:client|responder):/i.test(error);
  if (!controlPlane) return false;
  if (typeof statusCode === 'number') return statusCode === 401 || statusCode === 403;
  return /\b(?:(?:unexpected status(?: code)?|HTTP)\s*:?\s*(?:401|403)|401\s+Unauthorized|403\s+Forbidden|unauthorized|forbidden|invalid[_ ]api[_ ]key|tunnel_use_forbidden)\b/i.test(error);
}

export function tunnelNetworkUnavailable(value: string): boolean {
  return /\bpoll (?:failed|timed out)/i.test(value)
    && /no such host|dial tcp|i\/o timeout|timed out|context deadline exceeded|connection (?:was )?(?:aborted|refused|reset)|network is (?:unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i.test(value);
}
