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
- Search and text caching are generation-scoped so a document/query change cannot publish stale results; text cache is bounded.
- Corrupt/non-PDF, empty, changed-during-read and >128 MB inputs fail visibly before reader admission.

Intentionally omitted in this phase:

- Native-path APIs in renderer, project explorer/editing, annotation actions, ChatGPT automation, MCP publication, browser extension work, durable session state and document-engine APIs. Those belong to later roadmap phases.

Isolation:

- All file access remains inside PDF-AI main process. No CoS path/state/port/storage is read or written.

Validation:

- npm run typecheck: pass.
- npm test: pass, 3 files / 12 tests.
- Real generated two-page PDF parses, extracts expected text and renders through PDF.js + @napi-rs/canvas in tests.
- Navigation clamp, zoom/fit math, canvas pixel/dimension bounds, page-mapped selection and page-mapped search helpers are covered.
- Corrupt and oversized PDFs are rejected.
- npm run build: pass.
- npm run dev: Electron main/preload/renderer start successfully and remain running until stopped.
