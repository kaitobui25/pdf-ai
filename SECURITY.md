# PDF-AI Security

The renderer runs with context isolation enabled, Node integration disabled, sandbox enabled, and web security enabled. Native file access remains in the main process and is exposed through narrow IPC operations.

The browser bridge binds only to 127.0.0.1 and ports 8875–8879. Pairing validates app ID, protocol 1 and an exact Chrome extension ID before minting a 32-byte token. A present Origin must be that exact chrome-extension Origin; a missing Origin is allowed because Chrome may omit it for extension fetches with loopback host permission. Protected routes require the extension ID plus the bearer token and reject wrong app/protocol/present origin. Requests, command payloads, queue/receipt counts and request rate are bounded.

Bridge commands are not published until their state snapshot has saved successfully. ACK processing removes a command only after the receipt snapshot is durable, and repeated ACKs return the existing receipt. The MV3 extension stores the bridge token only in its own chrome.storage.local and stores pending ACK retries in chrome.storage.session.

Phase 5 ChatGPT automation is ownership-scoped. The renderer cannot provide a tab ID or conversation ID. The extension chooses only a PDF-AI-owned fresh chat or the exact conversation already bound to the same durable session; unrelated active ChatGPT tabs are ignored. Content-to-background event/file requests require the exact owned tab, top-frame Chrome `sender.documentId`, per-document token, session, document and input. Reloaded/stale document contexts fail closed.

PDF upload bytes are available only through a protected documentId route in bounded chunks. No browser request accepts a filesystem path. The main document engine verifies the registered PDF has not changed before and after each chunk read. The content script refuses to overwrite a user draft or combine an automated upload with pre-existing ambiguous attachment state, and an exact native user message is required as the send receipt.

Phase 6 adds an irreversible browser-send authorization fence. Authorization is persisted by the extension only for the exact owned top-frame document and input immediately before the native click. Once authorized, PDF-AI never automatically retries that send: loss of the native receipt becomes an explicit uncertain state. A cancel command is rejected after authorization. This trades automatic recovery for duplicate-send prevention when browser state cannot be proved.

The MCP server exposes documents by stable documentId. MCP calls never accept arbitrary filesystem paths. It binds only to 127.0.0.1, uses a fresh secret path on every app start, validates loopback Host/Origin headers, caps request bodies at 2 MB, caps text/page ranges in the document engine, and rejects rendered image payloads above 8 MB. The secret MCP path is no longer printed to application logs; only the loopback port is reported.

The Phase-4.1 tunnel API key is write-only from the renderer. On Windows it is encrypted with Electron `safeStorage` (DPAPI-backed) before it is persisted under PDF-AI userData. If secure storage is unavailable, PDF-AI keeps a newly entered key in memory only for that process instead of falling back to plaintext disk storage. The key and fresh MCP URL are passed to `tunnel-client` only through a scrubbed child environment, never command-line arguments, renderer state, config JSON, or logs.

PDF-AI downloads only its pinned OpenAI tunnel-client release, verifies the archive SHA-256 before extraction, rechecks its cached archive and executable hash before reuse, and does not silently choose a PATH copy. The tunnel health URL is accepted only when it is an HTTP 127.0.0.1 address. An invalid explicit runtime override fails closed.

Secrets belong in PDF-AI's private user-data storage and must never be committed to the repository. The application does not read or write runtime state, credentials, extension storage, sessions, tunnels, or user-data owned by other applications.
