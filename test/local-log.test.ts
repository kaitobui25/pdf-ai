import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalJsonLogger } from '../src/main/local-log.js';

const temporary = new Set<string>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-log-test-'));
  temporary.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PDF-AI structured local logging', () => {
  it('redacts secrets/content/local paths and keeps retention bounded', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'pdf-ai.log.jsonl');
    const logger = new LocalJsonLogger(filePath, 700);
    logger.info('test_event_sk-secret-value', {
      apiKey: 'sk-secret-value',
      prompt: 'private user question',
      filePath: 'C:\\Users\\person\\private.pdf',
      detail: 'failed at http://127.0.0.1:5555/mcp/pdf-ai/super-secret-route for C:\\private\\paper.pdf',
      state: 'offline'
    });
    await logger.flush();
    const redacted = await readFile(filePath, 'utf8');
    expect(redacted).not.toContain('sk-secret-value');
    expect(redacted).not.toContain('private user question');
    expect(redacted).not.toContain('super-secret-route');
    expect(redacted).not.toContain('C:\\Users\\person');
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain('redacted-key');

    for (let index = 0; index < 20; index++) logger.info('bounded_event', { index, state: 'connected' });
    await logger.flush();

    const current = await readFile(filePath, 'utf8');
    const backup = await readFile(filePath + '.1', 'utf8');
    const combined = current + backup;
    expect(combined).not.toContain('sk-secret-value');
    expect(combined).not.toContain('private user question');
    expect(combined).not.toContain('super-secret-route');
    expect(combined).not.toContain('C:\\Users\\person');
    expect((await stat(filePath)).size).toBeLessThanOrEqual(700);
    expect((await stat(filePath + '.1')).size).toBeLessThanOrEqual(700);
  });
});
