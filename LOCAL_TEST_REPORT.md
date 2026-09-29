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
