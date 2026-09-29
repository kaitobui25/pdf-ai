import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  APP_NAME,
  BRIDGE_STATE_FILE,
  CHAT_STATE_FILE,
  CONFIG_FILE,
  LOCAL_LOG_FILE,
  SECRETS_FILE,
  TUNNEL_RUNTIME_FOLDER,
  USER_DATA_FOLDER
} from '../shared/constants.js';
import { registerIpc } from './ipc.js';
import { PdfDocumentEngine } from './pdf-document-engine.js';
import { startPdfMcpServer, type PdfMcpEndpoint } from './mcp.js';
import {
  JsonBridgeStateStore,
  startBrowserBridge,
  type BrowserBridge
} from './bridge.js';
import { JsonTunnelConfigStore } from './tunnel-config.js';
import { ElectronTunnelCredentialStore } from './tunnel-credential.js';
import { TunnelManager } from './tunnel-manager.js';
import { TunnelRuntimeProvider } from './tunnel-runtime.js';
import { ChatSessionManager, JsonChatStateStore } from './chat-session-manager.js';
import { LocalJsonLogger } from './local-log.js';

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_FOLDER));

let mainWindow: BrowserWindow | null = null;
const documentEngine = new PdfDocumentEngine();
let mcpEndpoint: PdfMcpEndpoint | null = null;
let browserBridge: BrowserBridge | null = null;
let tunnelManager: TunnelManager | null = null;
let chatManager: ChatSessionManager | null = null;
let localLogger: LocalJsonLogger | null = null;
let shutdownStarted = false;
let shutdownComplete = false;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  mainWindow = window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    mcpEndpoint = await startPdfMcpServer(documentEngine);
    const userData = app.getPath('userData');
    localLogger = new LocalJsonLogger(path.join(userData, LOCAL_LOG_FILE));
    tunnelManager = new TunnelManager(
      mcpEndpoint.url,
      new JsonTunnelConfigStore(path.join(userData, CONFIG_FILE)),
      new ElectronTunnelCredentialStore(path.join(userData, SECRETS_FILE)),
      new TunnelRuntimeProvider(path.join(userData, TUNNEL_RUNTIME_FOLDER))
    );
    await tunnelManager.initialize();
    chatManager = new ChatSessionManager(
      documentEngine,
      new JsonChatStateStore(path.join(userData, CHAT_STATE_FILE))
    );
    await chatManager.initialize();
    const chatSystemStatus = await chatManager.getSystemStatus();
    if (chatSystemStatus.recoveryNotice) localLogger.warn('chat_state_recovery', { recovered: true });
    registerIpc(documentEngine, tunnelManager, chatManager);
    browserBridge = await startBrowserBridge(
      new JsonBridgeStateStore(path.join(userData, BRIDGE_STATE_FILE)),
      {
        onEvents: events => chatManager!.acceptBridgeEvents(events),
        readDocumentChunk: (documentId, offset, limit) =>
          documentEngine.readDocumentChunk(documentId, offset, limit)
      }
    );
    chatManager.setBridge(browserBridge);
    console.info('PDF AI MCP: listening on 127.0.0.1:' + mcpEndpoint.port);
    console.info('PDF-AI browser bridge:', browserBridge.url);
    localLogger.info('app_ready', { mcpPort: mcpEndpoint.port, bridgePort: browserBridge.port });
    createWindow();
  }).catch(error => {
    console.error('PDF-AI startup failed:', error);
    app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    localLogger?.info('app_shutdown', { clean: true });
    void Promise.all([
      tunnelManager?.stop() ?? Promise.resolve(),
      browserBridge?.stop() ?? Promise.resolve(),
      mcpEndpoint?.stop() ?? Promise.resolve(),
      documentEngine.destroy(),
      localLogger?.flush() ?? Promise.resolve()
    ]).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
}
