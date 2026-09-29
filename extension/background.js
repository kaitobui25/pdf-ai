import { createBridgeClient } from './bridge-client.js';

const ALARM_NAME = 'pdf-ai-bridge-maintain';

const client = createBridgeClient({
  fetch: globalThis.fetch.bind(globalThis),
  localStorage: chrome.storage.local,
  sessionStorage: chrome.storage.session,
  extensionId: chrome.runtime.id
});

function scheduleMaintenance() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

async function maintain() {
  await client.drainAckOutbox();
  return client.health();
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleMaintenance();
  void maintain();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleMaintenance();
  void maintain();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void maintain();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  let work;
  switch (message.type) {
    case 'pdf-ai:bridge-status':
      work = client.health();
      break;
    case 'pdf-ai:bridge-reconnect':
      work = client.reconnect();
      break;
    case 'pdf-ai:bridge-next-command':
      work = client.getNextCommand();
      break;
    case 'pdf-ai:bridge-ack':
      work = client.ackCommand(message.ack);
      break;
    default:
      return false;
  }

  void Promise.resolve(work).then(
    result => sendResponse(result),
    error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  return true;
});

scheduleMaintenance();
void maintain();
