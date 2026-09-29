import { ipcMain } from 'electron';
import {
  APP_ID,
  APP_NAME,
  BRIDGE_ID,
  BRIDGE_PORTS,
  MCP_CONNECTOR_NAME
} from '../shared/constants.js';
import type { RuntimeInfo } from '../shared/api.js';

export function registerIpc(): void {
  ipcMain.handle('runtime:info', (): RuntimeInfo => ({
    appName: APP_NAME,
    appId: APP_ID,
    bridgeId: BRIDGE_ID,
    bridgePorts: BRIDGE_PORTS,
    mcpConnectorName: MCP_CONNECTOR_NAME
  }));
}

