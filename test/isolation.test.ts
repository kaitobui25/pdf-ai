import { describe, expect, it } from 'vitest';
import {
  APP_ID,
  BRIDGE_STATE_FILE,
  BRIDGE_ID,
  BRIDGE_PORTS,
  CONFIG_FILE,
  MCP_CONNECTOR_NAME,
  SECRETS_FILE,
  SESSIONS_FOLDER,
  USER_DATA_FOLDER
} from '../src/shared/constants.js';

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
});
