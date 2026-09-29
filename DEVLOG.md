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
- The Electron main process starts the MCP endpoint with the shared PdfDocumentEngine. Phase 3 originally logged the full local endpoint for manual tunnel setup; Phase 4.1 removes that secret-path log because the app now hands the endpoint directly to its owned tunnel process.

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
- npm run dev: Electron starts the loopback PDF AI MCP endpoint and remains running until stopped. The full secret URL is no longer logged after Phase 4.1.

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
- npm run dev: Electron starts the local MCP endpoint and browser bridge on 127.0.0.1:8875, then remains running until stopped. Phase 4.1 later removes secret-path logging.

## Phase 4.1 — User-friendly tunnel setup and lifecycle

Inspected/reused the Phase-4.1 CoS patterns from:

- scripts/fetch-tunnel-client.mjs
- scripts/packaging-versions.mjs
- src/main/tunnel/index.ts
- src/main/tunnel/health.ts
- src/main/tunnel/locate.ts
- src/main/secrets.ts
- src/main/connection.ts
- src/main/ipc.ts
- src/preload/index.ts
- src/renderer/main.ts
- src/renderer/index.html
- test/tunnel-lifecycle.test.ts
- test/tunnel.test.ts
- test/tunnel-locate.test.ts
- focused secret/setup/connection tests

Patterns reused or simplified:

- Main process owns one supervised OpenAI tunnel child; renderer only sends setup drafts and reads a safe state projection.
- Pin the tested OpenAI tunnel-client release and verify SHA-256 before making a runtime executable available.
- Keep the control-plane API key and fresh secret MCP URL out of argv and send them only through environment-backed tunnel-client configuration.
- Treat `/readyz` as local readiness rather than proof of Internet/control-plane reachability; use control-plane poll metrics for the connected/offline distinction.
- Do not respawn a locally healthy tunnel merely because the network is temporarily down; let tunnel-client perform its own poll retry. Replace only an exited or persistently unready child.
- Fence each run by connection generation so output/exit/health from a retired child cannot change the current connection.
- Require a second failed local readiness pass before replacing the child, and wait for owned-process retirement before launching its replacement.
- Treat only genuine control-plane 401/403 evidence as terminal authentication failure; local MCP probe 401/403 text is not credential evidence.
- Store credentials with Electron/OS secure storage and never return them to the renderer.

PDF-AI-specific Phase-4.1 work:

- Added a dedicated connection card in the right pane with Tunnel ID, write-only restricted API key, Connect/Disconnect, connection state, runtime version and safe diagnostics.
- Normal users no longer install or start tunnel-client manually. Connect lazily prepares the runtime so an offline/missing runtime never blocks PDF reading or app startup.
- Pinned OpenAI tunnel-client v0.0.15 for Windows x64/arm64 using the CoS-vetted release SHA-256 values. Runtime archives are downloaded only from the pinned OpenAI GitHub release, checked before extraction, cached under PDF-AI userData and revalidated before reuse.
- Normal runtime resolution ignores PATH. `PDF_AI_TUNNEL_CLIENT_PATH` is an explicit development/recovery override and an invalid selection fails closed.
- Windows archive extraction calls `%SystemRoot%\\System32\\tar.exe` directly instead of resolving an extractor from PATH.
- Tunnel ID is stored in PDF-AI config. The restricted API key is encrypted with Electron safeStorage when available; otherwise a newly entered key is process-memory-only.
- The child environment is scrubbed case-insensitively for stale tunnel credential/MCP variables before inserting PDF-AI's current values.
- On every Connect, the manager uses the current app process's MCP URL, so the random port/secret-path change after restart requires no user profile edit.
- The main-process log now exposes only the MCP loopback port, not the secret MCP route.
- App quit now awaits tunnel, bridge, MCP and document-engine cleanup before allowing Electron to exit.

Intentionally omitted in this phase:

- Installer/NSIS/updater/signing/release artifacts and cross-platform distribution work.
- Cloudflare/manual tunnel providers, multiple connector profiles, Core/Desktop/Plugins surfaces, tunnel packaging into a shipped EXE, and release-current verification machinery.
- ChatGPT tab/DOM automation; that remains Phase 5 and still requires the mandatory user checkpoint.

Isolation:

- Runtime cache, tunnel config and encrypted credential file live only under PDF-AI userData names.
- PDF-AI never reads CoS tunnel IDs, credentials, runtime cache, binaries or userData.
- Browser bridge remains a separate loopback service on 8875–8879 and is never routed through the MCP tunnel.

Validation:

- npm run typecheck: pass.
- npm test: pass, 13 files / 61 tests.
- Tunnel runtime tests cover exact pin/checksums, reject-before-extract on bad checksum, verified-cache revalidation/tamper recovery and explicit-override fail-closed behavior.
- Tunnel health tests cover labelled metrics, main-channel status, control-plane-only auth classification and network classification.
- Tunnel lifecycle tests cover secret-free argv/status, scrubbed environment, exact current MCP URL, unexpected-exit reconnect, persistent-unready replacement with retirement barrier, stale-child rejection, terminal auth failure and Disconnect cancellation.
- npm run build: pass.
- npm run dev: PASS. Electron opened a `PDF-AI` window, logged only `PDF AI MCP: listening on 127.0.0.1:63480` plus `PDF-AI browser bridge: http://127.0.0.1:8875`, and `/hello` reported `appId=pdf-ai`, `bridgeId=pdf-ai`, protocol 1. No PDF-AI tunnel runtime was downloaded on startup; the already-running Chat On Steroids tunnel-client remained separate and untouched. Ctrl-C stopped the PDF-AI window and bridge cleanly.

## Phase 5 — PDF-AI-owned ChatGPT browser automation

Inspected the CoS browser/session ownership patterns in `extension/background.js`, `extension/content.js`, `extension/chatgpt-dom.js`, `extension/fiber.js`, and the session input/attachment/recorder/store modules. PDF-AI keeps only the smaller subset needed for one PDF reader: exact owned-chat targeting, fail-closed composer control, one PDF attachment, native send receipt, durable observations and restart-safe identities.

Implemented:

- Added durable per-document chat sessions and input IDs. The renderer supplies only `documentId`, prompt text and scope; browser/conversation ownership stays in main/extension state.
- Added a prompt ownership marker so a delivered input can be recognized idempotently after extension/service-worker recovery.
- Added protected bridge event ingestion, bounded PDF chunk delivery by `documentId`, and command long-poll wakeup.
- Added a Chrome MV3 ChatGPT content script plus service-worker automation. Fresh chats are created inactive by PDF-AI; later sends reuse only the exact bound conversation and never an unrelated active tab.
- Added top-frame `sender.documentId` plus document-load token fencing so a stale content script after reload cannot read PDF bytes or publish observations.
- Added exact native user-message receipt semantics: a click/composer-clear/Stop transition alone never proves send success.
- Added bounded durable extension event outbox and main-process event replay/correlation. Assistant replies may carry stable `pdf://<documentId>/page/<n>` references for later local navigation.
- Added registered-PDF chunk reads that recheck the backing file before/after each chunk and never reveal native paths.

Validation before Phase-5 smoke/commit:

- `npm run typecheck`: pass.
- `npm test`: pass, 16 files / 69 tests.
- `npm run build`: pass.
- extension `node --check`: pass for bridge client, automation, background and content scripts.
- extension manifest parse/required ChatGPT content-script permissions: pass.
- `git diff --check`: pass.
- `npm run dev`: pass. Electron opened the `PDF-AI` window, MCP logged only loopback port `63913`, browser bridge `/hello` identified `pdf-ai` protocol 1 on port 8875, and the unrelated Chat On Steroids tunnel-client process remained untouched. Ctrl-C stopped PDF-AI cleanly.

## Phase 6 — Durable ownership and response correlation

Reused the CoS first-proof-wins/monotonic-final invariants while omitting the larger Goal/Loop request-correlation machinery that PDF-AI does not need.

Implemented:

- Added durable local sequence/origin metadata for chat messages so canonical revisions are ordered by local state, not timestamps.
- Enforced one durable ChatGPT conversation owner across all PDF sessions; contradictory cross-PDF binding fails closed.
- Added turn/request correlation conflict checks and one canonical assistant identity per completed input.
- Made assistant finality monotonic: stale streaming events cannot regress a final message, even with a fresh transport event ID.
- Added a durable send-authorization boundary immediately before the native browser click. Restart/redelivery after authorization never dispatches Send again.
- Added `uncertain` delivery state for lost/ambiguous post-authorization receipts; the pending input remains owned and can later settle from exact recovered evidence.
- Recovery from an ownership marker republishes the native user-message receipt before assistant observation resumes.
- Added cancellation protocol; cancellation succeeds only before authorization and otherwise fails closed.
- Added durable bounded event metadata plus attachment identity/upload state to the local session record.

Validation before smoke/commit:

- `npm run typecheck`: pass.
- `npm test`: pass, 16 files / 73 tests.
- Phase-6 adversarial tests cover final→stale streaming, second assistant after completion, turn conflict, cross-PDF conversation claim, authorize→failure/uncertain, safe pre-authorize cancel, and restart/redelivery after authorization with no second Send.
- `npm run build`: pass.
- extension syntax checks: pass.
- `git diff --check`: pass.
- `npm run dev`: pass. Electron opened the `PDF-AI` window, MCP logged only loopback port `56396`, browser bridge `/hello` identified `pdf-ai` protocol 1 on port 8875, and Ctrl-C stopped the app cleanly.

## Phase 7 — Complete local AI Chat UI

Implemented:

- Replaced the Phase-4 placeholder right pane with a durable per-document chat timeline and composer while retaining the secure tunnel connection card.
- Added Ask selection, Ask current page, Ask document, custom Send, attach-current-PDF toggle, progress/error display, safe pre-authorization Cancel, and session/conversation indicator.
- Local user/assistant rows are rendered only from the main-process durable chat snapshot. Streaming assistant revisions replace the same logical row through sequence metadata.
- Added typed page-reference buttons. A page action is enabled only for the exact current `documentId` and an in-range page, then calls the existing local `PdfReader.goToPage()`.
- Added document-generation fencing for async session refresh so stale A→B→A results cannot overwrite the current PDF chat.
- Timeline auto-follows only when the user is already near the bottom; polling does not intentionally drag a user who scrolled upward.

Validation:

- `npm run typecheck`: pass.
- `npm test`: pass, 17 files / 76 tests.
- UI helper tests cover exact/cross-document/invalid page refs, A→B→A generation fencing, and uncertain-state no-cancel projection.
- `npm run build`: pass.
- `git diff --check`: pass.
- `npm run dev`: pass. Electron opened the `PDF-AI` window, MCP logged only loopback port `57586`, and bridge `/hello` identified `pdf-ai` protocol 1 on port 8875. This session has no desktop-input connector, so native visual clicking was not claimed as automated coverage.

## Phase 8 — Local hardening and recovery

Inspected the CoS hardening/correlation/UI recovery paths before implementing this phase: `src/main/session/correlation.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/shared/session.ts`, `src/shared/chronology.ts`, `src/renderer/chat.ts`, `src/renderer/timeline-scroll.ts`, `src/renderer/recovery.ts`, and `src/renderer/file-pdf-viewer.ts`, plus the corresponding correlation, response-identity, completion-order, recorder-final, kernel-recovery, renderer-timeline, timeline-scroll, renderer-recovery, renderer-html and session tests.

Patterns reused/simplified:

- Kept CoS's fail-closed recovery principle: corrupted durable state is never silently treated as authoritative. PDF-AI writes chat state through fsynced temp-file replacement, retains one prior durable backup, quarantines a damaged primary, and surfaces a local recovery notice when backup recovery or reset was required.
- Kept bounded local retention for sessions, messages, inputs, event identities and structured logs. PDF-AI does not add CoS's larger compaction/history subsystems.
- Added a small JSONL local logger with one rotated backup. Content-bearing/secret-shaped fields are always redacted, local paths and the private MCP URL are scrubbed, and log records contain only bounded operational metadata.
- Kept Phase-6 correlation invariants unchanged: final assistant content is monotonic, ownership never rebinds on contradiction, and an authorized browser send is never automatically resent after restart or uncertainty.
- Added direct graceful behavior coverage for image-only/scanned-style PDFs: text extraction may be empty while rendering and the rest of the reader remain functional.
- Added production-source isolation scanning for forbidden CoS bridge ports/runtime names and for the independent PDF-AI extension storage namespaces.

Intentionally omitted:

- No installer, updater, signing, NSIS, packaging, release artifacts or CI release work.
- No CoS Goal/Loop/workers/plugins/recovery orchestration. PDF-AI recovery is limited to its own PDF sessions, bridge/extension ownership, MCP tunnel and local UI state.
- No automatic resend after an ambiguous authorized browser send; the durable `uncertain` state remains the safe recovery UX.

Isolation:

- All new files remain under PDF-AI userData (`pdf-ai.chat-state.json`, its backup/quarantine files, and `pdf-ai.log.jsonl`).
- The production-source scan rejects CoS ports 8765–8769, `Chat On Steroids` runtime names and CoS state paths from `src` and `extension`.
- Final smoke ran while the existing Chat On Steroids tunnel-client was active; after stopping only the PDF-AI process tree, the CoS tunnel-client remained running.

Validation:

- `npm run typecheck`: pass.
- `npm test`: pass, 18 files / 82 tests.
- Phase-8 additions cover redacted/bounded logs, valid-backup recovery, unrecoverable/corrupt-shape recovery notice + quarantine, scanned/image-only PDF behavior and production isolation scanning.
- All earlier reader/MCP/tunnel/bridge/automation/correlation/UI tests remain green, including port collision, network/reconnect state, duplicate/delayed events, extension/service-worker restart and no-resend-after-authorization cases.
- `npm run build`: pass.
- Extension `node --check` and manifest parse: pass.
- `git diff --check`: pass (Git only reports existing LF→CRLF working-tree notices).
- `npm run dev`: pass. Electron opened PDF-AI, MCP logged only loopback port `59073`, bridge `/hello` returned `appId=pdf-ai`, `bridgeId=pdf-ai`, protocol 1 on port 8875, and the actual structured local log contained only `app_ready` with MCP/bridge port metadata. The already-running Chat On Steroids tunnel-client PID 31592 remained alive after the PDF-AI process tree was stopped.
