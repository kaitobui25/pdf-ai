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

## Phase 6

- npm run typecheck — PASS.
- npm test — PASS, 16 test files / 73 tests.
  - Final assistant state is monotonic across stale distinct-event replays PASS.
  - A completed input rejects a second assistant message identity PASS.
  - Conflicting turn/request evidence fails closed PASS.
  - One conversation cannot bind to two PDF sessions PASS.
  - Send authorization persists before the irreversible browser click PASS.
  - Input failure after authorization is rejected; ambiguous post-authorization delivery becomes `uncertain` and stays pending PASS.
  - Pre-authorization cancellation queues an exact owned cancel and clears only after its durable event PASS.
  - Restart/redelivery of an already authorized input resumes observation and produces no second `pdf-ai:send` PASS.
- npm run build — PASS.
- extension automation/background/content syntax — PASS.
- git diff --check — PASS.
- npm run dev — PASS: Electron opened the `PDF-AI` window; startup logged only MCP loopback port `56396` plus bridge `8875`; `/hello` returned the expected PDF-AI identity/protocol; Ctrl-C stopped the app cleanly.

## Phase 7

- npm run typecheck — PASS.
- npm test — PASS, 17 test files / 76 tests.
  - Exact-current-document page references navigate; cross-document/page-0/out-of-range refs are inert PASS.
  - A→B→A stale async chat result is rejected by generation even when the document ID returns to A PASS.
  - Uncertain delivery is projected as an error/busy state with no unsafe cancel PASS.
  - All earlier PDF/MCP/tunnel/bridge/automation/correlation suites remain PASS.
- npm run build — PASS.
- git diff --check — PASS.
- npm run dev — PASS: Electron opened the `PDF-AI` window; startup logged MCP loopback port `57586` plus bridge `8875`; `/hello` returned the expected PDF-AI identity/protocol. Automated native clicking was unavailable in this tool session and is not claimed.

## Phase 8

- `npm run typecheck` — PASS.
- `npm test` — PASS, 18 test files / 82 tests.
  - Structured JSONL logger redacts secret/content/path/MCP-private-route values and keeps current + one rotated log bounded PASS.
  - Corrupt primary chat state recovers the previous durable backup and quarantines the damaged file PASS.
  - Corrupt primary + backup, and syntactically valid but structurally corrupt state, surface explicit recovery/reset UX instead of crashing or silently trusting bad data PASS.
  - Image-only/scanned-style PDF returns empty page text without failure and remains renderable PASS.
  - Production `src` + `extension` scan contains no CoS bridge ports 8765–8769, `Chat On Steroids` runtime names or CoS state paths PASS.
  - Existing tests continue to cover two PDFs/two sessions, conversation ownership conflicts, duplicate/delayed assistant events, monotonic final responses, restart after send authorization with no second Send, extension service-worker ACK recovery, stale Chrome document rejection, bridge port collision, changed PDFs, oversized PDFs, tunnel network/offline/reconnect handling and typed page-reference navigation PASS.
- `npm run build` — PASS for main, preload and renderer.
- `node --check extension/bridge-client.js`, `automation.js`, `background.js`, `content.js` — PASS.
- `extension/manifest.json` parse / MV3 identity — PASS.
- `git diff --check` — PASS; only LF→CRLF working-tree notices were printed.
- `npm run dev` — PASS: Electron opened PDF-AI; startup output was `PDF AI MCP: listening on 127.0.0.1:59073` and `PDF-AI browser bridge: http://127.0.0.1:8875`; `GET /hello` returned `appId=pdf-ai`, `bridgeId=pdf-ai`, protocol 1.
- Coexistence smoke — PASS: the pre-existing Chat On Steroids `tunnel-client.exe` (PID 31592 during the run) remained alive and untouched after the PDF-AI process tree was stopped; PDF-AI bridge 8875 then became unreachable as expected.
- Actual local structured log smoke — PASS: `%APPDATA%\\PDF-AI\\pdf-ai.log.jsonl` was created with a bounded `app_ready` metadata record and contained no MCP secret path or `sk-...` credential-shaped value.

Manual boundary still applies: this tool session cannot click the native Open dialog or a real ChatGPT web page, so the automated suite proves the local reader/MCP/bridge/extension contracts and recovery logic; a human browser interaction remains the final physical UI check for a live ChatGPT account/connector.

## Post-Phase-8 live extension-connectivity regression

- Reproduced live: tunnel connected, chat input queued, bridge had no paired extension, Chrome profile had no loaded PDF-AI Bridge extension.
- Browser bridge paired/recent-activity status regression test — PASS.
- `npm run typecheck` — PASS.
- Focused `test/bridge.test.ts test/chat-ui.test.ts` — PASS, 14 tests.
- `npm run build` — PASS.
- `git diff --check` — PASS.

Live follow-up with **Attach current PDF** enabled:

- Existing queued input was claimed by the real extension and failed before Send with `pdf_upload_failed`; local durable state confirmed no conversation/user-message receipt was created, so no ambiguous resend boundary was crossed.
- Upload selection/receipt logic updated to exact composer + exactly one generic file input + exact newly owned attachment tile + settled upload proof.
- Content-script test now distinguishes the generic file input from an image-only file input and verifies native attachment filename extraction/state.
- Integration-test transport is fenced to the exact test bridge port so a running dev app on another PDF-AI port cannot be paired or mutated by tests.
- Full `npm test` after fixes — PASS, 18 files / 83 tests.
