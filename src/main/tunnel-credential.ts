import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

export interface CredentialStorageStatus {
  available: boolean;
  detail: string | null;
}

export interface TunnelCredentialStore {
  status(): Promise<CredentialStorageStatus>;
  has(): Promise<boolean>;
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

interface SecretFile {
  version: 1;
  tunnelApiKey: string;
}

function normalizeCredential(value: string): string {
  return value.replace(/[\s\u0085\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g, '');
}

export class ElectronTunnelCredentialStore implements TunnelCredentialStore {
  private memoryOnly: string | null = null;

  constructor(private readonly filePath: string) {}

  async status(): Promise<CredentialStorageStatus> {
    try {
      if (safeStorage.isEncryptionAvailable()) return { available: true, detail: null };
    } catch {
      // Fall through to the memory-only explanation.
    }
    return {
      available: false,
      detail: 'Secure OS credential storage is unavailable. The tunnel key will stay in memory only until PDF-AI exits.'
    };
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  async get(): Promise<string | null> {
    if (this.memoryOnly) return this.memoryOnly;
    if (!(await this.status()).available) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as SecretFile;
      if (parsed.version !== 1 || typeof parsed.tunnelApiKey !== 'string' || !parsed.tunnelApiKey) return null;
      const plaintext = normalizeCredential(safeStorage.decryptString(Buffer.from(parsed.tunnelApiKey, 'base64')));
      return plaintext || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  async set(value: string): Promise<void> {
    const normalized = normalizeCredential(value);
    if (!normalized) throw new Error('Enter the restricted OpenAI tunnel API key.');
    const storage = await this.status();
    if (!storage.available) {
      this.memoryOnly = normalized;
      return;
    }
    const encrypted = safeStorage.encryptString(normalized).toString('base64');
    const payload: SecretFile = { version: 1, tunnelApiKey: encrypted };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    this.memoryOnly = null;
  }
}

export class MemoryTunnelCredentialStore implements TunnelCredentialStore {
  private value: string | null;

  constructor(value: string | null = null, private readonly secure = true) {
    this.value = value;
  }

  async status(): Promise<CredentialStorageStatus> {
    return {
      available: this.secure,
      detail: this.secure ? null : 'Secure storage unavailable; memory only.'
    };
  }

  async has(): Promise<boolean> {
    return this.value !== null;
  }

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string): Promise<void> {
    const normalized = normalizeCredential(value);
    if (!normalized) throw new Error('Enter the restricted OpenAI tunnel API key.');
    this.value = normalized;
  }
}
