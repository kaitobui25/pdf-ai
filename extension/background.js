import { createBridgeClient } from './bridge-client.js';
import { createChatAutomation } from './automation.js';

const ALARM_NAME = 'pdf-ai-bridge-maintain';
const CHAT_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

const client = createBridgeClient({
  fetch: globalThis.fetch.bind(globalThis),
  localStorage: chrome.storage.local,
  sessionStorage: chrome.storage.session,
  extensionId: chrome.runtime.id
});

const automation = createChatAutomation({
  chromeApi: chrome,
  bridgeClient: client,
  localStorage: chrome.storage.local
});

let pumpFlight = null;

function scheduleMaintenance() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

async function injectContentIntoExistingChats() {
  if (!chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({ url: CHAT_PATTERNS }).catch(() => []);
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined);
  }
}

async function processBridgeCommand(command) {
  if (!command || typeof command !== 'object' || typeof command.id !== 'string') return;
  if (command.type === 'chat_send' || command.type === 'chat_cancel') {
    const result = command.type === 'chat_send'
      ? await automation.processCommand(command)
      : await automation.cancelCommand(command);
    await client.ackCommand({
      id: command.id,
      status: result.status === 'ok' ? 'ok' : 'failed',
      ...(result.error ? { error: result.error } : {})
    });
    return;
  }
  if (command.type === 'health_probe') {
    await client.ackCommand({ id: command.id, status: 'ok' });
    return;
  }
  await client.ackCommand({ id: command.id, status: 'failed', error: 'unsupported_command' });
}

async function pumpCommands() {
  if (pumpFlight) return pumpFlight;
  pumpFlight = (async () => {
    for (let pass = 0; pass < 8; pass++) {
      await client.drainAckOutbox();
      await automation.drainEvents();
      const next = await client.getNextCommand(20_000);
      if (!next?.ok) return next;
      const command = next.data?.command ?? null;
      if (!command) return next;
      await processBridgeCommand(command);
    }
    return { ok: true };
  })().finally(() => { pumpFlight = null; });
  return pumpFlight;
}

async function maintain() {
  await Promise.all([
    client.drainAckOutbox(),
    automation.drainEvents(),
    automation.restoreOwnedChats()
  ]);
  const health = await client.health();
  if (health.connected) void pumpCommands();
  return health;
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleMaintenance();
  void injectContentIntoExistingChats().then(() => maintain());
});

chrome.runtime.onStartup.addListener(() => {
  scheduleMaintenance();
  void maintain();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void maintain();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  let work;
  switch (message.type) {
    case 'pdf-ai:bridge-status':
      work = Promise.all([client.health(), automation.status()]).then(([bridge, chat]) => ({ ...bridge, chat }));
      break;
    case 'pdf-ai:bridge-reconnect':
      work = client.reconnect().then(async result => {
        if (result.connected) void pumpCommands();
        return result;
      });
      break;
    case 'pdf-ai:bridge-next-command':
      work = client.getNextCommand();
      break;
    case 'pdf-ai:bridge-ack':
      work = client.ackCommand(message.ack);
      break;
    case 'pdf-ai:automation-status':
      work = automation.status();
      break;
    default:
      work = automation.handleRuntimeMessage(message, sender);
      break;
  }

  void Promise.resolve(work).then(
    result => sendResponse(result ?? { ok: false, error: 'unsupported_message' }),
    error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  return true;
});

scheduleMaintenance();
void maintain();
