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
