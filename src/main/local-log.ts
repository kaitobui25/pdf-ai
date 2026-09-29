import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 512 * 1024;
const FORBIDDEN_FIELD = /(?:api.?key|credential|secret|token|prompt|text|base64|bytes|file.?path|mcp.*url|authorization)/i;

export type LocalLogLevel = 'info' | 'warn' | 'error';

function scrubString(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/http:\/\/127\.0\.0\.1:\d+\/mcp\/pdf-ai\/[^\s"']+/gi, 'http://127.0.0.1:[port]/mcp/pdf-ai/[redacted]')
    .replace(/\b[A-Za-z]:\\[^\r\n"']+/g, '[local-path]')
    .slice(0, 300);
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') output[key] = scrubString(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 20).map(item =>
      typeof item === 'string' ? scrubString(item) : (typeof item === 'number' || typeof item === 'boolean' ? item : '[object]')
    );
    else output[key] = '[object]';
  }
  return output;
}

export class LocalJsonLogger {
  private queue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES
  ) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.enqueue('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.enqueue('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.enqueue('error', event, fields);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(level: LocalLogLevel, event: string, fields: Record<string, unknown>): void {
    const record = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event: scrubString(event).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120),
      ...sanitizeFields(fields)
    }) + '\n';
    this.queue = this.queue.then(() => this.write(record)).catch(() => undefined);
  }

  private async write(record: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let size = 0;
    try { size = (await stat(this.filePath)).size; } catch { /* New log. */ }
    if (size + Buffer.byteLength(record) > this.maxBytes) {
      const backup = this.filePath + '.1';
      await unlink(backup).catch(() => undefined);
      await rename(this.filePath, backup).catch(() => undefined);
      size = 0;
    }
    if (size === 0) await writeFile(this.filePath, record, { encoding: 'utf8', mode: 0o600 });
    else {
      const existing = await readFile(this.filePath, 'utf8');
      await writeFile(this.filePath, existing + record, { encoding: 'utf8', mode: 0o600 });
    }
  }
}
