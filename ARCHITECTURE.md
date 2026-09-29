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

Bridge state is durable under PDF-AI userData. Commands are identified before publication and are returned at least once until an ACK is durably recorded. The MV3 extension keeps its connection in chrome.storage.local and pending ACKs in chrome.storage.session, so service-worker suspension does not lose a final ACK. Phase 4 exposes only health/transport foundations; it does not automate ChatGPT.
