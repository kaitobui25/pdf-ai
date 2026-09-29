import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CHAT_CONVERSATION_ID_PATTERN,
  chatOwnershipMarker,
  parsePdfPageReferences,
  type ChatPageReference,
  type ChatSendInput,
  type ChatSessionSnapshot
} from '../shared/chat.js';
import type { BrowserBridge, BridgeCommand } from './bridge.js';
import { PdfDocumentEngine } from './pdf-document-engine.js';

const MAX_SESSIONS = 64;
const MAX_MESSAGES_PER_SESSION = 240;
const MAX_INPUTS_PER_SESSION = 120;
const MAX_SEEN_EVENTS = 2000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_EVENT_TEXT_CHARS = 128_000;

type InputState = 'queued' | 'sent' | 'complete' | 'failed';

interface ChatInputRecord {
  id: string;
  scope: ChatSendInput['scope'];
  displayText: string;
  framedPrompt: string;
  attachDocument: boolean;
  state: InputState;
  conversationId: string | null;
  commandId: string | null;
  userMessageId: string | null;
  turnId: string | null;
  requestId: string | null;
  assistantMessageId: string | null;
  attachmentUploaded: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ChatSessionRecord extends ChatSessionSnapshot {
  inputs: ChatInputRecord[];
}

interface ChatDurableState {
  version: 1;
  sessions: ChatSessionRecord[];
  seenEvents: string[];
}

export interface ChatStateStore {
  load(): Promise<ChatDurableState | null>;
  save(state: ChatDurableState): Promise<void>;
}

export class MemoryChatStateStore implements ChatStateStore {
  private state: ChatDurableState | null = null;

  async load(): Promise<ChatDurableState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: ChatDurableState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class JsonChatStateStore implements ChatStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ChatDurableState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ChatDurableState;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.seenEvents)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async save(state: ChatDurableState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp-' + randomBytes(6).toString('hex');
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export interface ChatBridgeEventReceipt {
  eventId: string;
  status: 'ok' | 'failed';
  error?: string;
}

const bridgeEventSchema = z.object({
  eventId: z.string().min(8).max(128),
  kind: z.enum(['chat_owned', 'attachment_uploaded', 'input_sent', 'assistant_message', 'input_failed']),
  sessionId: z.uuid(),
  documentId: z.string().min(8).max(128),
  inputId: z.uuid(),
  conversationId: z.string().regex(CHAT_CONVERSATION_ID_PATTERN).nullable().optional(),
  messageId: z.string().min(1).max(256).nullable().optional(),
  turnId: z.string().min(1).max(256).nullable().optional(),
  requestId: z.string().min(1).max(256).nullable().optional(),
  text: z.string().max(MAX_EVENT_TEXT_CHARS).optional(),
  final: z.boolean().optional(),
  error: z.string().max(1000).optional(),
  time: z.number().int().nonnegative()
}).strict();

type BridgeEvent = z.infer<typeof bridgeEventSchema>;

function emptyState(): ChatDurableState {
  return { version: 1, sessions: [], seenEvents: [] };
}

function cloneSnapshot(session: ChatSessionRecord): ChatSessionSnapshot {
  return {
    sessionId: session.sessionId,
    documentId: session.documentId,
    conversationId: session.conversationId,
    state: session.state,
    pendingInputId: session.pendingInputId,
    error: session.error,
    messages: structuredClone(session.messages),
    updatedAt: session.updatedAt
  };
}

function pageRef(documentId: string, page: number): ChatPageReference {
  return { documentId, page, reference: `pdf://${documentId}/page/${page}` };
}

function messageId(prefix: string, inputId: string): string {
  return `${prefix}:${inputId}`;
}

export class ChatSessionManager {
  private state: ChatDurableState = emptyState();
  private initialized = false;
  private mutation = Promise.resolve();
  private bridge: Pick<BrowserBridge, 'enqueueCommand'> | null = null;

  constructor(
    private readonly engine: PdfDocumentEngine,
    private readonly store: ChatStateStore,
    bridge?: Pick<BrowserBridge, 'enqueueCommand'>
  ) {
    this.bridge = bridge ?? null;
  }

  setBridge(bridge: Pick<BrowserBridge, 'enqueueCommand'>): void {
    this.bridge = bridge;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await this.store.load();
    this.state = loaded ?? emptyState();
    this.state.sessions = this.state.sessions.slice(-MAX_SESSIONS);
    this.state.seenEvents = this.state.seenEvents.slice(-MAX_SEEN_EVENTS);
    this.initialized = true;
  }

  async getSession(documentId: string): Promise<ChatSessionSnapshot | null> {
    await this.initialize();
    const session = this.state.sessions.find(candidate => candidate.documentId === documentId);
    return session ? cloneSnapshot(session) : null;
  }

  async send(input: ChatSendInput): Promise<ChatSessionSnapshot> {
    await this.initialize();
    if (!this.bridge) throw new Error('PDF-AI browser bridge is not ready.');
    const documentId = input.documentId.trim();
    const text = input.text.trim();
    if (!documentId || documentId.length > 128) throw new Error('A valid PDF document is required.');
    if (!text) throw new Error('Enter a question for ChatGPT.');
    if (text.length > MAX_PROMPT_CHARS) throw new Error('The question is too long.');

    const context = await this.buildContext(documentId, input.scope);
    const created = await this.mutate(current => {
      let session = current.sessions.find(candidate => candidate.documentId === documentId);
      if (!session) {
        session = {
          sessionId: randomUUID(),
          documentId,
          conversationId: null,
          state: 'idle',
          pendingInputId: null,
          error: null,
          messages: [],
          updatedAt: Date.now(),
          inputs: []
        };
        current.sessions.push(session);
      }
      if (session.pendingInputId) throw new Error('Wait for the current ChatGPT turn to finish before sending another question.');
      const inputId = randomUUID();
      const marker = chatOwnershipMarker(session.sessionId, inputId);
      const framedPrompt = [
        marker,
        text,
        '',
        context.text,
        '',
        'Use only the PDF AI MCP connector for PDF evidence. Do not mention the PDF-AI marker.',
        'When citing PDF evidence, include stable references exactly as pdf://<documentId>/page/<n>.'
      ].join('\n');
      const now = Date.now();
      const record: ChatInputRecord = {
        id: inputId,
        scope: input.scope,
        displayText: text,
        framedPrompt,
        attachDocument: input.attachDocument === true,
        state: 'queued',
        conversationId: session.conversationId,
        commandId: null,
        userMessageId: null,
        turnId: null,
        requestId: null,
        assistantMessageId: null,
        attachmentUploaded: false,
        error: null,
        createdAt: now,
        updatedAt: now
      };
      session.inputs.push(record);
      session.pendingInputId = inputId;
      session.state = 'sending';
      session.error = null;
      session.updatedAt = now;
      session.messages.push({
        id: messageId('user', inputId),
        role: 'user',
        text,
        createdAt: now,
        inputId,
        conversationId: session.conversationId,
        messageId: null,
        turnId: null,
        requestId: null,
        final: true,
        pageReferences: context.references
      });
      this.trimSession(session);
      return {
        snapshot: cloneSnapshot(session),
        command: {
          sessionId: session.sessionId,
          documentId,
          inputId,
          conversationId: session.conversationId,
          prompt: framedPrompt,
          attachDocument: record.attachDocument,
          document: context.document
        }
      };
    });

    let command: BridgeCommand;
    try {
      command = await this.bridge.enqueueCommand('chat_send', created.command);
    } catch (error) {
      return this.failQueuedInput(created.command.sessionId, created.command.inputId,
        error instanceof Error ? error.message : 'Could not queue the ChatGPT send command.');
    }
    return this.mutate(current => {
      const session = current.sessions.find(candidate => candidate.sessionId === created.command.sessionId);
      const record = session?.inputs.find(candidate => candidate.id === created.command.inputId);
      if (session && record && record.state === 'queued') {
        record.commandId = command.id;
        record.updatedAt = Date.now();
        session.updatedAt = record.updatedAt;
      }
      return session ? cloneSnapshot(session) : created.snapshot;
    });
  }

  async acceptBridgeEvents(rawEvents: unknown[]): Promise<ChatBridgeEventReceipt[]> {
    await this.initialize();
    if (!Array.isArray(rawEvents) || rawEvents.length < 1 || rawEvents.length > 64) {
      throw new Error('Bridge event batch must contain from 1 to 64 events.');
    }
    const receipts: ChatBridgeEventReceipt[] = [];
    for (const raw of rawEvents) {
      const parsed = bridgeEventSchema.safeParse(raw);
      if (!parsed.success) {
        const eventId = raw && typeof raw === 'object' && typeof (raw as { eventId?: unknown }).eventId === 'string'
          ? String((raw as { eventId: string }).eventId).slice(0, 128)
          : 'invalid';
        receipts.push({ eventId, status: 'failed', error: 'invalid_event' });
        continue;
      }
      const event = parsed.data;
      try {
        await this.applyEvent(event);
        receipts.push({ eventId: event.eventId, status: 'ok' });
      } catch (error) {
        receipts.push({
          eventId: event.eventId,
          status: 'failed',
          error: error instanceof Error ? error.message.slice(0, 500) : 'event_rejected'
        });
      }
    }
    return receipts;
  }

  private async applyEvent(event: BridgeEvent): Promise<void> {
    await this.mutate(current => {
      if (current.seenEvents.includes(event.eventId)) return;
      const session = current.sessions.find(candidate => candidate.sessionId === event.sessionId);
      if (!session || session.documentId !== event.documentId) throw new Error('session_document_mismatch');
      const input = session.inputs.find(candidate => candidate.id === event.inputId);
      if (!input) throw new Error('input_not_found');
      const conversationId = event.conversationId ?? null;

      if (conversationId) {
        if (session.conversationId && session.conversationId !== conversationId) {
          throw new Error('conversation_ownership_mismatch');
        }
        if (input.conversationId && input.conversationId !== conversationId) {
          throw new Error('input_conversation_mismatch');
        }
        if (!session.conversationId) session.conversationId = conversationId;
        if (!input.conversationId) input.conversationId = conversationId;
      }

      if (event.kind === 'chat_owned') {
        if (!conversationId) throw new Error('owned_chat_requires_conversation');
      } else if (event.kind === 'attachment_uploaded') {
        if (session.pendingInputId !== input.id || input.state !== 'queued') throw new Error('stale_attachment_event');
        input.attachmentUploaded = true;
      } else if (event.kind === 'input_sent') {
        if (!conversationId) throw new Error('sent_input_requires_conversation');
        if (session.pendingInputId !== input.id && input.state !== 'complete') throw new Error('stale_input_send');
        if (input.state !== 'complete') input.state = 'sent';
        input.userMessageId = event.messageId ?? input.userMessageId;
        input.turnId = event.turnId ?? input.turnId;
        input.requestId = event.requestId ?? input.requestId;
        const user = session.messages.find(message => message.id === messageId('user', input.id));
        if (user) {
          user.conversationId = conversationId;
          user.messageId = event.messageId ?? user.messageId;
          user.turnId = event.turnId ?? user.turnId;
          user.requestId = event.requestId ?? user.requestId;
        }
        if (input.state !== 'complete') session.state = 'waiting';
      } else if (event.kind === 'assistant_message') {
        if (!conversationId) throw new Error('assistant_event_requires_conversation');
        if (input.state === 'failed') throw new Error('input_already_failed');
        if (session.pendingInputId !== input.id && input.state !== 'complete') throw new Error('assistant_for_non_pending_input');
        if (!event.messageId || !event.text?.trim()) throw new Error('assistant_event_missing_message');
        const existing = session.messages.find(message =>
          message.role === 'assistant' && message.inputId === input.id && message.messageId === event.messageId
        );
        const refs = parsePdfPageReferences(event.text);
        if (existing) {
          existing.text = event.text;
          existing.turnId = event.turnId ?? existing.turnId;
          existing.requestId = event.requestId ?? existing.requestId;
          existing.final = event.final === true;
          existing.pageReferences = refs;
        } else {
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: event.text,
            createdAt: event.time,
            inputId: input.id,
            conversationId,
            messageId: event.messageId,
            turnId: event.turnId ?? null,
            requestId: event.requestId ?? null,
            final: event.final === true,
            pageReferences: refs
          });
        }
        input.assistantMessageId = event.messageId;
        input.turnId = event.turnId ?? input.turnId;
        input.requestId = event.requestId ?? input.requestId;
        if (event.final === true) {
          input.state = 'complete';
          session.pendingInputId = null;
          session.state = 'complete';
          session.error = null;
        } else if (input.state !== 'complete') {
          input.state = 'sent';
          session.state = 'waiting';
        }
      } else if (event.kind === 'input_failed') {
        if (input.state !== 'complete') {
          input.state = 'failed';
          input.error = event.error ?? 'ChatGPT browser automation failed.';
          if (session.pendingInputId === input.id) session.pendingInputId = null;
          session.state = 'error';
          session.error = input.error;
        }
      }

      input.updatedAt = Date.now();
      session.updatedAt = input.updatedAt;
      this.trimSession(session);
      current.seenEvents.push(event.eventId);
      if (current.seenEvents.length > MAX_SEEN_EVENTS) {
        current.seenEvents.splice(0, current.seenEvents.length - MAX_SEEN_EVENTS);
      }
    });
  }

  private async failQueuedInput(sessionId: string, inputId: string, error: string): Promise<ChatSessionSnapshot> {
    return this.mutate(current => {
      const session = current.sessions.find(candidate => candidate.sessionId === sessionId);
      const input = session?.inputs.find(candidate => candidate.id === inputId);
      if (!session || !input) throw new Error(error);
      if (input.state !== 'complete') {
        input.state = 'failed';
        input.error = error;
        input.updatedAt = Date.now();
        if (session.pendingInputId === input.id) session.pendingInputId = null;
        session.state = 'error';
        session.error = error;
        session.updatedAt = input.updatedAt;
      }
      return cloneSnapshot(session);
    });
  }

  private async buildContext(documentId: string, scope: ChatSendInput['scope']): Promise<{
    document: { documentId: string; name: string; size: number };
    text: string;
    references: ChatPageReference[];
  }> {
    const documents = await this.engine.listDocuments();
    const document = documents.find(candidate => candidate.documentId === documentId);
    if (!document) throw new Error('The requested PDF is not currently open.');
    if (document.changed) throw new Error('The PDF changed on disk. Reopen it before asking ChatGPT.');
    if (scope === 'selection') {
      const selection = await this.engine.getSelection(documentId);
      if (!selection) throw new Error('Select PDF text before using Ask selection.');
      const refs: ChatPageReference[] = [];
      for (let page = selection.startPage; page <= selection.endPage && refs.length < 64; page++) {
        refs.push(pageRef(documentId, page));
      }
      return {
        document: { documentId, name: document.name, size: document.size },
        text: `Scope: current selection in document ${documentId}, pages ${selection.startPage}-${selection.endPage}. Call pdf_get_selection for the exact selected text and bounds.`,
        references: refs
      };
    }
    if (scope === 'page') {
      const current = await this.engine.getCurrentPage(documentId);
      return {
        document: { documentId, name: document.name, size: document.size },
        text: `Scope: current page ${current.page} of document ${documentId}. Call pdf_get_current_page and pdf_read_pages for exact evidence.`,
        references: [pageRef(documentId, current.page)]
      };
    }
    if (scope === 'document') {
      return {
        document: { documentId, name: document.name, size: document.size },
        text: `Scope: whole document ${documentId} (${document.pageCount} pages). Use pdf_search/pdf_read_pages as needed; do not use another open PDF.`,
        references: []
      };
    }
    return {
      document: { documentId, name: document.name, size: document.size },
      text: `Scope: document ${documentId}. Use the PDF AI tools only when PDF evidence is needed.`,
      references: []
    };
  }

  private trimSession(session: ChatSessionRecord): void {
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
    }
    if (session.inputs.length > MAX_INPUTS_PER_SESSION) {
      const removable = session.inputs.filter(input => input.id !== session.pendingInputId);
      const removeCount = session.inputs.length - MAX_INPUTS_PER_SESSION;
      const removeIds = new Set(removable.slice(0, removeCount).map(input => input.id));
      session.inputs = session.inputs.filter(input => !removeIds.has(input.id));
    }
  }

  private async mutate<T>(operation: (state: ChatDurableState) => T): Promise<T> {
    let result!: T;
    let failure: unknown;
    const run = this.mutation.then(async () => {
      const next = structuredClone(this.state);
      try {
        result = operation(next);
        if (next.sessions.length > MAX_SESSIONS) next.sessions.splice(0, next.sessions.length - MAX_SESSIONS);
        await this.store.save(next);
        this.state = next;
      } catch (error) {
        failure = error;
      }
    });
    this.mutation = run.then(() => undefined, () => undefined);
    await run;
    if (failure !== undefined) throw failure;
    return result;
  }
}
