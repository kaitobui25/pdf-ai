# PDF-AI Local Test Report

This file records exact commands and results after each completed phase.

## Phase 0

- npm install — PASS, 0 vulnerabilities. Electron's binary was initially absent; requiring the installed package completed its official binary download.
- npm run typecheck — PASS.
- npm test — PASS, 1 test file / 2 tests.
- npm run build — PASS for main, preload, and renderer.
- npm run dev — PASS: renderer dev server started on localhost and Electron reached "starting electron app"; the process remained running until manually stopped.

## Phase 1

- npm run typecheck — PASS after reader, search-generation and render-generation changes.
- npm test — PASS, 4 test files / 21 tests.
  - Real generated two-page PDF: stable document ID, text extraction and page render PASS.
  - Invalid PDF rejection PASS.
  - Sparse file above the 128 MB admission limit rejected before content allocation PASS.
  - Navigation clamp, zoom/fit, canvas memory/dimension bounds, selection-to-page mapping and search-to-page mapping PASS.
  - Direct PdfReader lifecycle tests: navigation, zoom/fit state, DOM text selection ownership, stale-search cancellation after document replacement, offscreen page cleanup, thumbnail release and 5,000-page admission limit PASS.
  - Pathological 1,000,000 × 10 page raster math and 1 × 1,000,000 thumbnail aspect-ratio bounds PASS.
  - Overlapping PDF opens settling out of order preserve the newer document/loading task PASS.
- npm run build — PASS for main, preload, renderer and bundled PDF.js worker.
- npm run dev — PASS: Electron app started with the Phase-1 renderer and stayed alive until manually stopped.

Visual interaction with the native Open dialog was not automated because the connected workspace exposes terminal/file tools but no desktop/window input connector in this session. The PDF parsing/rendering path is exercised directly in the test suite.

## Phase 2

- npm run typecheck — PASS.
- npm test — PASS, 5 test files / 28 tests.
  - Exact page text and stable page references PASS.
  - Multi-page search and multiple-document isolation PASS.
  - Stale view-epoch updates are rejected, including reopen A→B→A PASS.
  - Selection text/page/bounds mapping and invalid normalized bounds rejection PASS.
  - Full-page PNG and normalized region crop correctness PASS.
  - Identical-content source deduplication and active-source replacement detection PASS.
  - Replaced content invalidates stale reads and reopens under a new stable document ID PASS.
- npm run build — PASS for main, preload, renderer and PDF.js worker.
- npm run dev — PASS: Electron reached "starting electron app" and remained running until stopped.

## Phase 3

- npm run typecheck — PASS.
- npm test — PASS, 6 test files / 33 tests.
  - Real MCP client connects over the local HTTP endpoint and tools/list returns exactly seven PDF tools PASS.
  - Tool schemas expose no path/filePath input PASS.
  - list/current/selection/search/read/render-page/render-region calls PASS.
  - Invalid document IDs and out-of-range pages return tool errors PASS.
  - Query length and 50-page read bounds are enforced PASS.
  - Concurrent calls across two PDFs remain isolated PASS.
- npm run build — PASS.
- npm run dev — PASS: Electron started the secret loopback PDF AI MCP endpoint. Phase 4.1 later removed the secret path from logging.

## Phase 4

- npm run typecheck — PASS.
- npm test — PASS, 9 test files / 45 tests, serialized because multiple bridge suites intentionally use the fixed production port range 8875–8879.
  - /hello identity and dedicated port range PASS.
  - Wrong Chrome-extension origin, app ID and protocol rejected PASS.
  - Missing Origin on extension pairing is accepted for Chrome host-permission compatibility while extension identity remains bound PASS.
  - Missing/wrong/stale bearer token and wrong extension ID rejected PASS.
  - Port collision advances within 8875–8879 PASS.
  - Pairing and pending commands survive bridge restart PASS.
  - Command remains at-least-once until durable ACK; duplicate ACK returns the same receipt PASS.
  - Simulated durable-save failure does not publish an uncommitted command or ACK PASS.
  - Request body and rolling rate limits PASS.
  - Extension scans only 8875–8879 and uses the exact pair/protected route contract PASS.
  - Extension ACK is stored before transport and retried after simulated service-worker restart PASS.
  - Real app-bridge + extension-client test recovers a lost ACK response after server commit PASS.
- npm run build — PASS.
- node --check extension/bridge-client.js, extension/background.js and extension/popup.js — PASS.
- extension/manifest.json parse — PASS; content_scripts absent.
- Extension forbidden-reference scan — PASS; no 8765–8769 or ChatGPT references.
- npm run dev — PASS: Electron started both local services. Phase 4.1 later changed the MCP log to expose only its loopback port.

## Phase 4.1

- npm run typecheck — PASS.
- npm test — PASS, 13 test files / 61 tests.
  - Pinned tunnel-client v0.0.15 Windows x64/arm64 metadata and CoS-vetted SHA-256 values PASS.
  - Checksum mismatch is rejected before extraction/runtime publication PASS.
  - Verified runtime cache is revalidated; executable tampering forces a fresh verified prepare PASS.
  - Explicit invalid runtime override fails closed without PATH fallback PASS.
  - Tunnel health metrics/status parsing PASS.
  - Local MCP 401/403 text is not misclassified as an OpenAI credential failure; genuine control-plane 401/403 is terminal PASS.
  - API key and private MCP URL are absent from argv and renderer-safe status; exact current values exist only in the scrubbed child environment PASS.
  - Case-insensitive inherited CONTROL_PLANE_API_KEY/MCP_SERVER_URL/MCP_DISCOVERY_EXTRA_HEADERS values are removed before spawn PASS.
  - Unexpected child exit reconnects with bounded backoff and stale retired-child output cannot overwrite current state PASS.
  - Persistent local unready requires two failed passes and replacement waits for the old child retirement barrier PASS.
  - Auth rejection stops reconnect; Disconnect cancels later respawn PASS.
  - A new app lifecycle automatically supplies its new random MCP URL without user tunnel-profile edits PASS.
  - Dedicated PDF-AI tunnel runtime namespace isolation PASS.
- npm run build — PASS for main, preload and renderer.
- Secret regression scan — PASS: application source contains no console statement that logs the full MCP URL; tunnel key/MCP URL identifiers occur only at the intended main-process environment boundary.
- git diff --check — PASS (line-ending notices only).
- npm run dev — PASS: Electron opened a `PDF-AI` window. Startup output was `PDF AI MCP: listening on 127.0.0.1:63480` and `PDF-AI browser bridge: http://127.0.0.1:8875`; no MCP secret path was printed. `GET /hello` returned `appId=pdf-ai`, `bridgeId=pdf-ai`, protocol 1. The PDF-AI tunnel runtime directory did not exist after startup, proving startup did not prepare/download the runtime. An already-running Chat On Steroids tunnel-client at `C:\\Program Files\\Chat On Steroids\\resources\\tunnel\\tunnel-client.exe` remained running and untouched. Ctrl-C stopped the PDF-AI window and bridge cleanly.

## Phase 5

- npm run typecheck — PASS.
- npm test — PASS, 16 test files / 69 tests.
  - Durable chat session/input framing and exact conversation correlation PASS.
  - Multiple PDF sessions remain isolated and pending inputs survive manager reconstruction PASS.
  - Registered PDF byte chunks reconstruct the exact file, expose no path and reject changed backing files PASS.
  - Protected bridge `/events` and document chunk routes plus command long-poll PASS.
  - Browser automation ignores an unrelated active ChatGPT tab, creates an inactive owned chat, and reuses only its bound conversation PASS.
  - Same-tab stale Chrome `sender.documentId` after reload cannot fetch PDF chunks PASS.
  - Content DOM test reads ownership markers only from native user messages and recognizes exact ChatGPT conversation/composer/send controls PASS.
- npm run build — PASS for main, preload and renderer.
- node --check for extension bridge-client/automation/background/content — PASS.
- extension manifest parse and Phase-5 content-script permissions — PASS.
- git diff --check — PASS (line-ending notices only).
- npm run dev — PASS: Electron opened the `PDF-AI` window; startup logged `PDF AI MCP: listening on 127.0.0.1:63913` and `PDF-AI browser bridge: http://127.0.0.1:8875`; bridge `/hello` returned the expected PDF-AI identity/protocol; the pre-existing Chat On Steroids tunnel-client remained untouched; Ctrl-C stopped PDF-AI cleanly.
