import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TUNNEL_ID_PATTERN } from '../shared/tunnel.js';

export interface TunnelConfig {
  tunnelId: string;
}

export interface TunnelConfigStore {
  load(): Promise<TunnelConfig>;
  save(config: TunnelConfig): Promise<void>;
}

export class JsonTunnelConfigStore implements TunnelConfigStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<TunnelConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tunnelId: '' };
      const tunnelId = (raw as Record<string, unknown>)['tunnelId'];
      return {
        tunnelId: typeof tunnelId === 'string' && TUNNEL_ID_PATTERN.test(tunnelId) ? tunnelId : ''
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tunnelId: '' };
      return { tunnelId: '' };
    }
  }

  save(config: TunnelConfig): Promise<void> {
    if (config.tunnelId !== '' && !TUNNEL_ID_PATTERN.test(config.tunnelId)) {
      return Promise.reject(new Error('Tunnel ID must look like tunnel_ followed by 32 lowercase hex characters.'));
    }
    const run = this.mutation.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = this.filePath + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ tunnelId: config.tunnelId }, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600
      });
      await fs.rename(temporary, this.filePath);
    });
    this.mutation = run.catch(() => undefined);
    return run;
  }
}

export class MemoryTunnelConfigStore implements TunnelConfigStore {
  private config: TunnelConfig;

  constructor(initial: TunnelConfig = { tunnelId: '' }) {
    this.config = { ...initial };
  }

  async load(): Promise<TunnelConfig> {
    return { ...this.config };
  }

  async save(config: TunnelConfig): Promise<void> {
    this.config = { ...config };
  }
}
