# PDF-AI

Local-first Electron PDF reader with a dedicated PDF AI MCP surface and isolated browser bridge.

Development command: npm install, then npm run dev.

Validation commands: npm run typecheck and npm test.

For Phase 4 local browser connectivity, load the extension directory as an unpacked Chrome extension. Its popup reports the PDF-AI bridge status and can request a reconnect. The extension does not automate ChatGPT yet.

The current roadmap deliberately stops after the Phase 4 browser bridge/extension foundation until the dedicated PDF-AI tunnel and PDF AI connector are configured.
