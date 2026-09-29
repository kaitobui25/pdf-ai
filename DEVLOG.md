# PDF-AI Development Log

## Phase 0 — CoS inspection and standalone initialization

Inspected the read-only CoS reference before implementation:

- AGENTS.md
- package.json
- src/main/index.ts
- src/preload/index.ts
- src/main/bridge.ts
- src/main/bridge-ports.ts
- src/main/mcp/server.ts
- src/main/mcp/tools.ts
- src/main/mcp/tool-declarations.ts
- extension/background.js
- src/renderer/file-pdf-viewer.ts
- src/main/project-files.ts
- src/shared/project-files.ts

Patterns reused or simplified:

- Keep Electron's renderer sandboxed and publish only named preload IPC methods.
- Keep the browser bridge separate from MCP and bind sensitive local transports to loopback.
- Centralize app/bridge/MCP identities and port ranges.
- Bound PDF bytes, canvas work, HTTP bodies, and MCP result sizes at their owners.
- Keep native file paths in the main process; renderer and MCP use controlled document identities/data.
- Fail closed when an identity or protocol boundary is ambiguous.

Features intentionally omitted:

- Goal/Loop, workers, desktop control, plugin management, updater/packaging, project filesystem editing, arbitrary command/file tools, ChatGPT automation, and session continuation.

Isolation:

- PDF-AI uses app/bridge id pdf-ai, app/user-data name PDF-AI, bridge ports 8875–8879, and MCP connector name PDF AI.
- The CoS reference repository remains read-only and no CoS runtime path, state, session, extension storage, tunnel, or bridge port is used.

Validation:

- npm run typecheck: pass.
- npm test: pass.
- npm run build: pass.
- npm run dev: Electron starts and remains running until stopped.

## Phase 1 — PDF reader core

Inspected/reused the Phase-1 CoS patterns from:

- src/renderer/file-pdf-viewer.ts
- src/main/project-files.ts
- src/shared/project-files.ts
- src/preload/index.ts

Patterns reused or simplified:

- Main owns native paths and one open-handle PDF snapshot; renderer gets bytes plus controlled metadata only.
- Recheck file identity after the read and reject misleading PDF extensions without a PDF header.
- Use PDF.js with a dedicated worker, explicit render cancellation/generations, bounded raster allocation, and resource cleanup.
- Keep the preload surface fixed and named rather than exposing arbitrary IPC.

PDF-AI-specific reader work:

- Continuous-scroll reader with previous/next/direct page navigation, zoom and fit-to-width.
- PDF.js text layer for native selection, page-aware selection reporting, text search with page mapping, viewport-center current-page tracking, outline and lazy thumbnails.
- Stable content-derived document IDs.
- Lazy canvas/text rendering around the viewport; distant canvas/text resources are released.
- Page and thumbnail canvases are allocated only while near their viewport; current-page tracking only scans nearby pages.
- Reader admission is capped at 5,000 pages, page CSS dimensions are bounded, backing canvases are capped at 8,192 px / 16 MP, and pathological thumbnail aspect ratios are scaled to 112 × 160 bounds.
- Search and text caching are generation-scoped so a document/query change cannot publish stale results; text cache is bounded.
- Open-file selection is last-action-wins: a newer Open action supersedes any earlier pending selection/load.
- Corrupt/non-PDF, empty, changed-during-read and >128 MB inputs fail visibly before reader admission.

Intentionally omitted in this phase:

- Native-path APIs in renderer, project explorer/editing, annotation actions, ChatGPT automation, MCP publication, browser extension work, durable session state and document-engine APIs. Those belong to later roadmap phases.

Isolation:

- All file access remains inside PDF-AI main process. No CoS path/state/port/storage is read or written.

Validation:

- npm run typecheck: pass.
- npm test: pass, 4 files / 21 tests.
- Real generated two-page PDF parses, extracts expected text and renders through PDF.js + @napi-rs/canvas in tests.
- Navigation clamp, zoom/fit math, canvas pixel/dimension bounds, page-mapped selection and page-mapped search helpers are covered.
- Direct PdfReader jsdom tests cover navigation, zoom/fit lifecycle, selected-text page ownership, stale search cancellation across document changes, lazy/offscreen page cleanup, bounded thumbnail rendering, and the page-count admission cap.
- Overlapping Open loads are regression-tested so a stale load only destroys its own captured PDF.js loading task and cannot tear down the newer document.
- Corrupt and oversized PDFs are rejected.
- npm run build: pass.
- npm run dev: Electron main/preload/renderer start successfully and remain running until stopped.

## Phase 2 — Page-aware document engine

Inspected/reused the Phase-2 CoS patterns from:

- src/main/project-files.ts
- src/renderer/file-pdf-viewer.ts
- src/preload/index.ts
- src/main/session/input.ts
- src/main/session/store.ts
- extension/content.js
- extension/chatgpt-dom.js
- extension/fiber.js

Patterns reused or simplified:

- Main process owns the native path, immutable file identity and authoritative document registry.
- Async work checks the exact live document record again after awaits instead of trusting stale renderer state.
- Renderer state updates carry a per-open view epoch plus monotonic sequence number, so A→B→A cannot replay stale current-page or selection state.
- Stable page references are document-snapshot-qualified and 1-based.
- Text extraction/search share one bounded per-document cache and single-flight page extraction.
- File replacement is detected from dev/inode/size/mtime/ctime and stale document reads fail closed until reopened.
- Rendered page/region output is bounded by scale, dimensions and total pixels.

PDF-AI-specific document engine:

- listDocuments, getCurrentPage, getSelection, search, readPages, renderPage and renderRegion are implemented as local main-process APIs.
- Multiple open PDFs remain isolated; the current document is explicit.
- Selection state stores exact text, page range, stable page references and normalized single-page bounds when available.
- Full-page and normalized-region PNG rendering runs in the main process using PDF.js plus @napi-rs/canvas.
- Identical PDF bytes share the same stable document ID while retaining explicit source-file identities; changing an inactive duplicate does not invalidate the active source.
- Reopening a replaced file removes the old source binding and registers the new content revision under a new stable document ID.

Intentionally omitted in this phase:

- MCP publication, public tunnel configuration, browser bridge/extension pairing, ChatGPT automation and durable conversation/session correlation.

Isolation:

- Document APIs expose document IDs and page metadata; native file paths remain private to the main process.
- No CoS runtime state, ports, sessions, extension storage or tunnel configuration is accessed.

Validation:

- npm run typecheck: pass.
- npm test: pass, 5 files / 28 tests.
- Engine tests cover exact page text, multi-page search, multi-document isolation, stale renderer epochs, selection mapping, page/region image correctness, identical-content sources and file replacement.
- npm run build: pass.
- npm run dev: Electron main/preload/renderer start successfully and remain running until stopped.

## Phase 3 — Local MCP server

Inspected/reused the Phase-3 CoS patterns from:

- src/main/mcp/server.ts
- src/main/mcp/tools.ts
- src/main/mcp/tool-declarations.ts
- src/main/mcp/kernel.ts
- src/main/mcp/inbound.ts

Patterns reused or simplified:

- Keep MCP on its own loopback listener, separate from the browser bridge.
- Generate an unguessable per-process endpoint path instead of publishing a bare local route.
- Apply loopback Host/Origin validation and bound request bodies before MCP dispatch.
- Register only the tools the connector actually advertises; unknown names stay unknown at the protocol layer.
- Use Zod as runtime validation authority and keep tool-specific page/text/image bounds in the owning subsystem.

PDF-AI-specific MCP work:

- Added exactly seven tools: pdf_list_documents, pdf_get_current_page, pdf_get_selection, pdf_search, pdf_read_pages, pdf_render_page and pdf_render_region.
- Tool schemas accept only document IDs, pages, search text, render scale and normalized regions. No arbitrary filesystem path is exposed.
- Engine errors are returned as explicit tool-level errors with stable error codes.
- Render tools return document/page/reference metadata plus a PNG MCP image content block.
- The Electron main process starts the MCP endpoint with the shared PdfDocumentEngine and logs the local endpoint for tunnel setup.

Intentionally omitted in this phase:

- Browser extension transport, Chrome pairing, command delivery, ChatGPT automation, public tunnel provisioning and conversation/session ownership.

Isolation:

- MCP uses its own listener and secret path; it does not reuse browser bridge ports 8875–8879 and does not touch CoS ports/state.

Validation:

- npm run typecheck: pass.
- npm test: pass, 6 files / 33 tests.
- MCP client SDK successfully connects over real loopback HTTP, discovers exactly seven tools and calls list/current/selection/search/read/render page/render region.
- Tests cover invalid document IDs/pages, schema/query/page-range bounds, concurrent calls and multiple PDFs.
- npm run build: pass.
- npm run dev: Electron starts and prints a loopback PDF AI MCP endpoint, then remains running until stopped.

## Phase 4 — Browser bridge and MV3 extension foundation

Inspected/reused the Phase-4 CoS patterns from:

- src/main/bridge.ts
- src/main/bridge-ports.ts
- src/main/extension-path.ts
- extension/background.js
- extension/content.js
- extension/chatgpt-dom.js
- extension/fiber.js
- src/main/session/input.ts
- src/main/session/store.ts

Patterns reused or simplified:

- Scan a fixed set of loopback ports and require an app/protocol identity match before pairing.
- Keep the pairing token in extension service-worker storage rather than page/content-script state.
- Bind credentials to the exact extension ID and reject any present Origin that is not that Chrome-extension Origin; allow missing Origin because Chrome may omit it for extension fetches with loopback host permission.
- Use explicit app/protocol/extension headers plus bearer token on protected requests.
- Bound request bodies, command payloads, queue sizes and rate limits.
- Persist command state before publication; ACK removes a command only after the receipt snapshot saves successfully.
- Keep an extension-side ACK outbox in storage.session so MV3 suspension/restart can retry a lost response.
- Treat command IDs and ACK receipts as idempotency boundaries.

PDF-AI-specific bridge/extension work:

- Browser bridge binds only 127.0.0.1 and only ports 8875–8879; collision advances to the next PDF-AI port and all-five-busy fails startup.
- GET /hello identifies app/bridge id pdf-ai and protocol 1.
- POST /pair mints a 32-byte base64url token for one exact Chrome extension ID; wrong present origins are rejected while the Chrome host-permission missing-Origin case remains compatible. Protected routes reject wrong app, protocol, extension, present origin or token.
- Added request-body and command-payload limits, a rolling request rate limit, durable command queue, bounded receipt history and explicit wake generation.
- Added GET /status, GET /commands/next and idempotent POST /commands/ack foundation routes.
- Bridge state is stored only under PDF-AI userData in pdf-ai.bridge-state.json.
- Added a dedicated MV3 extension with storage + alarms permissions, local bridge client, startup/alarm reconnect maintenance and a minimal health popup.
- Extension scans only 8875–8879, stores port/token in chrome.storage.local, stores ACK outbox in chrome.storage.session, and contains no content script or ChatGPT automation.
- Browser bridge and extension client are tested together over real HTTP, including a simulated lost ACK response followed by service-worker client recreation and idempotent ACK replay.

Intentionally omitted in this phase:

- Opening or choosing ChatGPT tabs, DOM/fiber observation, prompt/file sending, conversation ownership, response correlation and local AI chat projection. Those begin only after the mandatory user checkpoint.

Isolation:

- The extension has its own manifest and PDF-AI storage keys.
- No extension code references CoS ports 8765–8769, CoS runtime state or ChatGPT.
- The MCP tunnel remains separate from the browser bridge; the bridge stays local on 127.0.0.1.

Validation:

- npm run typecheck: pass.
- npm test: pass, 9 files / 45 tests.
- Bridge tests cover wrong origin/app/protocol, missing/wrong/stale tokens, port collision, bridge restart, durable write failure, body/rate bounds and idempotent ACK.
- Extension tests cover fixed-port discovery, identity/protocol filtering, protected headers, persistent connection state and ACK retry after simulated MV3 restart.
- Real bridge/extension integration test covers pair/status, command delivery and lost-ACK recovery.
- npm run build: pass.
- node --check passes for all extension JavaScript and the manifest parses.
- Extension scan finds no CoS bridge ports, ChatGPT references or content_scripts declaration.
- npm run dev: Electron starts both the secret local MCP endpoint and browser bridge on 127.0.0.1:8875, then remains running until stopped.
