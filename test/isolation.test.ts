import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_ID,
  BRIDGE_STATE_FILE,
  BRIDGE_ID,
  BRIDGE_PORTS,
  CHAT_STATE_FILE,
  CONFIG_FILE,
  LOCAL_LOG_FILE,
  MCP_CONNECTOR_NAME,
  SECRETS_FILE,
  SESSIONS_FOLDER,
  TUNNEL_RUNTIME_FOLDER,
  USER_DATA_FOLDER
} from '../src/shared/constants.js';
import {
  PDF_AI_ACK_OUTBOX_KEY,
  PDF_AI_LOCAL_STATE_KEY
} from '../extension/bridge-client.js';
import {
  PDF_AI_EVENT_OUTBOX_KEY,
  PDF_AI_OWNED_CHATS_KEY
} from '../extension/automation.js';

async function productionTextFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await productionTextFiles(full));
    else if (/\.(?:ts|js|json|d\.ts)$/i.test(entry.name)) output.push(full);
  }
  return output;
}

describe('PDF-AI isolation', () => {
  it('uses dedicated product identities', () => {
    expect(APP_ID).toBe('pdf-ai');
    expect(BRIDGE_ID).toBe('pdf-ai');
    expect(MCP_CONNECTOR_NAME).toBe('PDF AI');
    expect(USER_DATA_FOLDER).toBe('PDF-AI');
    expect(CONFIG_FILE).toMatch(/^pdf-ai\./);
    expect(SECRETS_FILE).toMatch(/^pdf-ai\./);
    expect(SESSIONS_FOLDER).toMatch(/^pdf-ai-/);
    expect(BRIDGE_STATE_FILE).toMatch(/^pdf-ai\./);
    expect(TUNNEL_RUNTIME_FOLDER).toMatch(/^pdf-ai-/);
    expect(CHAT_STATE_FILE).toMatch(/^pdf-ai\./);
    expect(LOCAL_LOG_FILE).toMatch(/^pdf-ai\./);
    expect(TUNNEL_RUNTIME_FOLDER.toLowerCase()).not.toContain('chat-on-steroids');
    expect([PDF_AI_LOCAL_STATE_KEY, PDF_AI_ACK_OUTBOX_KEY, PDF_AI_OWNED_CHATS_KEY, PDF_AI_EVENT_OUTBOX_KEY])
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^pdfAi/),
        expect.stringMatching(/^pdfAi/),
        expect.stringMatching(/^pdfAi/),
        expect.stringMatching(/^pdfAi/)
      ]));
  });

  it('only uses the dedicated bridge port range', () => {
    expect(BRIDGE_PORTS).toEqual([8875, 8876, 8877, 8878, 8879]);
    const forbidden = new Set([8765, 8766, 8767, 8768, 8769]);
    for (const port of BRIDGE_PORTS) {
      expect(port).toBeGreaterThanOrEqual(8875);
      expect(port).toBeLessThanOrEqual(8879);
      expect(forbidden.has(port)).toBe(false);
    }
  });

  it('production source contains no CoS bridge ports, runtime names, or userData paths', async () => {
    const files = [
      ...await productionTextFiles(path.join(process.cwd(), 'src')),
      ...await productionTextFiles(path.join(process.cwd(), 'extension'))
    ];
    const forbidden = /(?:127\.0\.0\.1:(?:8765|8766|8767|8768|8769)|\b(?:8765|8766|8767|8768|8769)\b|chat-on-steroids|Chat On Steroids)/i;
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(forbidden);
    }
  });
});
