# PDF-AI Architecture

PDF-AI is a standalone Electron + TypeScript application. The Electron main process owns local files, document state, the local MCP endpoint, the OpenAI tunnel lifecycle, and the browser bridge. The renderer is sandboxed and receives only named APIs through the preload layer.

The product has five isolated parts:

1. Electron main owns native file selection, document indexing, stable document IDs, MCP, and the local bridge.
2. Renderer owns PDF presentation, continuous scrolling, selection UX, search presentation, and the local chat panel.
3. PDF AI MCP server exposes only document-ID-based PDF tools through its own connector.
4. PDF-AI Chrome MV3 extension owns its own browser storage and talks only to the PDF-AI bridge on ports 8875–8879.
5. Tunnel supervisor owns PDF-AI's verified `tunnel-client` runtime, secure credential access, health/reconnect state, and the private link from the local MCP endpoint to the dedicated ChatGPT connector.

The browser bridge and MCP endpoint are separate transports. The bridge is loopback-only and exists for the Chrome extension. MCP is independently published through the dedicated PDF AI connector/tunnel.

PDF-AI never reads or writes another application's runtime state. Its app/user-data identity, local storage, bridge identifier, bridge ports, extension identity, MCP identity, and tunnel configuration are all dedicated to this project.

## PDF reader boundary

The main process owns native file selection and reads one bounded file snapshot from an open file handle. It verifies the file is regular, unchanged during the read, contains a PDF header, and is at most 128 MB. The renderer receives the PDF bytes plus metadata and a stable content-derived document ID; it never receives the native file path.

The renderer uses PDF.js for continuous reading. Page canvases and text layers are rendered lazily around the viewport, in-flight renders are invalidated by generation on zoom/resize/navigation changes, and offscreen backing canvases/text DOM are released. Thumbnail canvases are also viewport-scoped. Current-page tracking only scans pages in the observer's near-viewport set rather than every page on every scroll frame. Search extracts text page-by-page with a bounded cache, and outline/thumbnails are loaded independently. The Phase-1 reader explicitly admits at most 5,000 pages and enforces CSS/raster/thumbnail dimensions before allocating canvases.

## MCP boundary

The PDF AI MCP server is a separate loopback-only HTTP listener on an OS-assigned local port. Each app start generates a fresh unguessable MCP path. The server publishes exactly seven PDF tools and every tool addresses content through documentId; no tool accepts an arbitrary filesystem path.

MCP handlers call the same authoritative PdfDocumentEngine used by the reader state. Tool schemas are strict Zod objects, request bodies are bounded, page/text/image outputs are bounded, and rendered image tools return page metadata plus a PNG content block.

## Secure MCP tunnel boundary

Phase 4.1 keeps tunnel ownership in the Electron main process. The renderer can provide a tunnel ID and a write-only API-key draft, request Connect/Disconnect, and read a safe status projection; it never receives the stored key or the private MCP URL.

The runtime provider pins the CoS-vetted OpenAI `tunnel-client` release for Windows x64/arm64 and verifies the release archive SHA-256 before extraction. The verified runtime is cached only under PDF-AI userData and is revalidated before reuse. Normal operation ignores PATH; an explicit development/recovery override must resolve to the exact selected executable or fails closed.

On Connect, the supervisor passes the restricted control-plane key and the current per-process MCP URL only through the child environment (`CONTROL_PLANE_API_KEY` and `MCP_SERVER_URL`). Neither value appears in argv or renderer state. Tunnel health uses the client's loopback health URL, requires that URL to be 127.0.0.1, distinguishes local readiness from OpenAI poll health, and restarts only an unexpectedly exited or persistently unready owned child. Disconnect/app quit retires only that captured PDF-AI child process tree.

## Browser bridge boundary

The browser bridge is a second local HTTP service and never shares the MCP listener. It binds only to 127.0.0.1 on the fixed PDF-AI range 8875–8879. Discovery uses GET /hello; pairing binds one Chrome extension ID to a PDF-AI token and protected requests require app ID, protocol version, extension ID and bearer token.

Bridge state is durable under PDF-AI userData. Commands are identified before publication and are returned at least once until an ACK is durably recorded. The MV3 extension keeps its connection in chrome.storage.local and pending ACKs in chrome.storage.session, so service-worker suspension does not lose a final ACK.

## ChatGPT automation boundary

Phase 5 keeps browser ownership outside the renderer. Electron creates a durable PDF-AI session/input and queues a `chat_send` command containing only controlled document/session identities, prompt text and safe PDF metadata. The extension service worker owns the exact ChatGPT tab/conversation binding; it never interprets the user's currently active arbitrary tab as a target. Fresh chats are created by PDF-AI, and later sends may reuse only the exact conversation already bound to the same PDF-AI session.

The content script refuses a non-empty user draft, a generating composer, ambiguous upload controls, a route mismatch or an unowned/reloaded Chrome document. Prompt delivery is idempotent through a PDF-AI ownership marker and success requires a new native user-message row carrying that exact marker; a JavaScript click, composer clear or Stop button is not a send receipt. Assistant revisions are observed only after the exact owned user message.

PDF bytes remain main-process-owned. The extension can request bounded chunks only for a `documentId` already registered in `PdfDocumentEngine`; the engine rechecks the file identity before and after each read and never returns a native path. Content-to-background requests are fenced by the owned tab plus Chrome `sender.documentId` and a per-document token, so a retired document after reload cannot continue using a newer tab lifetime.

Browser observations enter a bounded durable extension outbox before transport, then a protected `/events` bridge route. Electron stores the PDF-AI session/input/conversation/message correlation in `pdf-ai.chat-state.json`; replayed event IDs are idempotent and a conflicting document/input/conversation identity is rejected rather than guessed.

## Durable chat correlation

Phase 6 treats correlation as first-proof-wins durable state rather than timestamp or active-tab inference. One document owns one PDF-AI session; one bound ChatGPT conversation cannot be adopted by another session. Each input has an immutable input ID, optional native user-message/turn/request evidence, one canonical assistant message identity, and an irreversible send-authorization boundary. Canonical messages carry local `originSeq` and `revisionSeq` counters so revisions never depend on wall-clock ordering.

Immediately before the one native Send click, the content document requests authorization through its exact owned sender identity. The extension persists that authorization before replying. After authorization, a missing browser receipt is represented as `uncertain`; command replay/restart may resume observation but may not issue another Send. A recovered ownership marker republishes the exact native user-message receipt before assistant observation continues. Cancellation is accepted only before authorization.

Assistant finality is monotonic. A stale streaming revision cannot overwrite a final answer, a completed input cannot acquire a second assistant message identity, and conflicting conversation/turn/request evidence is rejected. Event IDs provide bounded transport replay suppression, while these semantic identities remain the long-term idempotency boundary after the event-ID window rolls over.

## Local chat UI boundary

Phase 7 renders only the durable main-process chat snapshot. The renderer never chooses ChatGPT tabs or conversations. Its actions are limited to the current `documentId`, prompt text, an explicit scope (`selection`, `page`, `document`, or `custom`), and an optional attach-current-PDF flag. Session/conversation/input ownership remains outside the renderer.

Chat polling is document-generation fenced, so a delayed A response cannot apply after A→B→A navigation. Timeline rows use the durable `originSeq` ordering and preserve a user who has scrolled away from the bottom. Assistant page references are typed data from main-process parsing; the renderer activates navigation only when the referenced `documentId` equals the exact current PDF and the page is within the current page count. Raw `pdf://` text is never navigated as an external URL.
