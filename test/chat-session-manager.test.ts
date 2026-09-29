import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatSessionManager,
  JsonChatStateStore,
  MemoryChatStateStore
} from '../src/main/chat-session-manager.js';
import { PdfDocumentEngine } from '../src/main/pdf-document-engine.js';
import type { BridgeCommand } from '../src/main/bridge.js';

const temporary = new Set<string>();
const engines = new Set<PdfDocumentEngine>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-chat-test-'));
  temporary.add(directory);
  return directory;
}

async function samplePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.drawText(text, { x: 36, y: 240, size: 18, font });
  return pdf.save();
}

function engine(): PdfDocumentEngine {
  const value = new PdfDocumentEngine();
  engines.add(value);
  return value;
}

function fakeBridge(commands: BridgeCommand[]) {
  return {
    enqueueCommand: async (type: string, payload: unknown): Promise<BridgeCommand> => {
      const command: BridgeCommand = {
        id: (commands.length + 1).toString(16).padStart(24, '0'),
        type,
        payload,
        createdAt: Date.now()
      };
      commands.push(command);
      return command;
    }
  };
}

afterEach(async () => {
  await Promise.all([...engines].map(value => value.destroy()));
  engines.clear();
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PDF-AI chat session manager', () => {
  it('durably frames one owned input and correlates only exact conversation events', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'paper.pdf');
    await writeFile(filePath, await samplePdf('Evidence on page one'));
    const documents = engine();
    const opened = await documents.openFile(filePath);
    documents.setSelection(opened.documentId, opened.viewEpoch, 1, {
      text: 'Evidence', startPage: 1, endPage: 1
    });
    const commands: BridgeCommand[] = [];
    const store = new MemoryChatStateStore();
    const manager = new ChatSessionManager(documents, store, fakeBridge(commands));

    const started = await manager.send({
      documentId: opened.documentId,
      text: 'Explain this selection',
      scope: 'selection',
      attachDocument: true
    });
    expect(started.state).toBe('sending');
    expect(started.pendingInputId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('chat_send');
    const payload = commands[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId: null,
      attachDocument: true
    });
    expect(String(payload.prompt)).toContain(`[[PDF-AI:${started.sessionId}:${started.pendingInputId}]]`);
    expect(String(payload.prompt)).toContain('pdf_get_selection');
    expect(JSON.stringify(payload)).not.toContain(filePath);

    const conversationId = '12345678-abcd-4abc-8abc-1234567890ab';
    const wrong = await manager.acceptBridgeEvents([{
      eventId: 'wrong-conversation-1',
      kind: 'input_sent',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      messageId: 'user-1',
      time: Date.now()
    }]);
    expect(wrong[0]).toMatchObject({ status: 'ok' });

    const conflict = await manager.acceptBridgeEvents([{
      eventId: 'wrong-conversation-2',
      kind: 'assistant_message',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId,
      messageId: 'assistant-wrong',
      text: 'wrong',
      final: true,
      time: Date.now()
    }]);
    expect(conflict[0]).toMatchObject({ status: 'failed', error: 'conversation_ownership_mismatch' });

    const acceptedConversation = (await manager.getSession(opened.documentId))?.conversationId;
    expect(acceptedConversation).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const final = await manager.acceptBridgeEvents([{
      eventId: 'assistant-final-1',
      kind: 'assistant_message',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId: acceptedConversation,
      messageId: 'assistant-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      text: `The evidence is on pdf://${opened.documentId}/page/1.`,
      final: true,
      time: Date.now()
    }]);
    expect(final[0]).toMatchObject({ status: 'ok' });
    const completed = await manager.getSession(opened.documentId);
    expect(completed).toMatchObject({ state: 'complete', pendingInputId: null });
    expect(completed?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      final: true,
      messageId: 'assistant-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      pageReferences: [{ documentId: opened.documentId, page: 1 }]
    });

    const replay = await manager.acceptBridgeEvents([{
      eventId: 'assistant-final-1',
      kind: 'assistant_message',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId: acceptedConversation,
      messageId: 'assistant-1',
      text: 'duplicate should be ignored',
      final: true,
      time: Date.now()
    }]);
    expect(replay[0]).toMatchObject({ status: 'ok' });
    expect((await manager.getSession(opened.documentId))?.messages.at(-1)?.text)
      .toContain('The evidence is on');
  });

  it('treats ChatGPT shell user and assistant unit ids as the same turn', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'shell-turn.pdf');
    await writeFile(filePath, await samplePdf('Shell turn evidence'));
    const documents = engine();
    const opened = await documents.openFile(filePath);
    const commands: BridgeCommand[] = [];
    const manager = new ChatSessionManager(documents, new MemoryChatStateStore(), fakeBridge(commands));

    const started = await manager.send({
      documentId: opened.documentId,
      text: 'Read the document',
      scope: 'document',
      attachDocument: false
    });
    const conversationId = '87654321-abcd-4abc-8abc-1234567890ab';
    const sent = await manager.acceptBridgeEvents([{
      eventId: 'shell-user-sent',
      kind: 'input_sent',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId,
      messageId: 'user-shell',
      turnId: 'fallback-turn-0:0:user',
      time: Date.now()
    }]);
    expect(sent[0]).toMatchObject({ status: 'ok' });

    const interim = await manager.acceptBridgeEvents([{
      eventId: 'shell-assistant-interim',
      kind: 'assistant_message',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId,
      messageId: 'assistant-shell-fallback',
      turnId: 'fallback-turn-0:1:assistant',
      text: 'Reading the document…',
      final: false,
      time: Date.now()
    }]);
    expect(interim[0]).toMatchObject({ status: 'ok' });

    const final = await manager.acceptBridgeEvents([{
      eventId: 'shell-assistant-final',
      kind: 'assistant_message',
      sessionId: started.sessionId,
      documentId: opened.documentId,
      inputId: started.pendingInputId,
      conversationId,
      messageId: 'assistant-shell',
      turnId: 'fallback-turn-0:2:assistant',
      text: 'Same shell exchange.',
      final: true,
      time: Date.now()
    }]);
    expect(final[0]).toMatchObject({ status: 'ok' });
    const completed = await manager.getSession(opened.documentId);
    expect(completed).toMatchObject({
      state: 'complete',
      pendingInputId: null
    });
    expect(completed?.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(completed?.messages.at(-1)).toMatchObject({
      messageId: 'assistant-shell',
      text: 'Same shell exchange.',
      final: true
    });
  });

  it('keeps two PDFs in separate sessions and preserves a pending input across manager restart', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'first.pdf');
    const secondPath = path.join(directory, 'second.pdf');
    await writeFile(firstPath, await samplePdf('First document'));
    await writeFile(secondPath, await samplePdf('Second document'));
    const documents = engine();
    const first = await documents.openFile(firstPath);
    const second = await documents.openFile(secondPath);
    const commands: BridgeCommand[] = [];
    const store = new MemoryChatStateStore();
    const bridge = fakeBridge(commands);
    const manager = new ChatSessionManager(documents, store, bridge);

    const firstSession = await manager.send({ documentId: first.documentId, text: 'Question A', scope: 'document' });
    const secondSession = await manager.send({ documentId: second.documentId, text: 'Question B', scope: 'document' });
    expect(firstSession.sessionId).not.toBe(secondSession.sessionId);
    expect(firstSession.pendingInputId).not.toBe(secondSession.pendingInputId);

    const restarted = new ChatSessionManager(documents, store, bridge);
    await restarted.initialize();
    expect(await restarted.getSession(first.documentId)).toMatchObject({
      sessionId: firstSession.sessionId,
      pendingInputId: firstSession.pendingInputId,
      state: 'sending'
    });
    expect(await restarted.getSession(second.documentId)).toMatchObject({
      sessionId: secondSession.sessionId,
      pendingInputId: secondSession.pendingInputId,
      state: 'sending'
    });
  });

  it('never regresses a final assistant revision and rejects contradictory turn/request evidence', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'final.pdf');
    await writeFile(filePath, await samplePdf('Final evidence'));
    const documents = engine();
    const opened = await documents.openFile(filePath);
    const commands: BridgeCommand[] = [];
    const manager = new ChatSessionManager(documents, new MemoryChatStateStore(), fakeBridge(commands));
    const started = await manager.send({ documentId: opened.documentId, text: 'Question', scope: 'document' });
    const conversationId = '99999999-abcd-4abc-8abc-1234567890ab';
    const inputId = started.pendingInputId!;

    await manager.acceptBridgeEvents([{
      eventId: 'sent-final-test', kind: 'input_sent', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'user-final',
      turnId: 'turn-final', requestId: 'request-final', time: Date.now()
    }]);
    await manager.acceptBridgeEvents([{
      eventId: 'stream-final-test', kind: 'assistant_message', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'assistant-final',
      turnId: 'turn-final', requestId: 'request-final', text: 'streaming', final: false, time: Date.now()
    }]);
    await manager.acceptBridgeEvents([{
      eventId: 'complete-final-test', kind: 'assistant_message', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'assistant-final',
      turnId: 'turn-final', requestId: 'request-final', text: 'final answer', final: true, time: Date.now()
    }]);
    const completed = await manager.getSession(opened.documentId);
    const finalMessage = completed?.messages.at(-1);
    expect(finalMessage).toMatchObject({ text: 'final answer', final: true });
    expect(finalMessage!.revisionSeq).toBeGreaterThan(finalMessage!.originSeq);

    const stale = await manager.acceptBridgeEvents([{
      eventId: 'stale-after-final', kind: 'assistant_message', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'assistant-final',
      turnId: 'turn-final', requestId: 'request-final', text: 'old streaming text', final: false, time: Date.now()
    }]);
    expect(stale[0]).toMatchObject({ status: 'ok' });
    expect((await manager.getSession(opened.documentId))?.messages.at(-1)).toMatchObject({
      text: 'final answer', final: true
    });

    const secondAssistant = await manager.acceptBridgeEvents([{
      eventId: 'different-assistant-after-final', kind: 'assistant_message', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'assistant-other',
      turnId: 'turn-final', requestId: 'request-final', text: 'wrong second answer', final: true, time: Date.now()
    }]);
    expect(secondAssistant[0]).toMatchObject({ status: 'failed', error: 'input_already_complete' });

    const conflict = await manager.acceptBridgeEvents([{
      eventId: 'turn-conflict-after-final', kind: 'input_sent', sessionId: started.sessionId,
      documentId: opened.documentId, inputId, conversationId, messageId: 'user-final',
      turnId: 'different-turn', requestId: 'request-final', time: Date.now()
    }]);
    expect(conflict[0]).toMatchObject({ status: 'failed', error: 'turn_correlation_mismatch' });
  });

  it('keeps authorization irreversible, surfaces uncertainty, and only cancels before authorization', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'authorize.pdf');
    const secondPath = path.join(directory, 'cancel.pdf');
    await writeFile(firstPath, await samplePdf('Authorize'));
    await writeFile(secondPath, await samplePdf('Cancel'));
    const documents = engine();
    const first = await documents.openFile(firstPath);
    const second = await documents.openFile(secondPath);
    const commands: BridgeCommand[] = [];
    const manager = new ChatSessionManager(documents, new MemoryChatStateStore(), fakeBridge(commands));

    const authorized = await manager.send({ documentId: first.documentId, text: 'Send once', scope: 'document' });
    const firstInput = authorized.pendingInputId!;
    await manager.acceptBridgeEvents([{
      eventId: 'authorization-event', kind: 'send_authorized', sessionId: authorized.sessionId,
      documentId: first.documentId, inputId: firstInput, conversationId: null, time: Date.now()
    }]);
    expect(await manager.getSession(first.documentId)).toMatchObject({ pendingState: 'authorized', state: 'sending' });
    await expect(manager.cancel(first.documentId)).rejects.toThrow(/cannot be cancelled safely/i);

    const failedAfterAuthorize = await manager.acceptBridgeEvents([{
      eventId: 'failure-after-auth', kind: 'input_failed', sessionId: authorized.sessionId,
      documentId: first.documentId, inputId: firstInput, conversationId: null,
      error: 'lost worker', time: Date.now()
    }]);
    expect(failedAfterAuthorize[0]).toMatchObject({ status: 'failed', error: 'authorized_input_cannot_fail_closed' });
    await manager.acceptBridgeEvents([{
      eventId: 'uncertain-after-auth', kind: 'send_uncertain', sessionId: authorized.sessionId,
      documentId: first.documentId, inputId: firstInput, conversationId: null,
      error: 'receipt missing', time: Date.now()
    }]);
    expect(await manager.getSession(first.documentId)).toMatchObject({
      state: 'uncertain', pendingState: 'uncertain', pendingInputId: firstInput
    });
    await manager.acceptBridgeEvents([{
      eventId: 'tab-closed-after-auth', kind: 'input_abandoned', sessionId: authorized.sessionId,
      documentId: first.documentId, inputId: firstInput, conversationId: null,
      error: 'The ChatGPT tab was closed while this input was still pending.', time: Date.now()
    }]);
    expect(await manager.getSession(first.documentId)).toMatchObject({
      state: 'error', pendingState: null, pendingInputId: null,
      error: 'The ChatGPT tab was closed while this input was still pending.'
    });

    const cancellable = await manager.send({ documentId: second.documentId, text: 'Cancel me', scope: 'document' });
    await manager.cancel(second.documentId);
    expect(commands.at(-1)).toMatchObject({
      type: 'chat_cancel',
      payload: { sessionId: cancellable.sessionId, documentId: second.documentId, inputId: cancellable.pendingInputId }
    });
    await manager.acceptBridgeEvents([{
      eventId: 'cancelled-event', kind: 'input_cancelled', sessionId: cancellable.sessionId,
      documentId: second.documentId, inputId: cancellable.pendingInputId, conversationId: null, time: Date.now()
    }]);
    expect(await manager.getSession(second.documentId)).toMatchObject({ state: 'idle', pendingInputId: null });
  });

  it('refuses to bind one ChatGPT conversation to two PDF sessions', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'owner-a.pdf');
    const secondPath = path.join(directory, 'owner-b.pdf');
    await writeFile(firstPath, await samplePdf('Owner A'));
    await writeFile(secondPath, await samplePdf('Owner B'));
    const documents = engine();
    const first = await documents.openFile(firstPath);
    const second = await documents.openFile(secondPath);
    const manager = new ChatSessionManager(documents, new MemoryChatStateStore(), fakeBridge([]));
    const a = await manager.send({ documentId: first.documentId, text: 'A', scope: 'document' });
    const b = await manager.send({ documentId: second.documentId, text: 'B', scope: 'document' });
    const conversationId = '77777777-abcd-4abc-8abc-1234567890ab';
    expect((await manager.acceptBridgeEvents([{
      eventId: 'bind-owner-a', kind: 'chat_owned', sessionId: a.sessionId, documentId: first.documentId,
      inputId: a.pendingInputId, conversationId, time: Date.now()
    }]))[0]).toMatchObject({ status: 'ok' });
    expect((await manager.acceptBridgeEvents([{
      eventId: 'bind-owner-b', kind: 'chat_owned', sessionId: b.sessionId, documentId: second.documentId,
      inputId: b.pendingInputId, conversationId, time: Date.now()
    }]))[0]).toMatchObject({ status: 'failed', error: 'conversation_already_owned' });
  });

  it('recovers a valid durable backup instead of silently treating a corrupt primary as empty', async () => {
    const directory = await tempDir();
    const pdfPath = path.join(directory, 'recovery.pdf');
    const statePath = path.join(directory, 'pdf-ai.chat-state.json');
    await writeFile(pdfPath, await samplePdf('Recovery state'));
    const documents = engine();
    const opened = await documents.openFile(pdfPath);
    const commands: BridgeCommand[] = [];
    const manager = new ChatSessionManager(documents, new JsonChatStateStore(statePath), fakeBridge(commands));
    const started = await manager.send({ documentId: opened.documentId, text: 'Persist me', scope: 'document' });

    await writeFile(statePath, '{broken-json', 'utf8');
    const recovered = new ChatSessionManager(documents, new JsonChatStateStore(statePath), fakeBridge(commands));
    await recovered.initialize();
    expect((await recovered.getSystemStatus()).recoveryNotice).toMatch(/recovered the previous durable backup/i);
    expect(await recovered.getSession(opened.documentId)).toMatchObject({
      sessionId: started.sessionId,
      pendingInputId: started.pendingInputId
    });
    expect((await readdir(directory)).some(name => name.startsWith('pdf-ai.chat-state.json.corrupt-'))).toBe(true);
  });

  it('surfaces an explicit recovery notice when both primary and backup chat state are unusable', async () => {
    const directory = await tempDir();
    const statePath = path.join(directory, 'pdf-ai.chat-state.json');
    await writeFile(statePath, '{broken-primary', 'utf8');
    await writeFile(statePath + '.bak', '{broken-backup', 'utf8');
    const documents = engine();
    const recovered = new ChatSessionManager(documents, new JsonChatStateStore(statePath), fakeBridge([]));
    await recovered.initialize();
    expect((await recovered.getSystemStatus()).recoveryNotice).toMatch(/could not be recovered/i);
  });

  it('quarantines syntactically valid but structurally corrupt durable state', async () => {
    const directory = await tempDir();
    const statePath = path.join(directory, 'pdf-ai.chat-state.json');
    await writeFile(statePath, JSON.stringify({
      version: 1,
      seenEvents: [],
      sessions: [{
        sessionId: 'not-a-valid-session-shape',
        documentId: 'pdf-bad-shape',
        messages: ['not-a-message'],
        inputs: []
      }]
    }), 'utf8');
    const documents = engine();
    const recovered = new ChatSessionManager(documents, new JsonChatStateStore(statePath), fakeBridge([]));
    await recovered.initialize();
    expect((await recovered.getSystemStatus()).recoveryNotice).toMatch(/could not be recovered/i);
    expect((await readdir(directory)).some(name => name.startsWith('pdf-ai.chat-state.json.corrupt-'))).toBe(true);
  });
});
