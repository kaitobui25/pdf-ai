# PDF-AI Architecture

PDF-AI is a standalone Electron + TypeScript application. The Electron main process owns local files, document state, the local MCP endpoint, and the browser bridge. The renderer is sandboxed and receives only named APIs through the preload layer.

The product has four isolated parts:

1. Electron main owns native file selection, document indexing, stable document IDs, MCP, and the local bridge.
2. Renderer owns PDF presentation, continuous scrolling, selection UX, search presentation, and the local chat panel.
3. PDF AI MCP server exposes only document-ID-based PDF tools through its own connector.
4. PDF-AI Chrome MV3 extension owns its own browser storage and talks only to the PDF-AI bridge on ports 8875–8879.

The browser bridge and MCP endpoint are separate transports. The bridge is loopback-only and exists for the Chrome extension. MCP is independently published through the dedicated PDF AI connector/tunnel.

PDF-AI never reads or writes another application's runtime state. Its app/user-data identity, local storage, bridge identifier, bridge ports, extension identity, MCP identity, and tunnel configuration are all dedicated to this project.

## PDF reader boundary

The main process owns native file selection and reads one bounded file snapshot from an open file handle. It verifies the file is regular, unchanged during the read, contains a PDF header, and is at most 128 MB. The renderer receives the PDF bytes plus metadata and a stable content-derived document ID; it never receives the native file path.

The renderer uses PDF.js for continuous reading. Page canvases and text layers are rendered lazily around the viewport, in-flight renders are invalidated by generation on zoom/resize/navigation changes, and offscreen backing canvases/text DOM are released. Thumbnail canvases are also viewport-scoped. Current-page tracking only scans pages in the observer's near-viewport set rather than every page on every scroll frame. Search extracts text page-by-page with a bounded cache, and outline/thumbnails are loaded independently. The Phase-1 reader explicitly admits at most 5,000 pages and enforces CSS/raster/thumbnail dimensions before allocating canvases.

## MCP boundary

The PDF AI MCP server is a separate loopback-only HTTP listener on an OS-assigned local port. Each app start generates a fresh unguessable MCP path. The server publishes exactly seven PDF tools and every tool addresses content through documentId; no tool accepts an arbitrary filesystem path.

MCP handlers call the same authoritative PdfDocumentEngine used by the reader state. Tool schemas are strict Zod objects, request bodies are bounded, page/text/image outputs are bounded, and rendered image tools return page metadata plus a PNG content block.
