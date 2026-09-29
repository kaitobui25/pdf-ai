export const APP_ID = 'pdf-ai' as const;
export const APP_NAME = 'PDF-AI' as const;
export const USER_DATA_FOLDER = 'PDF-AI' as const;
export const CONFIG_FILE = 'pdf-ai.config.json' as const;
export const SECRETS_FILE = 'pdf-ai.secrets.json' as const;
export const SESSIONS_FOLDER = 'pdf-ai-sessions' as const;

export const BRIDGE_ID = 'pdf-ai' as const;
export const BRIDGE_PROTOCOL = 1 as const;
export const BRIDGE_PORTS = [8875, 8876, 8877, 8878, 8879] as const;
export type BridgePort = (typeof BRIDGE_PORTS)[number];

export const MCP_SERVER_NAME = 'pdf-ai-mcp' as const;
export const MCP_CONNECTOR_NAME = 'PDF AI' as const;
export const MCP_PROTOCOL_VERSION = 1 as const;

export const MAX_PDF_BYTES = 128 * 1024 * 1024;
export const MAX_MCP_TEXT_CHARS = 200_000;
export const MAX_RENDER_PIXELS = 16 * 1024 * 1024;

