# PDF-AI Architecture

PDF-AI is a standalone Electron + TypeScript application. The Electron main process owns local files, document state, the local MCP endpoint, and the browser bridge. The renderer is sandboxed and receives only named APIs through the preload layer.

The product has four isolated parts:

1. Electron main owns native file selection, document indexing, stable document IDs, MCP, and the local bridge.
2. Renderer owns PDF presentation, continuous scrolling, selection UX, search presentation, and the local chat panel.
3. PDF AI MCP server exposes only document-ID-based PDF tools through its own connector.
4. PDF-AI Chrome MV3 extension owns its own browser storage and talks only to the PDF-AI bridge on ports 8875–8879.

The browser bridge and MCP endpoint are separate transports. The bridge is loopback-only and exists for the Chrome extension. MCP is independently published through the dedicated PDF AI connector/tunnel.

PDF-AI never reads or writes another application's runtime state. Its app/user-data identity, local storage, bridge identifier, bridge ports, extension identity, MCP identity, and tunnel configuration are all dedicated to this project.

